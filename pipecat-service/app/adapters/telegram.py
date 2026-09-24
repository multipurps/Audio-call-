"""Telegram call adapter: ACAF bridge <-> `TransportAdapter`.

This is the carrier-specific half of the Telegram path. It knows:
  * that Telegram calls are negotiated by MadelineProto on the PHP side;
  * that the bridge carries PCM16 at a declared rate;
  * that Telegram's own codec is Opus and that **the PHP side owns it**.

It does *not* know about Pipecat, and Pipecat does not know about it -- the
interface in `base.py` is the whole contract. That split is what the brief
requires ("Pipecat must not contain Telegram-specific call logic").

Why Opus is decoded in PHP rather than here
-------------------------------------------
MadelineProto v8 carries a pure-PHP libtgvoip reimplementation and a pure-PHP
OGG Opus muxer, so the PHP side already has to speak Opus for the legacy call
engine -- the engine accepts nothing else for `play()`. Decoding it again in
Python would mean shipping a second codec (plus its native libopus build) into
a service that otherwise needs no codec at all, and would put a
Telegram-specific format inside the Pipecat process. So the bridge carries
PCM16 and PHP converts. This adapter therefore never sees Opus.

The reliability behaviour here -- heartbeats, sequence tracking, reconnect,
backpressure -- lives in `CallSession` and `app/backpressure.py`, shared with
every other carrier, rather than being reimplemented per carrier.
"""

from __future__ import annotations

import asyncio
import contextlib
from typing import AsyncIterator

from loguru import logger

from app.adapters.base import (
    AdapterClosed,
    NormalizedAudioFrame,
    TransportAdapter,
)
from app.protocol import Encoding


class TelegramBridgeAdapter(TransportAdapter):
    """A Telegram call leg, as seen by the assistant pipeline.

    Constructed with an already-connected `AcafBridge` (the WebSocket to the
    PHP relay). Inbound frames are read from the session's inbound path;
    outbound frames are queued onto the session's bounded queue, which is the
    same queue barge-in clears -- see `AcafBridge._outbound` for why that
    identity matters.
    """

    carrier = "telegram"

    def __init__(
        self,
        bridge: "object",
        *,
        inbound_queue_size: int = 50,
    ) -> None:
        self._bridge = bridge
        self._inbound: asyncio.Queue[NormalizedAudioFrame | None] = asyncio.Queue(
            maxsize=inbound_queue_size
        )
        self._started = False
        self._closed = False
        self._dropped_inbound = 0

    # -- lifecycle -------------------------------------------------------

    async def start(self) -> None:
        if self._started:
            return
        self._started = True
        logger.debug(
            "telegram adapter started",
            extra={
                "sessionId": getattr(self._session, "session_id", None),
                "sampleRate": getattr(self._session, "sample_rate", None),
            },
        )

    @property
    def _session(self):
        return getattr(self._bridge, "session", None)

    # -- inbound ---------------------------------------------------------

    def receiveAudio(self) -> AsyncIterator[NormalizedAudioFrame]:  # noqa: N802
        return self._receive()

    async def _receive(self) -> AsyncIterator[NormalizedAudioFrame]:
        """Yield normalized inbound frames until the call ends.

        Ends cleanly on a hangup. A bounded queue is used behind this so a
        burst of inbound audio cannot grow memory without limit; on overflow
        the *oldest* frame is dropped, matching the outbound policy and for
        the same reason -- stale audio has no value.
        """
        while not self._closed:
            item = await self._inbound.get()
            if item is None:  # sentinel: closed
                return
            yield item

    async def push_inbound(self, frame: NormalizedAudioFrame) -> None:
        """Deliver one decoded inbound frame from the bridge."""
        if self._closed:
            return
        try:
            self._inbound.put_nowait(frame)
        except asyncio.QueueFull:
            # Drop oldest, keep newest -- see the docstring.
            with contextlib.suppress(asyncio.QueueEmpty):
                self._inbound.get_nowait()
                self._dropped_inbound += 1
            with contextlib.suppress(asyncio.QueueFull):
                self._inbound.put_nowait(frame)

    # -- outbound --------------------------------------------------------

    async def sendAudio(self, frame: NormalizedAudioFrame) -> None:  # noqa: N802
        """Queue one normalized frame for delivery to Telegram.

        Rejects non-PCM frames rather than sending them: the bridge negotiated
        PCM, and silently forwarding another encoding would produce noise at
        the far end that is very hard to trace back to its source.
        """
        if self._closed:
            raise AdapterClosed("telegram adapter is closed")
        if frame.encoding != "pcm_s16le":
            raise ValueError(
                f"telegram adapter sends pcm_s16le only, got {frame.encoding!r}"
            )
        send = getattr(self._bridge, "send_audio", None)
        if send is None:
            raise AdapterClosed("bridge is not accepting audio")
        await send(frame.pcm)

    # -- teardown --------------------------------------------------------

    async def stop(self) -> None:
        """Close the call cleanly. Idempotent; never raises."""
        if self._closed:
            return
        self._closed = True
        with contextlib.suppress(Exception):
            await self._inbound.put(None)  # wake any waiting reader
        close = getattr(self._bridge, "close", None)
        if callable(close):
            with contextlib.suppress(Exception):
                await close("hung-up")

    def stats(self) -> dict[str, object]:
        base = super().stats()
        base.update(
            {
                "droppedInbound": self._dropped_inbound,
                "inboundQueued": self._inbound.qsize(),
            }
        )
        return base


def decode_acaf_payload(
    payload: bytes, *, encoding: Encoding, sample_rate: int, channels: int
) -> NormalizedAudioFrame:
    """Build a normalized frame from bridge bytes.

    Only PCM reaches this function; the encoding is asserted rather than
    converted, because the conversion belongs where the codec lives (see the
    module docstring).
    """
    if encoding is not Encoding.PCM_S16LE:
        raise ValueError(
            f"telegram bridge carries pcm_s16le only, got {encoding.name}"
        )
    return NormalizedAudioFrame(
        pcm=payload, sample_rate=sample_rate, channels=channels, encoding="pcm_s16le"
    )
