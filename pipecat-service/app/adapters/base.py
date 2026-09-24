"""Carrier-agnostic transport adapter interface.

The brief's requirement:

    Create a transport adapter with a clear interface:
        receiveAudio(): stream of normalized audio frames
        sendAudio(frame): sends normalized audio frames back to Telegram
        stop(): closes the call cleanly

    Pipecat must receive normalized audio frames and must not contain
    Telegram-specific call logic.

This module is where that boundary is drawn. Everything below imports only
the standard library -- no Pipecat, no FastAPI, no Telegram, no Twilio. The
pipeline layer talks to `TransportAdapter` and never learns which carrier is
underneath; the carrier-specific code talks to `NormalizedAudioFrame` and
never learns anything about Pipecat frames.

Why `NormalizedAudioFrame` rather than reusing `protocol.AudioFrame` directly:
the wire type carries bridge concerns (sequence numbers, magic bytes,
protocol version) that a Twilio adapter has no business seeing, and the
adapter type carries codec concerns that the wire type should not have to
model for a carrier that never uses them. Keeping them separate means a
change to the wire protocol cannot ripple into the pipeline.
"""

from __future__ import annotations

import abc
from dataclasses import dataclass
from typing import AsyncIterator, Callable, Awaitable


@dataclass(frozen=True, slots=True)
class NormalizedAudioFrame:
    """One frame of audio in a carrier-independent shape.

    `pcm` is always signed 16-bit little-endian when `encoding == "pcm_s16le"`,
    which is the only encoding the pipeline stage ever receives. Carriers that
    speak something else (mu-law, Opus) decode before constructing this type,
    so that codec work stays in the adapter that owns the carrier's quirks.
    """

    pcm: bytes
    sample_rate: int
    channels: int = 1
    encoding: str = "pcm_s16le"
    #: Monotonic per-session counter, useful for loss metrics and for
    #: correlating a pipeline log line with a carrier-side log line.
    sequence: int = 0
    #: Carrier timestamp in milliseconds, when the carrier provides one.
    timestamp_ms: int = 0

    def __post_init__(self) -> None:
        if self.sample_rate < 1:
            raise ValueError(f"sample_rate must be >= 1, got {self.sample_rate}")
        if self.channels < 1:
            raise ValueError(f"channels must be >= 1, got {self.channels}")

    @property
    def byte_count(self) -> int:
        return len(self.pcm)


class AdapterError(RuntimeError):
    """Base class for fatal adapter failures."""


class AdapterClosed(AdapterError):
    """Raised when using an adapter whose session has already been stopped."""


class TransportAdapter(abc.ABC):
    """A live call leg, viewed as a bidirectional audio stream.

    Lifecycle: `start()` once, then `receiveAudio()` / `sendAudio()` freely,
    then `stop()` exactly once. `stop()` must be idempotent and must never
    raise -- it is called from `finally` blocks and from signal handlers,
    where an exception would mask the real failure or prevent shutdown.
    """

    #: Human-readable carrier name, used in logs and health output. Never
    #: contains secrets or user identifiers.
    carrier: str = "unknown"

    @abc.abstractmethod
    async def start(self) -> None:
        """Begin the session. Must be called before any audio flows."""

    @abc.abstractmethod
    def receiveAudio(self) -> AsyncIterator[NormalizedAudioFrame]:
        """Yield normalized inbound audio frames until the call ends.

        The iterator ends cleanly (rather than raising) when the carrier
        closes the call, because a caller hanging up is a normal event, not
        an error. Anything that *is* an error is raised as an AdapterError.

        Named in camelCase to match the interface the brief specifies.
        """

    @abc.abstractmethod
    async def sendAudio(self, frame: NormalizedAudioFrame) -> None:
        """Send one normalized frame back to the caller.

        Implementations must not block indefinitely: a carrier that has
        stopped reading must cause frames to be dropped or the session to be
        torn down, never a growing queue.
        """

    @abc.abstractmethod
    async def stop(self) -> None:
        """Close the call cleanly. Idempotent. Never raises."""

    # -- optional observability ------------------------------------------

    def stats(self) -> dict[str, object]:
        """Carrier-specific counters, safe to log and to serve over /healthz.

        Must never include audio payloads, credentials, phone numbers, or
        anything else that would be a problem in a Render log.
        """
        return {"carrier": self.carrier}

    async def __aenter__(self) -> "TransportAdapter":
        await self.start()
        return self

    async def __aexit__(self, *exc_info: object) -> None:
        await self.stop()


#: Signature for a stop callback registered with an adapter, so the pipeline
#: can ask the carrier to hang up when the assistant decides the call is over.
HangupCallback = Callable[[str], Awaitable[None]]
