"""Emysa audio-adapter contract.

``AudioAdapter`` is the seam where GPT Live will plug in later:

    Telegram PCM (48k mono s16le, 10 ms frames)
        -> ``on_caller_audio(frame)``            (caller -> agent)
    ``out.send_pcm(pcm)`` / ``out.clear_outbound()``
        -> paced into the call at real time       (agent -> caller)

Nothing here knows about Telegram, NTgCalls or any model API. Phase 5 only
ships test adapters; **no GPT Live adapter exists yet, by design.**

Contract notes for a future realtime-model adapter:
  * frames arrive on the event loop, already re-chunked to exactly 960 bytes;
  * ``send_pcm`` accepts any length and any burst size - the bridge paces it
    at 100 frames/s, so a model returning audio faster than real time is fine;
  * ``clear_outbound()`` is the barge-in hook (drop queued agent audio when the
    caller interrupts);
  * if the model uses another sample rate, resample *inside* the adapter.
"""
from __future__ import annotations

import wave
from typing import Protocol

from .pcm import FRAME_BYTES, SAMPLE_RATE, known_test_signal
from .types import CallInfo


class PcmSink(Protocol):
    """What the bridge hands an adapter so it can talk back to the caller."""

    def send_pcm(self, pcm: bytes) -> None: ...

    def clear_outbound(self) -> int: ...

    @property
    def outbound_backlog_ms(self) -> float: ...


class AudioAdapter:
    """Base class; every hook is optional."""

    async def on_call_start(self, info: CallInfo, out: PcmSink) -> None:
        """Media is connected; the bridge is running."""

    async def on_caller_audio(self, frame: bytes) -> None:
        """One 960-byte (10 ms, 48 kHz mono s16le) frame from the caller."""

    async def on_call_end(self, reason: str) -> None:
        """The call ended (reason is the CallEnd.reason string)."""


class KnownAudioAdapter(AudioAdapter):
    """Phase-5 test adapter: records what the caller sends and returns a
    known, deterministic PCM clip.

    ``trigger="start"``              play the clip as soon as the call is live.
    ``trigger="first_caller_frame"`` play it only after caller audio arrived
                                     (proves receive -> respond).
    """

    def __init__(self, reply: bytes | None = None, trigger: str = "start",
                 record_seconds: float = 30.0):
        if trigger not in ("start", "first_caller_frame"):
            raise ValueError("trigger must be 'start' or 'first_caller_frame'")
        self.reply = known_test_signal() if reply is None else reply
        self.trigger = trigger
        self._max_rec = int(record_seconds * SAMPLE_RATE * 2)
        self._rec = bytearray()
        self._out: PcmSink | None = None
        self.info: CallInfo | None = None
        self.rx_frames = 0
        self.bad_frames = 0
        self.reply_started = False
        self.ended_reason: str | None = None

    async def on_call_start(self, info: CallInfo, out: PcmSink) -> None:
        self.info, self._out = info, out
        if self.trigger == "start":
            self._play()

    async def on_caller_audio(self, frame: bytes) -> None:
        self.rx_frames += 1
        if len(frame) != FRAME_BYTES:
            self.bad_frames += 1
        if len(self._rec) < self._max_rec:
            self._rec.extend(frame)
        if self.trigger == "first_caller_frame" and not self.reply_started:
            self._play()

    async def on_call_end(self, reason: str) -> None:
        self.ended_reason = reason

    def _play(self) -> None:
        if self._out is not None and not self.reply_started:
            self.reply_started = True
            self._out.send_pcm(self.reply)

    def received_pcm(self) -> bytes:
        return bytes(self._rec)

    def save_wav(self, path: str) -> None:
        with wave.open(path, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(SAMPLE_RATE)
            w.writeframes(bytes(self._rec))
