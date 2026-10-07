"""PCM bridge between a MediaEngine and an AudioAdapter.

            media thread                         event loop
  peer ──► MediaEngine.on_frame ──► on_media_frame() ──► rx queue ──► adapter.on_caller_audio()

  adapter ──► send_pcm() ──► outbound buffer ──► pacer (every 10 ms) ──► MediaEngine.send_frame()

* Inbound frames are re-chunked to exactly 960 bytes and handed to the adapter
  on the event loop (the media callback arrives on a foreign thread).
* Outbound audio is buffered and **paced at 100 frames/s** regardless of how
  bursty the producer is. While the buffer is empty a silence frame is sent
  (``send_silence=True``) so the stream cadence stays steady.
* The outbound buffer is bounded; on overflow the *oldest* audio is dropped.
"""
from __future__ import annotations

import asyncio
import logging
from typing import Optional

from .adapter import AudioAdapter
from .media import MediaEngine
from .pcm import FRAME_BYTES, FRAME_MS, SILENCE_FRAME, FrameChunker, bytes_to_ms, ms_to_bytes
from .types import CallInfo

log = logging.getLogger(__name__)


class PcmBridge:
    def __init__(self, media: MediaEngine, adapter: AudioAdapter, *,
                 max_outbound_ms: float = 15_000, rx_queue_frames: int = 500,
                 send_silence: bool = True):
        self._media = media
        self._adapter = adapter
        self._max_out = ms_to_bytes(max_outbound_ms)
        self._rx_cap = rx_queue_frames
        self._send_silence = send_silence
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._running = False
        self._rx_chunker = FrameChunker()
        self._rx_q: asyncio.Queue = asyncio.Queue()
        self._out = bytearray()
        self._tasks: list[asyncio.Task] = []
        self._ended = False
        self._started = False
        # stats
        self.rx_frames = 0
        self.rx_dropped = 0
        self.tx_frames = 0
        self.tx_silence_frames = 0
        self.tx_errors = 0
        self.tx_dropped_bytes = 0
        self.late_resyncs = 0

    # ---- PcmSink (adapter-facing) ----------------------------------------

    def send_pcm(self, pcm: bytes) -> None:
        if not pcm or self._ended:
            return
        self._out.extend(pcm)
        over = len(self._out) - self._max_out
        if over > 0:
            del self._out[:over]
            self.tx_dropped_bytes += over

    def clear_outbound(self) -> int:
        n = len(self._out)
        self._out.clear()
        return n

    @property
    def outbound_backlog_ms(self) -> float:
        return bytes_to_ms(len(self._out))

    @property
    def running(self) -> bool:
        return self._running

    # ---- media-facing (may be called from any thread) ----------------------

    def on_media_frame(self, pcm: bytes) -> None:
        if not self._running or self._loop is None:
            return
        try:
            self._loop.call_soon_threadsafe(self._enqueue_rx, pcm)
        except RuntimeError:  # loop closed during shutdown
            pass

    def _enqueue_rx(self, pcm: bytes) -> None:
        if not self._running:
            return
        for frame in self._rx_chunker.push(pcm):
            if self._rx_q.qsize() >= self._rx_cap:
                try:
                    self._rx_q.get_nowait()
                    self.rx_dropped += 1
                except asyncio.QueueEmpty:
                    pass
            self._rx_q.put_nowait(frame)

    # ---- lifecycle -----------------------------------------------------------

    async def start(self, info: CallInfo) -> None:
        self._loop = asyncio.get_running_loop()
        self._running = True
        self._started = True
        await self._adapter.on_call_start(info, self)
        self._tasks = [asyncio.create_task(self._rx_loop(), name="pcm-rx"),
                       asyncio.create_task(self._tx_loop(), name="pcm-tx")]

    async def stop(self, reason: str) -> None:
        if self._ended:
            return
        self._ended = True
        self._running = False
        for t in self._tasks:
            t.cancel()
        for t in self._tasks:
            try:
                await t
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
        self._tasks = []
        if not self._started:
            return
        try:
            await self._adapter.on_call_end(reason)
        except Exception:  # noqa: BLE001
            log.exception("adapter.on_call_end raised")

    # ---- pumps ----------------------------------------------------------------

    async def _rx_loop(self) -> None:
        while True:
            frame = await self._rx_q.get()
            self.rx_frames += 1
            try:
                await self._adapter.on_caller_audio(frame)
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001 - a buggy adapter must not kill the call
                log.exception("adapter.on_caller_audio raised")

    def _pop_out_frame(self) -> Optional[bytes]:
        if len(self._out) >= FRAME_BYTES:
            frame = bytes(self._out[:FRAME_BYTES])
            del self._out[:FRAME_BYTES]
            return frame
        if self._out:  # trailing partial frame: pad so the tail is not lost
            frame = bytes(self._out) + bytes(FRAME_BYTES - len(self._out))
            self._out.clear()
            return frame
        return None

    async def _tx_loop(self) -> None:
        loop = asyncio.get_running_loop()
        period = FRAME_MS / 1000.0
        next_t = loop.time()
        while True:
            frame = self._pop_out_frame()
            if frame is None and self._send_silence:
                frame, silent = SILENCE_FRAME, True
            else:
                silent = False
            if frame is not None:
                try:
                    await self._media.send_frame(frame)
                    self.tx_frames += 1
                    self.tx_silence_frames += silent
                except asyncio.CancelledError:
                    raise
                except Exception as e:  # noqa: BLE001
                    self.tx_errors += 1
                    if self.tx_errors in (1, 10, 100) or self.tx_errors % 1000 == 0:
                        log.warning("send_frame failed (%d so far): %s", self.tx_errors, e)
            next_t += period
            delay = next_t - loop.time()
            if delay > 0:
                await asyncio.sleep(delay)
            elif delay < -0.25:      # fell badly behind: resync instead of bursting
                self.late_resyncs += 1
                next_t = loop.time()
                await asyncio.sleep(0)
            else:
                await asyncio.sleep(0)
