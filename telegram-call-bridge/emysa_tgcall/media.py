"""Media layer: Telegram P2P call media via NTgCalls (WebRTC).

``MediaEngine`` is the interface the call manager uses. ``NTgCallsMedia`` is
the real implementation over the ``ntgcalls`` wheel (the same engine
py-tgcalls uses; we use the engine directly, **not** py-tgcalls).

Facts about the ntgcalls 3.x P2P API, each verified against the installed
wheel and the NTgCalls source (see docs/PHASE5_REPORT.md):

* NTgCalls owns the Diffie-Hellman exchange and the call key. We only shuttle
  public values (g_a_hash / g_b / g_a / fingerprint) over MTProto.
* Audio is an EXTERNAL source/sink, 48 kHz mono s16le, 10 ms frames:
  ``send_external_frame`` (we -> peer) and the ``on_frames`` callback
  (peer -> us, mode PLAYBACK).
* Quirk: the PLAYBACK sink must be declared on the ``microphone`` slot of the
  MediaDescription, not ``speaker``; with ``speaker`` no frames are delivered.
* ``on_signaling_data`` emits opaque ICE/handshake blobs that must be relayed
  with ``phone.sendSignalingData``; the peer's blobs go in through
  ``send_signaling_data``. They may arrive before ``connect_p2p`` has created
  the signaling object, so inbound blobs are queued and replayed in order.
"""
from __future__ import annotations

import asyncio
import logging
from abc import ABC, abstractmethod
from typing import Awaitable, Callable, Optional, Sequence

from .errors import KeyExchangeError, MediaError
from .pcm import SAMPLE_RATE
from .types import AuthParams, CallProtocol, DhParams, MediaState, RelayConnection

log = logging.getLogger(__name__)

try:  # optional at import time so the rest of the package stays importable
    import ntgcalls  # type: ignore
except ImportError:  # pragma: no cover
    ntgcalls = None  # type: ignore

# Measured engine behaviour (raw ntgcalls 3.0.0, no Emysa code; see docs/PHASE5_REPORT.md):
#  * stop() within ~20 ms of connect segfaulted in 2/20 runs; >=100 ms: 0/20.
#  * Back-to-back calls in one process sometimes never delivered the CONNECTED
#    state callback (audio still flowed); a short pause after stop() avoided it
#    in a small sample (0/4 misses at 0.2-0.5 s vs 4/4 misses with no pause).
MIN_LIFETIME_S = 0.25
SETTLE_AFTER_STOP_S = 0.5

FrameCallback = Callable[[bytes], None]
StateCallback = Callable[[MediaState], None]
SignalingSender = Callable[[bytes], Awaitable[None]]


class MediaEngine(ABC):
    """One engine instance == one call."""

    @abstractmethod
    def protocol(self) -> CallProtocol: ...

    @abstractmethod
    def set_callbacks(self, *, on_frame: FrameCallback, on_state: StateCallback,
                      signaling_sender: SignalingSender) -> None:
        """``on_frame`` may be invoked from a foreign thread; ``on_state`` too."""

    @abstractmethod
    async def create_call(self, peer_id: int) -> None: ...

    @abstractmethod
    async def init_exchange(self, dh: DhParams, g_a_hash: Optional[bytes] = None) -> bytes:
        """Outgoing (g_a_hash=None): returns g_a_hash for requestCall.
        Incoming (g_a_hash=caller's): returns g_b for acceptCall."""

    @abstractmethod
    async def exchange_keys(self, g_a_or_b: bytes, fingerprint: int) -> AuthParams:
        """Outgoing: pass (g_b, 0). Incoming: pass (g_a, key_fingerprint)."""

    @abstractmethod
    async def connect(self, relays: Sequence[RelayConnection], versions: Sequence[str],
                      p2p_allowed: bool) -> None: ...

    @abstractmethod
    async def feed_signaling(self, data: bytes) -> None: ...

    @abstractmethod
    async def send_frame(self, frame: bytes) -> None: ...

    @abstractmethod
    async def stop(self) -> None: ...


def build_rtc_servers(relays: Sequence[RelayConnection]) -> list:
    """RelayConnection -> ntgcalls.RTCServer (mapping mirrors tg2sip /
    py-tgcalls: WebRTC relays carry credentials + turn/stun flags; legacy
    phoneConnection relays are UDP reflectors identified by ``peer_tag``)."""
    out = []
    for c in relays:
        if c.webrtc:
            out.append(ntgcalls.RTCServer(c.id, c.ip, c.ipv6, c.port, c.username, c.password,
                                          c.turn, c.stun, False, None))
        else:
            out.append(ntgcalls.RTCServer(c.id, c.ip, c.ipv6, c.port, None, None,
                                          True, False, c.tcp, c.peer_tag))
    return out


class NTgCallsMedia(MediaEngine):
    def __init__(self, ntg: object | None = None):
        if ntgcalls is None:
            raise MediaError("ntgcalls is not installed (pip install ntgcalls==3.0.0)")
        self._ntg = ntg or ntgcalls.NTgCalls()
        self._peer: Optional[int] = None
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._on_frame: Optional[FrameCallback] = None
        self._on_state: Optional[StateCallback] = None
        self._sig_sender: Optional[SignalingSender] = None
        self._sig_out: asyncio.Queue = asyncio.Queue()
        self._sig_in: asyncio.Queue = asyncio.Queue()
        self._tasks: list[asyncio.Task] = []
        self._inflight: set[asyncio.Future] = set()   # native calls still executing
        self._stopped = False
        self._connected_at: Optional[float] = None
        self._frame_data = ntgcalls.FrameData(0, ntgcalls.VideoRotation.VIDEO_ROTATION_0, 0, 0)
        self._ntg.on_frames(self._frames_cb)
        self._ntg.on_connection_change(self._state_cb)
        self._ntg.on_signaling_data(self._signaling_cb)

    # ---- interface -------------------------------------------------------

    def protocol(self) -> CallProtocol:
        p = self._ntg.get_protocol()
        return CallProtocol(p.min_layer, p.max_layer, p.udp_p2p, p.udp_reflector,
                            tuple(p.library_versions))

    def set_callbacks(self, *, on_frame, on_state, signaling_sender) -> None:
        self._on_frame, self._on_state, self._sig_sender = on_frame, on_state, signaling_sender

    async def _guard(self, what: str, aw, exc=MediaError):
        # Run the native call as a tracked task and shield it: if the caller is
        # cancelled (e.g. the pacer at hangup) the native call keeps running, and
        # stop() waits for it. Stopping the engine while a native call is in
        # flight segfaulted intermittently (2/10 runs) before this was added.
        fut = asyncio.ensure_future(aw)
        self._inflight.add(fut)
        fut.add_done_callback(self._inflight.discard)
        try:
            return await asyncio.shield(fut)
        except ntgcalls.BaseRTCException as e:
            raise exc(f"{what}: {type(e).__name__}: {e}") from e

    @staticmethod
    def _audio():
        return ntgcalls.AudioDescription(media_source=ntgcalls.MediaSource.EXTERNAL,
                                         sample_rate=SAMPLE_RATE, channel_count=1,
                                         input="", keep_open=False)

    def _media(self):
        # ntgcalls 3.x MediaDescription has no defaults: pass every slot.
        return ntgcalls.MediaDescription(microphone=self._audio(), speaker=None,
                                         camera=None, screen=None)

    async def create_call(self, peer_id: int) -> None:
        self._loop = asyncio.get_running_loop()
        self._peer = peer_id
        await self._guard("create_p2p_call", self._ntg.create_p2p_call(peer_id))
        # capture side (what we send)
        await self._guard("set_stream_sources(CAPTURE)", self._ntg.set_stream_sources(
            peer_id, ntgcalls.StreamMode.CAPTURE, self._media()))

    async def init_exchange(self, dh: DhParams, g_a_hash: Optional[bytes] = None) -> bytes:
        cfg = ntgcalls.DhConfig(dh.g, dh.p, dh.random)
        return await self._guard("init_exchange",
                                 self._ntg.init_exchange(self._peer, cfg, g_a_hash), KeyExchangeError)

    async def exchange_keys(self, g_a_or_b: bytes, fingerprint: int) -> AuthParams:
        r = await self._guard("exchange_keys",
                              self._ntg.exchange_keys(self._peer, g_a_or_b, fingerprint), KeyExchangeError)
        return AuthParams(bytes(r.g_a_or_b), int(r.key_fingerprint))

    async def connect(self, relays, versions, p2p_allowed: bool) -> None:
        servers = build_rtc_servers(relays)
        await self._guard("connect_p2p", self._ntg.connect_p2p(
            self._peer, servers, list(versions), p2p_allowed, None))
        # playback sink: declared on the *microphone* slot (see module docstring)
        await self._guard("set_stream_sources(PLAYBACK)", self._ntg.set_stream_sources(
            self._peer, ntgcalls.StreamMode.PLAYBACK, self._media()))
        self._connected_at = asyncio.get_running_loop().time()
        self._tasks = [asyncio.create_task(self._pump_out()), asyncio.create_task(self._pump_in())]

    async def feed_signaling(self, data: bytes) -> None:
        self._sig_in.put_nowait(bytes(data))   # replayed by _pump_in once connect() ran

    async def send_frame(self, frame: bytes) -> None:
        if self._stopped or self._peer is None:
            return
        await self._guard("send_external_frame", self._ntg.send_external_frame(
            self._peer, ntgcalls.StreamDevice.MICROPHONE, frame, self._frame_data))

    async def stop(self) -> None:
        if self._stopped:
            return
        self._stopped = True
        for t in self._tasks:
            t.cancel()
        for t in self._tasks:
            try:
                await t
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
        self._tasks = []
        if self._inflight:
            await asyncio.gather(*list(self._inflight), return_exceptions=True)
        if self._peer is not None:
            if self._connected_at is not None:       # engine races if torn down too early
                age = asyncio.get_running_loop().time() - self._connected_at
                if age < MIN_LIFETIME_S:
                    await asyncio.sleep(MIN_LIFETIME_S - age)
            try:
                await self._ntg.stop(self._peer)
            except Exception as e:  # noqa: BLE001
                log.warning("ntgcalls stop failed: %s", e)
            if self._connected_at is not None:
                await asyncio.sleep(SETTLE_AFTER_STOP_S)

    # ---- ntgcalls callbacks (foreign threads) -----------------------------

    def _frames_cb(self, _chat_id, mode, _device, frames) -> None:
        if mode != ntgcalls.StreamMode.PLAYBACK or self._on_frame is None:
            return
        for f in frames:
            if f.data:
                self._on_frame(bytes(f.data))

    def _state_cb(self, _chat_id, info) -> None:
        name = getattr(getattr(info, "state", info), "name", str(info))
        try:
            st = MediaState(name)
        except ValueError:
            return
        if self._on_state is not None and self._loop is not None:
            self._loop.call_soon_threadsafe(self._on_state, st)

    def _signaling_cb(self, _chat_id, data) -> None:
        if self._loop is not None:
            self._loop.call_soon_threadsafe(self._sig_out.put_nowait, bytes(data))

    # ---- pumps (ordered relay in both directions) --------------------------

    async def _pump_out(self) -> None:
        while True:
            data = await self._sig_out.get()
            if self._sig_sender is None:
                continue
            try:
                await self._sig_sender(data)
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001
                log.warning("signaling out failed: %s", e)

    async def _pump_in(self) -> None:
        while True:
            data = await self._sig_in.get()
            try:
                await self._guard("send_signaling_data", self._ntg.send_signaling_data(self._peer, data))
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001
                log.warning("signaling in failed: %s", e)
