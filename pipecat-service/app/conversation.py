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
import dataclasses
import time
from typing import Any, Awaitable, Callable

from loguru import logger

from app.call_context import CallContext, TranscriptLog, fetch_voice_prefs, resolve_call_context
from app.config import Settings, normalise_live_voice
from app.monitor import DIRECTION_CALLER, DIRECTION_EMYSA, get_hub

#: Last-resort opener, spoken verbatim only when the model cannot open the call
#: itself (no LLM context available) or ASSISTANT_GREETING is set. Normally the
#: model writes the opening line from the person's private brief - see
#: OPENING_CUE - so nothing about the intro is hardcoded. It deliberately names
#: nobody and nothing: the speaker is the person who set the call up, and the
#: system placing the call never introduces itself.
DEFAULT_GREETING = "Hey, can you hear me okay?"

#: Added to the LLM context the moment the callee answers, then the model is run.
#: It is a stage direction for the model, not something the person said.
OPENING_CUE = (
    "[The person has just picked up the call. Open it now, the way the person you "
    "are speaking as would if they had just rung someone: a short, natural hello, "
    "one or two short sentences. Do not introduce yourself unless your private "
    "brief says to, and do not mention any assistant, system or product. If the "
    "brief says to open a particular way, do exactly that.]"
)

#: Outbound audio is released in frames of this many milliseconds.
FRAME_MS = 20

#: How far ahead of real time frames may be released. Keeps the relay's
#: jitter buffer fed without letting a whole sentence burst out at once.
#: 60 ms (three frames) left no cushion: one slow event-loop tick on a shared
#: CPU, or a network hiccup to the relay, drained it and the callee heard the
#: audio skip. 200 ms absorbs that while staying imperceptible in a call.
#: Tunable per deployment with ASSISTANT_SEND_LEAD_SECS.
SEND_LEAD_SECS = 0.2

#: How late a frame may be before the pacing clock is restarted (an
#: underrun). Must exceed the lead, otherwise a normal jitter episode is
#: treated as a new utterance and the stream restarts with no cushion.
UNDERRUN_RESET_SECS = 0.3

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
        on_chunk: Callable[[bytes, int, int], None] | None = None,
        is_muted: Callable[[], bool] | None = None,
        frame_ms: int = FRAME_MS,
        lead_secs: float = SEND_LEAD_SECS,
    ) -> None:
        self._session_id = session_id
        self._serializer = serializer
        self._send_audio = send_audio
        self._send_control = send_control
        self._on_speaking = on_speaking
        # Real-time monitor fan-out: called with each PCM chunk at the moment
        # it is released to the carrier — i.e. exactly what the recipient is
        # hearing. Never awaited; a slow monitor cannot slow the call.
        self._on_chunk = on_chunk
        # Recipient-side mute ("Emysa muted" on the call screen): drops the
        # outbound audio at release time. Distinct from the browser's local
        # monitor mute, which must never touch this path.
        self._is_muted = is_muted
        self._frame_ms = frame_ms
        self._lead = lead_secs

        self._queue: asyncio.Queue[tuple[bytes, int, int] | None] = asyncio.Queue()
        self._task: asyncio.Task[None] | None = None
        self._speaking = False
        self._stopped = False

        self.frames_enqueued = 0
        self.frames_sent = 0
        self.frames_flushed = 0
        self.frames_muted = 0
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
                if deadline is None or deadline < now - UNDERRUN_RESET_SECS:
                    # Start of an utterance, or an underrun: restart the clock.
                    deadline = now
                await self._set_speaking(True)

                wait = deadline - self._lead - now
                if wait > 0:
                    await asyncio.sleep(wait)

                try:
                    muted = False
                    if self._is_muted is not None:
                        try:
                            muted = bool(self._is_muted())
                        except Exception:  # noqa: BLE001 - never block audio
                            muted = False
                    if muted:
                        # "Emysa muted": the recipient hears silence, the
                        # transcript still records the reply. Monitor audio
                        # is dropped with it — there is nothing to hear.
                        self.frames_muted += 1
                        continue
                    if self._on_chunk is not None:
                        try:
                            self._on_chunk(chunk, sample_rate, channels)
                        except Exception:  # noqa: BLE001 - monitor is best-effort
                            pass
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
            "framesMuted": self.frames_muted,
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

    def __init__(
        self,
        *,
        settings: Settings,
        session_id: str,
        platform: str | None = None,
        user_id: str | None = None,
    ) -> None:
        self._settings = settings
        self._session_id = session_id
        self.platform = platform
        self.user_id = user_id
        self._greeted = False
        self.call_active_source: str | None = None
        #: Monotonic timestamp of the *actual answer* (call_active). The talk
        #: timer and the recorded duration start here — never at dial time
        #: and never at "first audio frame arrived".
        self._answered_at: float | None = None
        #: Monotonic timestamp of pipeline start (when the bridge attached).
        self._started_at: float | None = None
        self._meter = _InboundMeter(session_id)
        #: Resolved app `calls` row (real calls only; None in mock mode or
        #: without Supabase creds). Owns every database write this call makes.
        self.call_context: CallContext | None = None
        #: Live transcript for this call (created alongside the context).
        self.transcript: TranscriptLog | None = None

    @property
    def greeting_text(self) -> str:
        return (self._settings.greeting or DEFAULT_GREETING).strip() or DEFAULT_GREETING

    @property
    def call_active(self) -> bool:
        return self.call_active_source is not None

    @property
    def answered_at(self) -> float | None:
        return self._answered_at

    def talk_seconds(self, now: float | None = None) -> int:
        """Seconds since the actual answer (0 when the call never connected)."""
        if self._answered_at is None:
            return 0
        now = now if now is not None else time.monotonic()
        return max(0, int(now - self._answered_at))

    def ring_seconds(self, now: float | None = None) -> int:
        """Seconds spent ringing (dial -> answer, or dial -> end when unanswered)."""
        if self._started_at is None:
            return 0
        end = self._answered_at
        if end is None:
            end = now if now is not None else time.monotonic()
        return max(0, int(end - self._started_at))

    async def note_call_active(self, source: str) -> bool:
        """The callee answered. Speak the greeting exactly once.

        `source` records how we learned of it ("relay-signal" = the provider's
        real answer event; "first-inbound-audio" only for relays explicitly
        opted into ASSISTANT_ANSWER_ON_FIRST_AUDIO) so the log shows which
        path fired. Returns True only for the call that actually triggered
        the greeting.
        """
        if self.call_active_source is not None:
            return False
        self.call_active_source = source
        self._answered_at = time.monotonic()
        clog("INFO", self._session_id, "call connected, sending greeting", source=source)
        if self.call_context is not None:
            await self.call_context.set_in_progress()
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
    LLMRunFrame,
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
        self.started_event = asyncio.Event()

    async def process_frame(self, frame: Any, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)

        if isinstance(frame, StartFrame):
            self._sender.start()
            self.started_event.set()
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
        self._vad_stop_at: float | None = None

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
                self._vad_stop_at = time.monotonic()
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
                if self._vad_stop_at is not None:
                    clog(
                        "INFO",
                        sid,
                        "[CLASSIC] first_audio_ms=%d" % int((time.monotonic() - self._vad_stop_at) * 1000),
                        note="caller speech end -> first Fish audio",
                    )
                    self._vad_stop_at = None
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


#: Live real-pipeline conversations by bridge session id, so the control-plane
#: `/calls/{session_id}/note` route can reach the one call a note is for.
#: Registered when the LLM context exists, removed on stop.
_LIVE_CONVERSATIONS: dict[str, Any] = {}


def get_live_conversation(session_id: str) -> Any | None:
    return _LIVE_CONVERSATIONS.get(session_id)


#: Wrapper for a note the person adds to their own brief during the call. The
#: recipient cannot see or hear it; the model is told how to use it. Must keep
#: starting with "[Private note" - the system prompt recognises it by that.
OPERATOR_NOTE_PREFIX = (
    "[Private note: new information or a change of plan for your own brief, from the "
    "person you are speaking as. The person on the phone cannot see or hear this. Do "
    "not read it out, do not announce it, and do not stop or restart what you are "
    "saying. Work it into the conversation at the next natural moment, in your own "
    "words.] "
)
MAX_NOTE_CHARS = 1000


class CallConversation(_BaseConversation):
    """Runs the real Pipecat pipeline for one bridged call."""

    # Class-level defaults so a bare instance (tests build one with __new__)
    # behaves as a classic call.
    engine: str = "classic"
    _live_state: Any = None
    _llm: Any = None
    _switching: bool = False
    _watchdog: Any = None

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
        platform: str | None = None,
        user_id: str | None = None,
        live_llm: Any = None,
    ) -> None:
        super().__init__(
            settings=settings,
            session_id=session_id,
            platform=platform,
            user_id=user_id,
        )
        self._serializer = serializer
        self._send_audio = send_audio
        self._send_control = send_control
        self._on_ended = on_ended
        self._services = services
        #: "live" (GPT-Live) or "classic" (STT -> LLM -> Fish); decided per call.
        self.engine = settings.engine_for_call() if services is None else "classic"
        self._live_llm_override = live_llm
        self._live_state: Any = None
        self._llm: Any = None
        self._extra_context: str | None = None
        self._rate: int = settings.bridge_sample_rate
        self._pending_notes: list[str] = []
        self._switching = False
        self._watchdog: asyncio.Task[None] | None = None
        self._engine_reason = "init"
        self._fallback = False
        self._fallback_reason: str | None = None
        self._first_engine = self.engine

        self._task: Any = None
        self._runner: Any = None
        self._context: Any = None
        self._run_task: asyncio.Task[None] | None = None
        self._output: BridgeOutput | None = None
        self.sender: PacedAudioSender | None = None
        self._stopped = False
        self._started_at: float | None = None
        #: Recipient-side mute ("Emysa muted"), polled from the call row.
        self._ai_muted = False
        self._mute_task: asyncio.Task[None] | None = None

    async def start(self) -> None:
        # Resolve the app's `calls` row before the pipeline exists: it is
        # the source of the per-call objective/person context for the system
        # prompt AND the id every live transcript write lands on. The row is
        # written by Vercel just before the carrier dials, so this waits
        # against a bounded deadline (ASSISTANT_CONTEXT_TIMEOUT_SECS) rather
        # than losing the race by milliseconds. Without it (mock mode, no
        # Supabase creds, row never found) the call still runs — with the
        # default prompt and no transcript persistence.
        self.call_context = await resolve_call_context(
            self._settings,
            session_id=self._session_id,
            platform=self.platform or "unknown",
            user_id=self.user_id,
        )
        extra_context: str | None = None
        if self.call_context is not None:
            self.transcript = TranscriptLog(
                self.call_context,
                on_entry=lambda entry: get_hub().publish_transcript(self._session_id, entry),
            )
            extra_context = self.call_context.extra_context or None

        await self._resolve_call_voice_and_engine()

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
            # Monitor: every released chunk is what the recipient is hearing
            # at that instant — the honest source for "what Emysa says".
            on_chunk=lambda pcm, rate, channels: get_hub().publish(
                self._session_id, DIRECTION_EMYSA, rate, pcm
            ),
            is_muted=lambda: self._ai_muted,
            lead_secs=self._settings.send_lead_secs,
        )
        self._output = BridgeOutput(
            sender=self.sender,
            serializer=self._serializer,
            send_control=self._send_control,
            session_id=self._session_id,
        )
        holder["out"] = self._output

        _LIVE_CONVERSATIONS[self._session_id] = self
        self._extra_context = extra_context
        self._rate = rate
        self._started_at = time.monotonic()
        if self.engine == "classic":
            await self._launch_pipeline()
        # engine == "live": the GPT-Live socket and session are opened when the
        # callee ANSWERS (see _speak_greeting), so nothing is connected - or billed -
        # while the phone is still ringing.
        if self.call_context is not None:
            self._mute_task = asyncio.create_task(
                self._poll_ai_muted(), name=f"mute-poll-{self._session_id}"
            )
        clog(
            "INFO",
            self._session_id,
            "pipeline started" if self.engine == "classic" else "call ready; live session opens on answer",
            bridgeSampleRate=rate,
            engine=self.engine,
            contextResolved=bool(self.call_context),
        )

    async def _resolve_call_voice_and_engine(self) -> None:
        """Pick this call's engine and voice from the user's saved choices.

        The engine is automatic: a user with a ready cloned voice who has it selected
        runs the classic pipeline (STT -> Luna -> Fish); everyone else runs GPT-Live
        with their own saved Live voice. The Live voice and the cloned voice are two
        separate settings and are never used in place of each other.
        """
        sid = self._session_id
        if self._services is not None or self._settings.mock_mode:
            self._engine_reason = "mock-or-injected-services"
            clog("INFO", sid, f"[CALL ENGINE] selected={self._engine_label()}", reason=self._engine_reason)
            return
        uid = (getattr(self.call_context, "user_id", None) if self.call_context else None) or self.user_id
        prefs = await fetch_voice_prefs(self._settings, uid, sid) if uid else None
        hello_clone = self._settings.tts_voice_id if self._settings.tts_voice_is_per_call else None
        custom_id = (prefs.custom_voice_id if prefs and prefs.custom_voice_id else None) or hello_clone
        use_custom = prefs.use_custom_voice if prefs and prefs.use_custom_voice is not None else True
        want_custom = bool(custom_id) and use_custom

        updates: dict[str, Any] = {}
        if want_custom:
            updates.update(tts_voice_id=custom_id, tts_voice_is_per_call=True)
        elif hello_clone:
            # The user picked a Standard (GPT-Live) voice; the relay's clone must not force classic.
            updates.update(tts_voice_id=None, tts_voice_is_per_call=False)
        chosen = normalise_live_voice(prefs.live_voice_id) if prefs else None
        if chosen:
            updates.update(live_voice=chosen, live_voice_source="user")
        else:
            updates.update(live_voice_source="env-default")
        self._settings = dataclasses.replace(self._settings, **updates)

        self.engine = self._settings.engine_for_call()
        self._first_engine = self.engine
        cfg = self._settings.call_engine
        if cfg == "classic":
            self._engine_reason = "ASSISTANT_CALL_ENGINE=classic (kill switch)"
        elif cfg == "live" and want_custom:
            self._engine_reason = "ASSISTANT_CALL_ENGINE=live forces GPT-Live; the user's custom voice is ignored"
        elif want_custom:
            self._engine_reason = "user has a custom (cloned) voice selected"
        elif self.engine == "classic":
            self._engine_reason = "no OPENAI_API_KEY/LUNA_API_KEY for GPT-Live"
        else:
            self._engine_reason = "no custom voice selected"
        clog(
            "INFO",
            sid,
            f"[CALL ENGINE] selected={self._engine_label()}",
            reason=self._engine_reason,
            userKnown=bool(uid),
            prefsRead=prefs is not None,
            customVoice=bool(want_custom),
            liveVoice=self._settings.live_voice if self.engine == "live" else "-",
            liveVoiceSource=self._settings.live_voice_source if self.engine == "live" else "-",
            via=self.platform,
        )

    def _engine_label(self) -> str:
        return "gpt-live" if self.engine == "live" else "classic"

    def _log_engine_summary(self, reason: str) -> None:
        """One unmistakable end-of-call line: which engine actually handled the call."""
        st = self._live_state
        final = self._engine_label()
        live_ms = st.first_audio_ms if st is not None else None
        turns = st.turn_latencies_ms if st is not None else []
        clog(
            "INFO",
            self._session_id,
            f"[CALL ENGINE] summary final_engine={final}",
            first_engine=("gpt-live" if self._first_engine == "live" else "classic"),
            gpt_live_session_created=bool(st is not None and st.session_started),
            gpt_live_voice=(self._settings.live_voice if final == "gpt-live" else "-"),
            fallback=self._fallback,
            fallback_reason=self._fallback_reason or "-",
            fish_tts_used=(final == "classic"),
            luna_conversational_llm_used=(final == "classic"),
            gpt_live_first_audio_ms=live_ms if live_ms is not None else "-",
            gpt_live_turn_latency_ms=(",".join(str(t) for t in turns[:12]) or "-"),
            transcript_source=("gpt-live" if final == "gpt-live" else "stt+classic"),
            end_reason=reason,
        )

    async def _launch_pipeline(self) -> None:
        """Build and start the Pipecat pipeline (once)."""
        if self._task is not None:
            return
        from pipecat.pipeline.runner import PipelineRunner
        from pipecat.pipeline.task import PipelineParams, PipelineTask

        from app.pipeline import build_llm_context, build_pipeline

        extra_context = self._extra_context
        rate = self._rate
        if self.engine == "live":
            from app.live import (
                LiveCallState,
                build_live_context,
                build_live_pipeline,
                build_live_system_prompt,
            )

            self._live_state = LiveCallState()
            self._context = build_live_context()
            pipeline, self._llm = build_live_pipeline(
                settings=self._settings,
                transport=_TransportShim(BridgeInput(), self._output),
                context=self._context,
                system_instruction=build_live_system_prompt(self._settings, extra_context),
                transcript=self.transcript,
                state=self._live_state,
                on_end_call=self._schedule_assistant_hangup,
                llm=self._live_llm_override,
                session_id=self._session_id,
            )
        else:
            clog(
                "INFO",
                self._session_id,
                "[CALL ENGINE] classic pipeline starting (STT -> Luna -> Fish)",
                reason=self._engine_reason,
            )
            clog("INFO", self._session_id, "[FISH] tts", voiceIdTail=(self._settings.tts_voice_id or "default")[-4:], custom=self._settings.tts_voice_is_per_call)
            clog("INFO", self._session_id, "[LUNA] conversational llm", model=self._settings.resolved_llm_model())
            self._context = build_llm_context()
            pipeline, self._llm = build_pipeline(
                settings=self._settings,
                transport=_TransportShim(BridgeInput(), self._output),
                context=self._context,
                extra_context=extra_context,
                services=self._services,
                on_end_call=self._schedule_assistant_hangup,
                transcript=self.transcript,
                language=self.call_context.language if self.call_context else None,
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
        # Wait for StartFrame to reach BridgeOutput so all upstream processors
        # (including TTSService) are initialized before any greeting or audio
        # frame is queued.
        with contextlib.suppress(asyncio.TimeoutError):
            await asyncio.wait_for(self._output.started_event.wait(), timeout=2.0)

    async def _live_startup_watchdog(self) -> None:
        """If the GPT-Live session never starts (no access on this key, API down, bad
        config), the callee would hear silence for the whole call. Switch this call to
        the classic pipeline instead, so a failure here costs seconds, not the call."""
        state = self._live_state
        deadline = time.monotonic() + self._settings.live_start_timeout_secs
        while not self._stopped and time.monotonic() < deadline:
            if state is not None and state.session_started:
                return
            await asyncio.sleep(0.1)
        if self._stopped or (state is not None and state.session_started):
            return
        reason = (
            f"session.created not received within {self._settings.live_start_timeout_secs:.0f}s "
            "(see 'pipeline error' lines above for the API's reason)"
        )
        clog("ERROR", self._session_id, "[GPT-LIVE] attempted=true session.created=false fallback=true", reason=reason)
        clog("ERROR", self._session_id, "[CALL ENGINE] selected=classic reason=gpt-live-start-failed")
        self._fallback = True
        self._fallback_reason = reason
        await self._fallback_to_classic()

    async def _fallback_to_classic(self) -> None:
        if self._stopped or self.engine != "live":
            return
        self._switching = True
        try:
            old_task, old_run = self._task, self._run_task
            self.engine = "classic"
            self._live_state = None
            self._llm = None
            self._task = None
            self._run_task = None
            self._context = None
            if old_task is not None:
                with contextlib.suppress(Exception):
                    await asyncio.wait_for(old_task.cancel(), timeout=5.0)
            if old_run is not None:
                try:
                    await asyncio.wait_for(old_run, timeout=5.0)
                except (asyncio.TimeoutError, asyncio.CancelledError, Exception):  # noqa: BLE001
                    old_run.cancel()
                    with contextlib.suppress(asyncio.CancelledError, Exception):
                        await old_run
            await self._launch_pipeline()
        finally:
            self._switching = False
        if not self._stopped:
            await self._speak_greeting()
            clog("INFO", self._session_id, "classic engine took over the call")

    async def _flush_pending_notes(self) -> None:
        """Deliver notes added while the phone was ringing, once the session is up."""
        from app.live import send_private_note

        state = self._live_state
        for _ in range(100):  # up to ~10 s for the session to start
            if self._stopped or (state is not None and state.session_started):
                break
            await asyncio.sleep(0.1)
        notes, self._pending_notes = self._pending_notes, []
        for note in notes:
            if self._stopped:
                return
            try:
                await send_private_note(self._llm, OPERATOR_NOTE_PREFIX + note)
            except Exception as exc:  # noqa: BLE001 - a lost note must not hurt the call
                clog("WARNING", self._session_id, "queued note not delivered", error=type(exc).__name__)

    async def _poll_ai_muted(self) -> None:
        """Keep the recipient-side mute flag fresh (one cheap select / 3 s).

        The call screen's "Emysa muted" toggle writes `calls.ai_muted`; the
        sender drops outbound audio while it is set. The browser's *monitor*
        mute is entirely separate and never reaches this path.
        """
        assert self.call_context is not None
        while not self._stopped:
            try:
                self._ai_muted = await self.call_context.fetch_ai_muted()
            except Exception:  # noqa: BLE001 - keep the last known value
                pass
            await asyncio.sleep(3.0)

    def _schedule_assistant_hangup(self) -> None:
        if self._stopped:
            return
        asyncio.create_task(self._graceful_assistant_hangup())

    async def _live_goodbye_wait(self) -> None:
        """GPT-Live streams audio (silence included) at real-time pace all call, so
        "the sender is idle" never happens. Wait instead until the model has spoken
        its goodbye (text stopped for a moment), bounded so a call never hangs open."""
        state = self._live_state
        t0 = time.monotonic()
        deadline = t0 + 10.0
        while not self._stopped and time.monotonic() < deadline:
            now = time.monotonic()
            spoke_after = state.last_ai_text_at > t0
            if spoke_after and state.ai_idle_secs(now) >= 1.5:
                break
            if not spoke_after and now - t0 >= 3.5:
                break  # the goodbye was already said before the tool ran
            await asyncio.sleep(0.1)
        await asyncio.sleep(0.8)  # let the last audio reach the callee

    async def _graceful_assistant_hangup(self) -> None:
        if self._live_state is not None:
            await self._live_goodbye_wait()
            if self._stopped:
                return
            clog("INFO", self._session_id, "assistant requested call termination")
            with contextlib.suppress(Exception):
                await self._send_control('{"type":"hangup","reason":"assistant-ended-call"}')
            await self.stop("assistant-ended-call")
            return
        # Allow final goodbye audio to be enqueued and drained before hanging up
        await asyncio.sleep(0.4)
        deadline = time.monotonic() + 8.0
        while (
            not self._stopped
            and self.sender is not None
            and self.sender.speaking
            and time.monotonic() < deadline
        ):
            await asyncio.sleep(0.1)
        if self._stopped:
            return
        clog("INFO", self._session_id, "assistant requested call termination")
        with contextlib.suppress(Exception):
            await self._send_control('{"type":"hangup","reason":"assistant-ended-call"}')
        await self.stop("assistant-ended-call")

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
            if not self._stopped and not self._switching and self._on_ended is not None:
                with contextlib.suppress(Exception):
                    await self._on_ended(reason)

    def add_operator_note(self, text: str) -> bool:
        """Add a live note from the call's owner to the model's context.

        Appended to the context only: it does NOT run the model, so whatever
        Emysa is saying right now is untouched and she picks the note up on
        her next turn. Returns False if the call is not in a state to take it.
        """
        clean = " ".join((text or "").split())[:MAX_NOTE_CHARS]
        if not clean or self._stopped:
            return False
        if self.engine == "live" and self._context is None:
            # Still ringing: the live session does not exist yet. Hold the note
            # and deliver it as soon as the session starts.
            self._pending_notes.append(clean)
            return True
        if self._context is None:
            return False
        if self._live_state is not None and self._llm is not None:
            # A live session's instructions are fixed, so the note goes in on the
            # model's private "thinking" channel (it uses it, never reads it out).
            from app.live import send_private_note

            async def _send() -> None:
                try:
                    await send_private_note(self._llm, OPERATOR_NOTE_PREFIX + clean)
                except Exception as exc:  # noqa: BLE001 - a lost note must not hurt the call
                    clog("WARNING", self._session_id, "operator note not delivered", error=type(exc).__name__)

            asyncio.create_task(_send(), name=f"operator-note-{self._session_id}")
            clog("INFO", self._session_id, "operator note sent to live session", chars=len(clean))
            return True
        self._context.add_message(
            {"role": "system", "content": OPERATOR_NOTE_PREFIX + clean}
        )
        clog("INFO", self._session_id, "operator note added", chars=len(clean))
        return True

    async def push_audio(self, frame: Any) -> None:
        if self._stopped or self._task is None:
            return
        if isinstance(frame, InputAudioRawFrame):
            self._meter.note(
                sample_rate=frame.sample_rate,
                channels=frame.num_channels,
                byte_count=len(frame.audio),
            )
            # Monitor: what the person on the call actually says. Published
            # per frame; with no listeners it is a dict lookup and nothing else.
            get_hub().publish(
                self._session_id, DIRECTION_CALLER, frame.sample_rate, frame.audio
            )
            if not self.call_active and self._settings.answer_on_first_audio:
                # Legacy relays only, explicitly opted in: caller audio is
                # treated as proof the callee answered. The DEFAULT is off —
                # the provider's answer event (ACAF `call_active`) is the
                # source of truth, because early audio must never start the
                # conversation timer while the phone is still ringing.
                await self.note_call_active("first-inbound-audio")
        await self._task.queue_frame(frame)

    async def _speak_greeting(self) -> None:
        if self.engine != "live" and self._task is None:
            return
        if self.engine == "live":
            # GPT-Live: the session starts now (not while the phone rings, so
            # ringing time is never billed). A trailing developer message is how
            # the service asks the model to speak first, in its own words.
            from app.live import opening_cue

            await self._launch_pipeline()
            if self._context is None or self._task is None:
                return
            self._context.add_message(
                {"role": "developer", "content": opening_cue(self._settings.greeting)}
            )
            await self._task.queue_frame(LLMRunFrame())
            clog("INFO", self._session_id, "live model opening the call")
            if self._live_llm_override is None:  # tests inject their own service
                self._watchdog = asyncio.create_task(
                    self._live_startup_watchdog(), name=f"live-watchdog-{self._session_id}"
                )
            if self._pending_notes:
                asyncio.create_task(self._flush_pending_notes(), name=f"pending-notes-{self._session_id}")
            return
        # Default: the model opens the call itself, as the person it speaks
        # as, guided by that person's private brief already in its system
        # prompt (no introduction unless the brief asks for one). An explicit
        # ASSISTANT_GREETING override is spoken verbatim instead.
        if not (self._settings.greeting or "").strip() and self._context is not None:
            try:
                self._context.add_message({"role": "user", "content": OPENING_CUE})
                await self._task.queue_frame(LLMRunFrame())
                clog("INFO", self._session_id, "model opening the call")
                return
            except Exception as exc:  # noqa: BLE001 - fall back to the fixed opener
                clog("WARNING", self._session_id, "model opening failed; using fallback", error=type(exc).__name__)
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
        if _LIVE_CONVERSATIONS.get(self._session_id) is self:
            _LIVE_CONVERSATIONS.pop(self._session_id, None)
        watchdog, self._watchdog = self._watchdog, None
        if watchdog is not None and watchdog is not asyncio.current_task():
            watchdog.cancel()
        mute_task, self._mute_task = self._mute_task, None
        if mute_task is not None:
            mute_task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await mute_task
        # Tell any live monitors this call is over (they close cleanly); a
        # monitor must never outlive the call it is listening to.
        get_hub().close_room(self._session_id)
        clog("INFO", self._session_id, "conversation stopping", reason=reason, **self.stats())
        self._log_engine_summary(reason)
        # Persist whatever the transcript has accumulated so far before the
        # pipeline is torn down — the end report then waits out the carrier's
        # own outcome callback and only fills in a status nobody reported.
        if self.transcript is not None:
            with contextlib.suppress(Exception):
                await self.transcript.close()
        context = self.call_context
        if context is not None:
            active = self.call_active
            # Talk duration runs from the ACTUAL answer (call_active) — the
            # conversation timer's source of truth. A call that never
            # connected has zero talk time; its ring time lives in
            # answered_at/created_at on the row.
            duration = self.talk_seconds()
            asyncio.create_task(
                self._report_call_end(context, reason, active, duration),
                name=f"call-end-report-{self._session_id}",
            )
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

    async def _report_call_end(
        self, context: CallContext, reason: str, active: bool, duration: int
    ) -> None:
        """Hand the finished call back to the app (after a grace period).

        Runs as its own task so `stop()` stays prompt: the app-side
        `relay-call-status` handler re-checks whether the carrier already
        reported, and only fills the gap (status + chat follow-up + shared
        summary/memory extraction) when nothing else did.
        """
        try:
            if active:
                status = "completed"
            elif reason in (
                "peer-hangup",
                "peer-stopped",
                "hung-up",
                "session-stopped",
                "websocket-closed",
            ):
                status = "no_answer"
            else:
                status = "failed"
            await context.report_end(
                settings=self._settings,
                status=status,
                duration_seconds=duration,
                active=active,
            )
        except Exception as exc:  # noqa: BLE001 - must never raise unhandled
            clog(
                "WARNING",
                self._session_id,
                "end report raised",
                error=type(exc).__name__,
            )
        finally:
            with contextlib.suppress(Exception):
                await context.aclose()

    def stats(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "inboundFrames": self._meter.frames,
            "callActiveSource": self.call_active_source or "none",
            "contextResolved": self.call_context is not None,
            "engine": self.engine,
        }
        if self.transcript is not None:
            out["transcriptWrites"] = self.transcript.writes
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
        platform: str | None = None,
        user_id: str | None = None,
    ) -> None:
        super().__init__(
            settings=settings,
            session_id=session_id,
            platform=platform,
            user_id=user_id,
        )
        from app.providers import MockLLM, MockTTS

        self._tts = MockTTS(sample_rate=settings.bridge_sample_rate)
        self._llm = MockLLM(sample_rate=settings.bridge_sample_rate)
        self.sender = PacedAudioSender(
            session_id=session_id,
            serializer=serializer,
            send_audio=send_audio,
            send_control=send_control,
            on_chunk=lambda pcm, rate, channels: get_hub().publish(
                session_id, DIRECTION_EMYSA, rate, pcm
            ),
        )
        self._voiced = 0
        self._silent = 0
        self._heard_speech = False
        self.turns = 0

    async def start(self) -> None:
        self.sender.start()
        self._started_at = time.monotonic()
        clog("INFO", self._session_id, "mock conversation started")

    async def push_audio(self, frame: Any) -> None:
        if not isinstance(frame, InputAudioRawFrame):
            return
        self._meter.note(
            sample_rate=frame.sample_rate,
            channels=frame.num_channels,
            byte_count=len(frame.audio),
        )
        get_hub().publish(
            self._session_id, DIRECTION_CALLER, frame.sample_rate, frame.audio
        )
        if not self.call_active and self._settings.answer_on_first_audio:
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
        get_hub().close_room(self._session_id)
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
