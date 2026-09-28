"""The conversation runner: the seam between the ACAF bridge and Pipecat.

Before this module existed, `AcafBridge` accepted the handshake, counted the
inbound audio frames, and then dropped them (`_forward_to_pipeline` only
forwarded to a queue nothing ever created). `build_pipeline()` was never
called, `ASSISTANT_GREETING` was read but never spoken, and nothing ever wrote
to `send_audio()`. The service was a healthy-looking transport with no
assistant behind it, which is exactly the symptom of "the call connects and
the AI never speaks".

`CallConversation` closes that gap. One instance per bridged call:

    caller audio -> bridge -> push_audio() -> PipelineTask
                                               -> STT -> LLM -> TTS
                                               -> BridgeOutput -> PacedAudioSender
    bridge.send_audio() -> ACAF AUDIO_OUT -> relay -> WhatsApp call

Two behaviours matter for a live call and are handled here on purpose:

  * **Pacing.** TTS providers stream audio faster than real time. The bridge's
    outbound queue is bounded and drops the oldest frames when full, so an
    unpaced burst would silently truncate the start of every sentence. The
    `PacedAudioSender` releases 20 ms frames at wall-clock speed instead.

  * **Greeting on answer.** The relay only lets assistant audio into the call
    once the callee has answered, and drops anything earlier. Speaking the
    greeting at handshake time (while the phone is still ringing) would
    therefore be lost. The greeting is held until `note_call_active()`.
"""

from __future__ import annotations

import asyncio
import collections
import contextlib
import time
from typing import Any, Awaitable, Callable

from loguru import logger

from app.config import Settings

#: Spoken when the callee answers, unless ASSISTANT_GREETING overrides it.
DEFAULT_GREETING = "Hi, this is Emysa, an AI assistant. Can you hear me okay?"

#: Outbound audio is released in frames of this many milliseconds.
FRAME_MS = 20

#: How far ahead of real time frames may be released. Keeps the relay's
#: jitter buffer fed without letting a whole sentence burst out at once.
SEND_LEAD_SECS = 0.06

#: Log inbound audio stats this often (seconds) rather than per frame.
INBOUND_LOG_INTERVAL_SECS = 5.0


def clog(level: str, session_id: str, event: str, **fields: Any) -> None:
    """Log one call-lifecycle line with the session id and fields in the text.

    Fields are rendered into the message on purpose. The service's structured
    `extra=` fields are attached to loguru records but the configured JSON
    handler only receives stdlib records, so fields passed that way never
    reach the Render log. Never pass secrets, tokens or transcript text here;
    only ids, counts, sizes and rates.
    """
    parts = " ".join(f"{key}={value}" for key, value in fields.items())
    message = f"[call {session_id}] {event}" + (f" {parts}" if parts else "")
    logger.log(level, message)


class PacedAudioSender:
    """Releases outbound PCM to the bridge at real-time speed.

    Owns the outbound side of one call: chunking, serialization, pacing,
    barge-in flushing and the "bot is speaking" edge signals Pipecat's turn
    logic expects. Carrier-agnostic and free of Pipecat imports so the mock
    conversation can share it.
    """

    def __init__(
        self,
        *,
        session_id: str,
        serializer: Any,
        send_audio: Callable[[bytes], Awaitable[None]],
        send_control: Callable[[str], Awaitable[None]],
        on_speaking: Callable[[bool], Awaitable[None]] | None = None,
        frame_ms: int = FRAME_MS,
        lead_secs: float = SEND_LEAD_SECS,
    ) -> None:
        self._session_id = session_id
        self._serializer = serializer
        self._send_audio = send_audio
        self._send_control = send_control
        self._on_speaking = on_speaking
        self._frame_ms = frame_ms
        self._lead = lead_secs

        self._queue: asyncio.Queue[tuple[bytes, int, int] | None] = asyncio.Queue()
        self._task: asyncio.Task[None] | None = None
        self._speaking = False
        self._stopped = False

        self.frames_enqueued = 0
        self.frames_sent = 0
        self.frames_flushed = 0
        self.send_errors = 0
        self.first_audio_logged = False

    def start(self) -> None:
        if self._task is None:
            self._task = asyncio.create_task(self._run(), name="paced-audio-sender")

    async def enqueue(self, pcm: bytes, sample_rate: int, channels: int = 1) -> None:
        """Split `pcm` into fixed-size frames and queue them for release."""
        if self._stopped or not pcm:
            return
        bytes_per_frame = int(sample_rate * self._frame_ms / 1000) * 2 * channels
        if bytes_per_frame <= 0:
            return
        for offset in range(0, len(pcm), bytes_per_frame):
            chunk = pcm[offset : offset + bytes_per_frame]
            if len(chunk) % (2 * channels):  # never split a sample
                chunk = chunk[: len(chunk) - (len(chunk) % (2 * channels))]
            if chunk:
                self._queue.put_nowait((chunk, sample_rate, channels))
                self.frames_enqueued += 1
        if not self.first_audio_logged:
            self.first_audio_logged = True
            clog(
                "INFO",
                self._session_id,
                "tts audio reached the outbound sender",
                sampleRate=sample_rate,
                channels=channels,
                bytes=len(pcm),
            )

    async def interrupt(self) -> int:
        """Drop everything not yet released (barge-in). Returns frames dropped."""
        dropped = 0
        while True:
            try:
                item = self._queue.get_nowait()
            except asyncio.QueueEmpty:
                break
            if item is not None:
                dropped += 1
        self.frames_flushed += dropped
        return dropped

    async def stop(self) -> None:
        self._stopped = True
        task, self._task = self._task, None
        if task is not None:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await task
        await self.interrupt()

    async def _set_speaking(self, speaking: bool) -> None:
        if self._speaking == speaking:
            return
        self._speaking = speaking
        if self._on_speaking is not None:
            with contextlib.suppress(Exception):
                await self._on_speaking(speaking)

    async def _run(self) -> None:
        # `deadline` is when the *next* frame is due at real-time speed.
        deadline: float | None = None
        try:
            while True:
                try:
                    item = await asyncio.wait_for(self._queue.get(), timeout=0.3)
                except asyncio.TimeoutError:
                    # Nothing queued: once the last frame has had time to play
                    # out, the bot has stopped speaking.
                    if self._speaking and (
                        deadline is None or time.monotonic() >= deadline
                    ):
                        await self._set_speaking(False)
                        deadline = None
                    continue
                if item is None:
                    return
                chunk, sample_rate, channels = item

                now = time.monotonic()
                if deadline is None or deadline < now - 0.1:
                    # Start of an utterance, or an underrun: restart the clock.
                    deadline = now
                await self._set_speaking(True)

                wait = deadline - self._lead - now
                if wait > 0:
                    await asyncio.sleep(wait)

                try:
                    wire = await self._serialize(chunk, sample_rate, channels)
                    if wire:
                        await self._send_audio(wire)
                        self.frames_sent += 1
                        if self.frames_sent == 1:
                            clog(
                                "INFO",
                                self._session_id,
                                "first outgoing audio frame sent to bridge",
                                bytes=len(wire),
                            )
                        elif self.frames_sent % 250 == 0:
                            clog(
                                "INFO",
                                self._session_id,
                                "outgoing audio progress",
                                framesSent=self.frames_sent,
                                framesFlushed=self.frames_flushed,
                            )
                except asyncio.CancelledError:
                    raise
                except Exception as exc:  # noqa: BLE001 - one bad frame != dead call
                    self.send_errors += 1
                    if self.send_errors <= 5:
                        clog(
                            "ERROR",
                            self._session_id,
                            "outgoing audio send failed",
                            error=type(exc).__name__,
                            detail=str(exc)[:160],
                        )

                deadline += len(chunk) / (2 * channels * sample_rate)
        except asyncio.CancelledError:
            raise

    async def _serialize(self, pcm: bytes, sample_rate: int, channels: int) -> bytes | None:
        from pipecat.frames.frames import OutputAudioRawFrame

        frame = OutputAudioRawFrame(audio=pcm, sample_rate=sample_rate, num_channels=channels)
        wire = await self._serializer.serialize(frame)
        return wire if isinstance(wire, (bytes, bytearray)) else None

    def stats(self) -> dict[str, int]:
        return {
            "framesEnqueued": self.frames_enqueued,
            "framesSent": self.frames_sent,
            "framesFlushed": self.frames_flushed,
            "sendErrors": self.send_errors,
        }


class _InboundMeter:
    """Counts inbound audio so the log can show that caller audio arrives."""

    def __init__(self, session_id: str) -> None:
        self._session_id = session_id
        self.frames = 0
        self.bytes = 0
        self._window_frames = 0
        self._last_log = time.monotonic()
        self._first = True

    def note(self, *, sample_rate: int, channels: int, byte_count: int) -> None:
        self.frames += 1
        self.bytes += byte_count
        self._window_frames += 1
        now = time.monotonic()
        if self._first:
            self._first = False
            clog(
                "INFO",
                self._session_id,
                "first incoming audio frame received",
                sampleRate=sample_rate,
                channels=channels,
                encoding="pcm_s16le",
                frameBytes=byte_count,
            )
            self._last_log = now
        elif now - self._last_log >= INBOUND_LOG_INTERVAL_SECS:
            clog(
                "INFO",
                self._session_id,
                "incoming audio progress",
                totalFrames=self.frames,
                framesLastWindow=self._window_frames,
                totalBytes=self.bytes,
            )
            self._window_frames = 0
            self._last_log = now


class _BaseConversation:
    """State shared by the real and mock conversations."""

    def __init__(self, *, settings: Settings, session_id: str) -> None:
        self._settings = settings
        self._session_id = session_id
        self._greeted = False
        self.call_active_source: str | None = None
        self._meter = _InboundMeter(session_id)

    @property
    def greeting_text(self) -> str:
        return (self._settings.greeting or DEFAULT_GREETING).strip() or DEFAULT_GREETING

    @property
    def call_active(self) -> bool:
        return self.call_active_source is not None

    async def note_call_active(self, source: str) -> bool:
        """The callee has answered. Speak the greeting exactly once.

        `source` records how we learned of it ("relay-signal", or
        "first-inbound-audio" for relays that predate the explicit signal) so
        the log shows which path fired. Returns True only for the call that
        actually triggered the greeting.
        """
        if self.call_active_source is not None:
            return False
        self.call_active_source = source
        clog("INFO", self._session_id, "call connected, sending greeting", source=source)
        await self._speak_greeting()
        self._greeted = True
        return True

    async def _speak_greeting(self) -> None:  # pragma: no cover - abstract
        raise NotImplementedError

    def stats(self) -> dict[str, Any]:  # pragma: no cover - abstract
        raise NotImplementedError


# --------------------------------------------------------------------------
# Pipecat processors
# --------------------------------------------------------------------------

from pipecat.frames.frames import (  # noqa: E402 - grouped with their use
    BotStartedSpeakingFrame,
    BotStoppedSpeakingFrame,
    CancelFrame,
    EndFrame,
    ErrorFrame,
    InputAudioRawFrame,
    InterruptionFrame,
    LLMFullResponseEndFrame,
    LLMFullResponseStartFrame,
    LLMTextFrame,
    OutputAudioRawFrame,
    StartFrame,
    TranscriptionFrame,
    TTSAudioRawFrame,
    TTSSpeakFrame,
    TTSStartedFrame,
    TTSStoppedFrame,
    VADUserStartedSpeakingFrame,
    VADUserStoppedSpeakingFrame,
)
from pipecat.observers.base_observer import BaseObserver, FramePushed  # noqa: E402
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor  # noqa: E402


class BridgeInput(FrameProcessor):
    """Head of the pipeline. Frames are injected with `PipelineTask.queue_frame`."""

    def __init__(self) -> None:
        super().__init__(name="BridgeInput")

    async def process_frame(self, frame: Any, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)
        await self.push_frame(frame, direction)


class BridgeOutput(FrameProcessor):
    """Tail of the pipeline: hands TTS audio to the paced sender.

    Stands in for a Pipecat output transport. Audio is *consumed* here (not
    pushed on); everything else, including interruptions, continues so the
    assistant aggregator still sees the turn end.
    """

    def __init__(
        self,
        *,
        sender: PacedAudioSender,
        serializer: Any,
        send_control: Callable[[str], Awaitable[None]],
        session_id: str,
    ) -> None:
        super().__init__(name="BridgeOutput")
        self._sender = sender
        self._serializer = serializer
        self._send_control = send_control
        self._session_id = session_id

    async def process_frame(self, frame: Any, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)

        if isinstance(frame, StartFrame):
            self._sender.start()
        elif isinstance(frame, InterruptionFrame):
            dropped = await self._sender.interrupt()
            wire = await self._serializer.serialize(frame)
            if isinstance(wire, str):
                with contextlib.suppress(Exception):
                    await self._send_control(wire)
            clog("INFO", self._session_id, "barge-in: flushed queued speech", framesDropped=dropped)
        elif isinstance(frame, OutputAudioRawFrame) and direction is FrameDirection.DOWNSTREAM:
            await self._sender.enqueue(frame.audio, frame.sample_rate, frame.num_channels)
            return

        await self.push_frame(frame, direction)

    async def on_speaking(self, speaking: bool) -> None:
        """Called by the sender when playout starts/stops (real time)."""
        frame_cls = BotStartedSpeakingFrame if speaking else BotStoppedSpeakingFrame
        await self.broadcast_frame(frame_cls)

    async def cleanup(self) -> None:
        await super().cleanup()
        await self._sender.stop()


class CallLogObserver(BaseObserver):
    """Logs one line per pipeline stage transition, never content.

    Counts and sizes only: transcript text and model replies are private
    call content and are deliberately not written to the log.
    """

    def __init__(self, session_id: str, secrets: tuple[str, ...] = ()) -> None:
        super().__init__()
        self._session_id = session_id
        self._secrets = tuple(s for s in secrets if s)
        self._seen: collections.deque[int] = collections.deque(maxlen=512)
        self._seen_set: set[int] = set()
        self._llm_chars = 0
        self._tts_bytes = 0
        self._tts_frames = 0

    def _first_sight(self, frame: Any) -> bool:
        frame_id = getattr(frame, "id", None)
        if frame_id is None:
            return True
        if frame_id in self._seen_set:
            return False
        if len(self._seen) == self._seen.maxlen:
            self._seen_set.discard(self._seen[0])
        self._seen.append(frame_id)
        self._seen_set.add(frame_id)
        return True

    def _scrub(self, text: str) -> str:
        for secret in self._secrets:
            text = text.replace(secret, "[redacted]")
        return text[:200]

    async def on_push_frame(self, data: FramePushed) -> None:
        frame = data.frame
        sid = self._session_id

        if isinstance(frame, ErrorFrame):
            if self._first_sight(frame):
                clog(
                    "ERROR",
                    sid,
                    "pipeline error",
                    fatal=bool(getattr(frame, "fatal", False)),
                    processor=type(getattr(frame, "processor", None)).__name__,
                    detail=self._scrub(str(getattr(frame, "error", ""))),
                )
            return

        if isinstance(frame, VADUserStartedSpeakingFrame):
            if self._first_sight(frame):
                clog("INFO", sid, "caller speech started")
        elif isinstance(frame, VADUserStoppedSpeakingFrame):
            if self._first_sight(frame):
                clog("INFO", sid, "caller speech ended, stt started")
        elif isinstance(frame, TranscriptionFrame):
            if self._first_sight(frame):
                clog(
                    "INFO",
                    sid,
                    "stt transcript received",
                    chars=len(getattr(frame, "text", "") or ""),
                )
        elif isinstance(frame, LLMFullResponseStartFrame):
            if self._first_sight(frame):
                self._llm_chars = 0
                clog("INFO", sid, "llm started")
        elif isinstance(frame, LLMTextFrame):
            if self._first_sight(frame):
                self._llm_chars += len(getattr(frame, "text", "") or "")
        elif isinstance(frame, LLMFullResponseEndFrame):
            if self._first_sight(frame):
                clog("INFO", sid, "llm response received", chars=self._llm_chars)
        elif isinstance(frame, TTSStartedFrame):
            if self._first_sight(frame):
                self._tts_bytes = 0
                self._tts_frames = 0
                clog("INFO", sid, "tts started")
        elif isinstance(frame, TTSAudioRawFrame):
            if self._first_sight(frame):
                self._tts_bytes += len(frame.audio)
                self._tts_frames += 1
        elif isinstance(frame, TTSStoppedFrame):
            if self._first_sight(frame):
                clog(
                    "INFO",
                    sid,
                    "tts audio generated",
                    chunks=self._tts_frames,
                    bytes=self._tts_bytes,
                )
                self._tts_bytes = 0
                self._tts_frames = 0
        elif isinstance(frame, (EndFrame, CancelFrame)):
            if self._first_sight(frame):
                clog("INFO", sid, "pipeline received end-of-call frame", frame=type(frame).__name__)


class _TransportShim:
    """Gives `build_pipeline` the `input()`/`output()` pair it expects."""

    def __init__(self, inp: FrameProcessor, out: FrameProcessor) -> None:
        self._inp = inp
        self._out = out

    def input(self) -> FrameProcessor:
        return self._inp

    def output(self) -> FrameProcessor:
        return self._out


# --------------------------------------------------------------------------
# Conversations
# --------------------------------------------------------------------------


class CallConversation(_BaseConversation):
    """Runs the real Pipecat pipeline for one bridged call."""

    def __init__(
        self,
        *,
        settings: Settings,
        session_id: str,
        serializer: Any,
        send_audio: Callable[[bytes], Awaitable[None]],
        send_control: Callable[[str], Awaitable[None]],
        on_ended: Callable[[str], Awaitable[None]] | None = None,
        services: tuple[Any, Any, Any, Any] | None = None,
    ) -> None:
        super().__init__(settings=settings, session_id=session_id)
        self._serializer = serializer
        self._send_audio = send_audio
        self._send_control = send_control
        self._on_ended = on_ended
        self._services = services

        self._task: Any = None
        self._runner: Any = None
        self._context: Any = None
        self._run_task: asyncio.Task[None] | None = None
        self._output: BridgeOutput | None = None
        self.sender: PacedAudioSender | None = None
        self._stopped = False

    async def start(self) -> None:
        from pipecat.pipeline.runner import PipelineRunner
        from pipecat.pipeline.task import PipelineParams, PipelineTask

        from app.pipeline import build_llm_context, build_pipeline

        rate = self._settings.bridge_sample_rate
        # The output processor is created first only so the sender can call
        # back into it for bot-speaking edges; the sender is what paces.
        holder: dict[str, BridgeOutput] = {}

        async def _speaking(state: bool) -> None:
            out = holder.get("out")
            if out is not None:
                await out.on_speaking(state)

        self.sender = PacedAudioSender(
            session_id=self._session_id,
            serializer=self._serializer,
            send_audio=self._send_audio,
            send_control=self._send_control,
            on_speaking=_speaking,
        )
        self._output = BridgeOutput(
            sender=self.sender,
            serializer=self._serializer,
            send_control=self._send_control,
            session_id=self._session_id,
        )
        holder["out"] = self._output

        self._context = build_llm_context()
        pipeline, _llm = build_pipeline(
            settings=self._settings,
            transport=_TransportShim(BridgeInput(), self._output),
            context=self._context,
            services=self._services,
        )
        self._task = PipelineTask(
            pipeline,
            params=PipelineParams(audio_in_sample_rate=rate, audio_out_sample_rate=rate),
            observers=[CallLogObserver(self._session_id, self._settings.secret_values())],
            enable_rtvi=False,
            # The bridge owns idle/heartbeat/duration limits; a second, silent
            # idle timer inside Pipecat would end calls the bridge considers live.
            idle_timeout_secs=None,
        )
        self._runner = PipelineRunner(handle_sigint=False)
        self._run_task = asyncio.create_task(self._run(), name=f"pipeline-{self._session_id}")
        clog("INFO", self._session_id, "pipeline started", bridgeSampleRate=rate)

    async def _run(self) -> None:
        reason = "pipeline-finished"
        try:
            await self._runner.run(self._task)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 - reported, then the call ends
            reason = "pipeline-error"
            clog(
                "ERROR",
                self._session_id,
                "pipeline crashed",
                error=type(exc).__name__,
                detail=str(exc)[:200],
            )
        finally:
            clog("INFO", self._session_id, "pipeline ended", reason=reason)
            if not self._stopped and self._on_ended is not None:
                with contextlib.suppress(Exception):
                    await self._on_ended(reason)

    async def push_audio(self, frame: Any) -> None:
        if self._stopped or self._task is None:
            return
        if isinstance(frame, InputAudioRawFrame):
            self._meter.note(
                sample_rate=frame.sample_rate,
                channels=frame.num_channels,
                byte_count=len(frame.audio),
            )
            if not self.call_active:
                # Relays that predate the explicit call_active signal: caller
                # audio only flows once the callee has picked up.
                await self.note_call_active("first-inbound-audio")
        await self._task.queue_frame(frame)

    async def _speak_greeting(self) -> None:
        if self._task is None:
            return
        text = self.greeting_text
        # Recorded in the LLM context directly rather than left to the
        # assistant aggregator: that only commits spoken text on a later
        # bot-stopped-speaking edge, and the caller's first reply can reach the
        # LLM before it. Without this the model re-introduces itself.
        if self._context is not None:
            with contextlib.suppress(Exception):
                self._context.add_message({"role": "assistant", "content": text})
        # Queued at the head of the pipeline; STT/LLM pass unknown frames
        # through and the TTS stage speaks it.
        await self._task.queue_frame(TTSSpeakFrame(text, append_to_context=False))

    async def stop(self, reason: str = "stopped") -> None:
        if self._stopped:
            return
        self._stopped = True
        clog("INFO", self._session_id, "conversation stopping", reason=reason, **self.stats())
        if self._task is not None:
            with contextlib.suppress(Exception):
                await asyncio.wait_for(self._task.cancel(), timeout=5.0)
        run_task, self._run_task = self._run_task, None
        if run_task is not None:
            try:
                await asyncio.wait_for(run_task, timeout=5.0)
            except (asyncio.TimeoutError, asyncio.CancelledError, Exception):  # noqa: BLE001
                run_task.cancel()
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await run_task
        if self.sender is not None:
            await self.sender.stop()
        clog("INFO", self._session_id, "conversation cleanup completed")

    def stats(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "inboundFrames": self._meter.frames,
            "callActiveSource": self.call_active_source or "none",
        }
        if self.sender is not None:
            out.update(self.sender.stats())
        return out


class MockConversation(_BaseConversation):
    """Mock-mode conversation: no Pipecat pipeline, no provider calls.

    Speaks the greeting on answer and replies to each burst of caller audio,
    using the same `PacedAudioSender` as the real path so the outbound half of
    the audio path (framing, pacing, serialization) is genuinely exercised.
    """

    #: Consecutive loud/quiet frames that delimit an utterance.
    VOICED_FRAMES = 5
    SILENT_FRAMES = 10
    ENERGY_THRESHOLD = 500

    def __init__(
        self,
        *,
        settings: Settings,
        session_id: str,
        serializer: Any,
        send_audio: Callable[[bytes], Awaitable[None]],
        send_control: Callable[[str], Awaitable[None]],
        on_ended: Callable[[str], Awaitable[None]] | None = None,
        services: Any = None,
    ) -> None:
        super().__init__(settings=settings, session_id=session_id)
        from app.providers import MockLLM, MockTTS

        self._tts = MockTTS(sample_rate=settings.bridge_sample_rate)
        self._llm = MockLLM(sample_rate=settings.bridge_sample_rate)
        self.sender = PacedAudioSender(
            session_id=session_id,
            serializer=serializer,
            send_audio=send_audio,
            send_control=send_control,
        )
        self._voiced = 0
        self._silent = 0
        self._heard_speech = False
        self.turns = 0

    async def start(self) -> None:
        self.sender.start()
        clog("INFO", self._session_id, "mock conversation started")

    async def push_audio(self, frame: Any) -> None:
        if not isinstance(frame, InputAudioRawFrame):
            return
        self._meter.note(
            sample_rate=frame.sample_rate,
            channels=frame.num_channels,
            byte_count=len(frame.audio),
        )
        if not self.call_active:
            await self.note_call_active("first-inbound-audio")

        import array

        samples = array.array("h")
        samples.frombytes(frame.audio[: len(frame.audio) - (len(frame.audio) % 2)])
        peak = max((abs(s) for s in samples), default=0)
        if peak >= self.ENERGY_THRESHOLD:
            self._voiced += 1
            self._silent = 0
            if self._voiced >= self.VOICED_FRAMES:
                self._heard_speech = True
        else:
            self._silent += 1
            self._voiced = 0
            if self._heard_speech and self._silent >= self.SILENT_FRAMES:
                self._heard_speech = False
                await self._reply()

    async def _reply(self) -> None:
        self.turns += 1
        clog("INFO", self._session_id, "caller turn ended, replying", turn=self.turns)
        text = self._llm.respond("caller spoke")
        await self.sender.enqueue(self._tts.synthesize(text), self._settings.bridge_sample_rate)

    async def _speak_greeting(self) -> None:
        await self.sender.enqueue(
            self._tts.synthesize(self.greeting_text), self._settings.bridge_sample_rate
        )

    async def stop(self, reason: str = "stopped") -> None:
        await self.sender.stop()
        clog("INFO", self._session_id, "conversation cleanup completed", reason=reason)

    def stats(self) -> dict[str, Any]:
        return {
            "inboundFrames": self._meter.frames,
            "callActiveSource": self.call_active_source or "none",
            **self.sender.stats(),
        }


def create_conversation(**kwargs: Any) -> _BaseConversation:
    """Real conversation normally; the mock one when ASSISTANT_MOCK_MODE is on."""
    settings: Settings = kwargs["settings"]
    if settings.mock_mode:
        return MockConversation(**kwargs)
    return CallConversation(**kwargs)
