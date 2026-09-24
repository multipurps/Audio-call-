"""Mock adapter: a synthetic call with no Telegram, Twilio, or network.

This is the "local test mode that does not place real Telegram or Twilio
calls" the brief requires, and the way to exercise the whole pipeline --
transport, session lifecycle, barge-in, teardown -- in CI.

It generates real, audible PCM, not silence. That distinction matters: a mock
that emits silence would let a completely broken audio path pass every test,
because silence is indistinguishable from a working path that happens to be
quiet.

It also *drives* the conversation on a schedule, so a single mock session
exercises: the caller speaking, the assistant responding, a barge-in
mid-response, and a clean hangup.
"""

from __future__ import annotations

import asyncio
import contextlib
import struct
import time
from dataclasses import dataclass, field
from typing import AsyncIterator

from loguru import logger

from app.adapters.base import AdapterClosed, NormalizedAudioFrame, TransportAdapter
from app.audio import pcm16_frame_bytes
from app.providers import synthesize_tone


@dataclass
class MockCallScript:
    """What the synthetic caller does, and when.

    Defaults describe a short realistic call: two turns of speech, a barge-in
    while the assistant is answering, then a hangup.
    """

    #: Utterances the synthetic caller "says", in order.
    utterances: tuple[str, ...] = (
        "Hi, can you hear me?",
        "Great. What is the weather like?",
    )
    #: Milliseconds of speech per utterance.
    utterance_ms: int = 900
    #: Milliseconds of silence between utterances.
    gap_ms: int = 600
    #: Interrupt the assistant this many milliseconds after it starts replying.
    #: Zero disables barge-in, which is useful for testing the no-interruption
    #: path separately.
    barge_in_after_ms: int = 400
    #: Total synthetic call length before hanging up.
    total_ms: int = 4000
    #: Frame cadence, matching a real telephony frame.
    frame_ms: int = 20


@dataclass
class MockCallState:
    """Observable effects, so tests can assert on what happened."""

    frames_sent_to_caller: int = 0
    frames_received_from_caller: int = 0
    #: Frames the assistant tried to send after a barge-in cancelled its turn.
    frames_cancelled: int = 0
    barge_ins: int = 0
    utterance_count: int = 0
    stopped: bool = False
    started_at: float = field(default_factory=time.monotonic)

    @property
    def elapsed_ms(self) -> float:
        return (time.monotonic() - self.started_at) * 1000


class MockCallAdapter(TransportAdapter):
    """A self-driving synthetic call.

    `receiveAudio()` produces frames from the script. `sendAudio()` "plays"
    them back to the synthetic caller -- recorded, never sent anywhere -- and
    triggers a barge-in if the assistant is still talking when the script says
    to interrupt.
    """

    carrier = "mock"

    def __init__(
        self,
        *,
        sample_rate: int = 16000,
        script: MockCallScript | None = None,
        realtime: bool = True,
    ) -> None:
        self.sample_rate = sample_rate
        self.script = script or MockCallScript()
        #: When False, the script fires as fast as the consumer pulls frames.
        #: Tests use this to avoid sleeping; a human listening uses True.
        self.realtime = realtime

        self.state = MockCallState()
        self.assistant_output: list[bytes] = []
        self._started = False
        self._closed = False
        self._seq = 0
        #: Set when the assistant's output should be cut short.
        self._interrupted = asyncio.Event()
        self._assistant_speaking = False

    # -- lifecycle -------------------------------------------------------

    async def start(self) -> None:
        self._started = True
        logger.info(
            "mock call started",
            extra={
                "sampleRate": self.sample_rate,
                "utterances": len(self.script.utterances),
                "realtime": self.realtime,
            },
        )

    # -- inbound ---------------------------------------------------------

    def receiveAudio(self) -> AsyncIterator[NormalizedAudioFrame]:  # noqa: N802
        return self._scripted_audio()

    async def _scripted_audio(self) -> AsyncIterator[NormalizedAudioFrame]:
        """Walk the script, emitting caller speech interleaved with silence."""
        frame_bytes = pcm16_frame_bytes(self.sample_rate, self.script.frame_ms)
        silence = struct.pack(f"<{frame_bytes // 2}h", *([0] * (frame_bytes // 2)))

        for utterance in self.script.utterances:
            if self._closed or self.state.stopped:
                return

            self.state.utterance_count += 1
            speech = synthesize_tone(
                utterance,
                sample_rate=self.sample_rate,
                duration_ms=self.script.utterance_ms,
            )
            for offset in range(0, len(speech) - frame_bytes + 1, frame_bytes):
                if self._closed or self.state.stopped:
                    return
                yield self._frame(speech[offset : offset + frame_bytes])
                if self.realtime:
                    await asyncio.sleep(self.script.frame_ms / 1000)

            # Silence between turns is what the VAD uses to decide the caller
            # finished, so it has to be real frames, not a skipped sleep.
            gap_frames = max(1, self.script.gap_ms // self.script.frame_ms)
            for _ in range(gap_frames):
                if self._closed or self.state.stopped:
                    return
                yield self._frame(silence)
                if self.realtime:
                    await asyncio.sleep(self.script.frame_ms / 1000)

    def _frame(self, payload: bytes) -> NormalizedAudioFrame:
        frame = NormalizedAudioFrame(
            pcm=payload,
            sample_rate=self.sample_rate,
            channels=1,
            encoding="pcm_s16le",
            sequence=self._seq,
            timestamp_ms=int(self.state.elapsed_ms),
        )
        self._seq += 1
        self.state.frames_received_from_caller += 1
        return frame

    # -- outbound --------------------------------------------------------

    async def sendAudio(self, frame: NormalizedAudioFrame) -> None:  # noqa: N802
        """Record assistant audio; trigger a barge-in when the script says so.

        The first frame of assistant output arms the barge-in timer. When it
        fires, `interrupted` is set and subsequent frames are dropped -- which
        is exactly what TTS cancellation looks like at this layer, and is what
        the cancellation tests assert on.
        """
        if self._closed:
            raise AdapterClosed("mock adapter is closed")
        if frame.encoding != "pcm_s16le":
            raise ValueError(f"mock adapter expects pcm_s16le, got {frame.encoding!r}")

        if self._interrupted.is_set():
            # Cancelled audio is counted but not retained, so a test can tell
            # "the assistant stopped mid-turn" apart from "the assistant said
            # nothing at all" -- two failures with the same symptom.
            self.state.frames_cancelled += 1
            return

        if not self._assistant_speaking:
            self._assistant_speaking = True
            if self.script.barge_in_after_ms > 0:
                asyncio.create_task(self._schedule_barge_in())

        self.assistant_output.append(frame.pcm)
        self.state.frames_sent_to_caller += 1
        if self.realtime:
            await asyncio.sleep(self.script.frame_ms / 1000)

    async def _schedule_barge_in(self) -> None:
        await asyncio.sleep(self.script.barge_in_after_ms / 1000)
        if not self._closed:
            self.trigger_barge_in()

    def trigger_barge_in(self) -> None:
        """Simulate the caller starting to speak over the assistant."""
        self._interrupted.set()
        self.state.barge_ins += 1
        logger.debug("mock barge-in triggered")

    def note_assistant_idle(self) -> None:
        """Assistant finished its turn; clear the interruption for the next one."""
        self._assistant_speaking = False
        self._interrupted.clear()

    # -- teardown --------------------------------------------------------

    async def stop(self) -> None:
        if self._closed:
            return
        self._closed = True
        self.state.stopped = True
        logger.info(
            "mock call stopped",
            extra={
                "framesFromCaller": self.state.frames_received_from_caller,
                "framesToCaller": self.state.frames_sent_to_caller,
                "bargeIns": self.state.barge_ins,
                "framesCancelled": self.state.frames_cancelled,
            },
        )

    @property
    def assistant_bytes(self) -> int:
        """Total bytes of assistant audio actually delivered."""
        return sum(len(chunk) for chunk in self.assistant_output)

    def stats(self) -> dict[str, object]:
        base = super().stats()
        base.update(
            {
                "framesFromCaller": self.state.frames_received_from_caller,
                "framesToCaller": self.state.frames_sent_to_caller,
                "bargeIns": self.state.barge_ins,
                "framesCancelled": self.state.frames_cancelled,
                "utterances": self.state.utterance_count,
                "assistantBytes": self.assistant_bytes,
            }
        )
        return base
