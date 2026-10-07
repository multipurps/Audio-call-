"""Call manager: one private Telegram call at a time.

States:  IDLE -> (REQUESTING -> RINGING_OUT | RINGING_IN) -> EXCHANGING_KEYS
         -> CONNECTING -> ACTIVE -> ENDING -> IDLE

Rules
* **One call at a time.** A second inbound request while not IDLE is declined
  with reason *busy* (the active call is untouched). ``place_call`` while not
  IDLE raises ``BusyError``.
* **Incoming calls are denied unless the accept policy allows the caller.**
  Default policy: deny everyone. Use ``AllowList({...})``.
* Video call requests are declined (audio only in this phase).
* Teardown is idempotent and shielded from cancellation: whichever of local
  hangup / remote hangup / media failure / setup error happens first wins and
  every later trigger just awaits the same teardown.
"""
from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Iterable, Optional

from .adapter import AudioAdapter
from .bridge import PcmBridge
from .errors import (BusyError, CallDiscarded, CallFailed, CallTimeout, KeyExchangeError,
                     MediaError, SignalingError)
from .media import MediaEngine
from .signaling import SignalingBase
from .types import CallEnd, CallInfo, CallState, Direction, IncomingRequest, MediaState

log = logging.getLogger(__name__)

AcceptPolicy = Callable[[IncomingRequest], Awaitable[bool]]


async def deny_all(_req: IncomingRequest) -> bool:
    return False


async def accept_all(_req: IncomingRequest) -> bool:
    """Explicit opt-in; intended for tests and closed lab setups only."""
    return True


class AllowList:
    def __init__(self, user_ids: Iterable[int]):
        self._ids = {int(u) for u in user_ids}

    async def __call__(self, req: IncomingRequest) -> bool:
        return req.caller_id in self._ids


@dataclass
class ManagerConfig:
    answer_timeout: float = 60.0         # outgoing: callee must accept within this
    key_exchange_timeout: float = 20.0   # incoming: caller must confirm within this
    connect_timeout: float = 20.0        # media must reach CONNECTED within this
    decline_video_requests: bool = True
    max_outbound_ms: float = 15_000.0


class _Call:
    def __init__(self, direction: Direction, peer_id: Optional[int] = None):
        self.direction = direction
        self.peer_id = peer_id
        self.call_id: Optional[int] = None
        self.media: Optional[MediaEngine] = None
        self.adapter: Optional[AudioAdapter] = None
        self.bridge: Optional[PcmBridge] = None
        self.task: Optional[asyncio.Task] = None
        self.teardown_task: Optional[asyncio.Task] = None
        self.abort: Optional[tuple[str, Optional[str]]] = None
        self.connected = asyncio.Event()
        self.media_failure: Optional[str] = None
        self.stage = "init"
        self.setup_done = False
        self.info: Optional[CallInfo] = None


# reasons for which we tell Telegram "disconnect"/"missed" instead of "hangup"
_DISCONNECT_REASONS = {"key_exchange_failed", "media_failed", "media_timeout", "media_closed",
                       "connect_timeout", "key_exchange_timeout", "internal_error"}


class CallManager:
    def __init__(self, signaling: SignalingBase, media_factory: Callable[[], MediaEngine],
                 adapter_factory: Callable[[], AudioAdapter], *,
                 accept_policy: AcceptPolicy = deny_all, config: Optional[ManagerConfig] = None):
        self._sig = signaling
        self._media_factory = media_factory
        self._adapter_factory = adapter_factory
        self._policy = accept_policy
        self.cfg = config or ManagerConfig()
        self._cond = asyncio.Condition()
        self._state = CallState.IDLE
        self._call: Optional[_Call] = None
        self._bg: set[asyncio.Task] = set()
        self.history: list[CallEnd] = []

    # ---- introspection -------------------------------------------------------------

    @property
    def state(self) -> CallState:
        return self._state

    @property
    def call_info(self) -> Optional[CallInfo]:
        return self._call.info if self._call else None

    @property
    def bridge(self) -> Optional[PcmBridge]:
        return self._call.bridge if self._call else None

    @property
    def last_end(self) -> Optional[CallEnd]:
        return self.history[-1] if self.history else None

    async def wait_state(self, state: CallState, timeout: float = 10.0) -> None:
        async with self._cond:
            await asyncio.wait_for(self._cond.wait_for(lambda: self._state is state), timeout)

    # ---- lifecycle -------------------------------------------------------------------

    async def start(self) -> None:
        self._sig.set_incoming_callback(self._on_incoming_request)
        self._sig.set_signaling_in_callback(self._on_signaling_in)
        self._sig.set_remote_hangup_callback(self._on_remote_hangup)

    async def place_call(self, target: Any) -> CallInfo:
        """Outgoing private call. Returns once the call is ACTIVE; raises
        ``BusyError`` if a call exists, ``CallFailed(reason)`` otherwise."""
        async with self._cond:
            if self._state is not CallState.IDLE:
                raise BusyError(f"cannot place a call while {self._state.value}")
            call = _Call(Direction.OUTGOING)
            self._call = call
            self._state = CallState.REQUESTING
            self._cond.notify_all()
        call.task = asyncio.create_task(self._run_outgoing(call, target), name="tg-out")
        return await call.task

    async def hangup(self, reason: str = "local_hangup") -> None:
        call = self._call
        if call is not None:
            await self._abort(call, reason)

    # ---- outgoing ---------------------------------------------------------------------

    async def _run_outgoing(self, call: _Call, target: Any) -> CallInfo:
        try:
            call.stage = "request"
            user = await self._sig.resolve_user(target)
            await self._prepare_media(call, user.user_id)
            media = call.media
            assert media is not None
            dh = await self._sig.get_dh_config()
            proto = media.protocol()
            g_a_hash = await media.init_exchange(dh, None)
            call.call_id = await self._sig.request_call(user, g_a_hash, proto, video=False)
            await self._set_state(call, CallState.RINGING_OUT)
            call.stage = "answer"
            g_b = await self._sig.wait_accepted(self.cfg.answer_timeout)
            await self._set_state(call, CallState.EXCHANGING_KEYS)
            call.stage = "key_exchange"
            auth = await media.exchange_keys(g_b, 0)
            est = await self._sig.confirm_call(auth.g_a_or_b, auth.key_fingerprint, proto)
            call.stage = "connect"
            return await self._connect_media(call, est)
        except asyncio.CancelledError:
            if call.abort:
                reason, detail = call.abort
                await self._teardown(call, reason, detail)
                raise CallFailed(reason, detail)
            await self._teardown(call, "cancelled")
            raise
        except Exception as e:  # noqa: BLE001
            reason, detail = self._classify(call, e)
            await self._teardown(call, reason, detail)
            raise CallFailed(reason, detail) from e

    # ---- incoming ----------------------------------------------------------------------

    async def _on_incoming_request(self, req: IncomingRequest) -> None:
        async with self._cond:
            busy = self._state is not CallState.IDLE
            if not busy:
                call = _Call(Direction.INCOMING, req.caller_id)
                call.call_id = req.call_id
                self._call = call
                self._state = CallState.RINGING_IN
                self._cond.notify_all()
        if busy:
            log.info("declining call from %s: busy", req.caller_id)
            await self._sig.discard_incoming(req, busy=True)
            self.history.append(CallEnd("busy_rejected", Direction.INCOMING, req.call_id, req.caller_id))
            return
        call.task = asyncio.create_task(self._run_incoming(call, req), name="tg-in")
        self._bg.add(call.task)
        call.task.add_done_callback(self._bg.discard)

    async def _run_incoming(self, call: _Call, req: IncomingRequest) -> None:
        try:
            call.stage = "policy"
            if req.video and self.cfg.decline_video_requests:
                await self._sig.discard_incoming(req)
                await self._teardown(call, "video_not_supported")
                return
            try:
                allowed = await self._policy(req)
            except Exception:  # noqa: BLE001
                log.exception("accept policy raised; denying")
                allowed = False
            if not allowed:
                await self._sig.discard_incoming(req)
                await self._teardown(call, "not_allowed")
                return
            self._sig.bind_incoming(req)
            await self._sig.received_call()
            await self._prepare_media(call, req.caller_id)
            media = call.media
            assert media is not None
            dh = await self._sig.get_dh_config()
            proto = media.protocol()
            g_b = await media.init_exchange(dh, req.g_a_hash)
            call.stage = "key_exchange"
            await self._sig.accept_call(g_b, proto)
            await self._set_state(call, CallState.EXCHANGING_KEYS)
            est = await self._sig.wait_established(self.cfg.key_exchange_timeout)
            await media.exchange_keys(est.g_a_or_b, est.key_fingerprint)
            call.stage = "connect"
            await self._connect_media(call, est)
        except asyncio.CancelledError:
            reason, detail = call.abort or ("cancelled", None)
            await self._teardown(call, reason, detail)
        except Exception as e:  # noqa: BLE001
            reason, detail = self._classify(call, e)
            await self._teardown(call, reason, detail)

    # ---- shared steps -------------------------------------------------------------------

    async def _prepare_media(self, call: _Call, peer_id: int) -> None:
        call.peer_id = peer_id
        media = self._media_factory()
        adapter = self._adapter_factory()
        bridge = PcmBridge(media, adapter, max_outbound_ms=self.cfg.max_outbound_ms)
        media.set_callbacks(on_frame=bridge.on_media_frame,
                            on_state=lambda s, c=call: self._on_media_state(c, s),
                            signaling_sender=self._sig.send_signaling_data)
        call.media, call.adapter, call.bridge = media, adapter, bridge
        await media.create_call(peer_id)

    async def _connect_media(self, call: _Call, est) -> CallInfo:
        assert call.media is not None and call.bridge is not None
        await self._set_state(call, CallState.CONNECTING)
        await call.media.connect(est.connections, est.library_versions, est.p2p_allowed)
        try:
            await asyncio.wait_for(call.connected.wait(), self.cfg.connect_timeout)
        except asyncio.TimeoutError:
            raise CallTimeout("media did not reach CONNECTED in time") from None
        if call.media_failure:
            raise MediaError(call.media_failure)
        call.info = CallInfo(call_id=call.call_id or 0, peer_id=call.peer_id or 0,
                             direction=call.direction, library_versions=tuple(est.library_versions))
        await call.bridge.start(call.info)
        call.setup_done = True
        await self._set_state(call, CallState.ACTIVE)
        return call.info

    async def _set_state(self, call: _Call, state: CallState) -> None:
        async with self._cond:
            if call.teardown_task is not None or self._call is not call:
                return                      # never resurrect a call that is ending
            self._state = state
            self._cond.notify_all()

    # ---- events from signaling / media ---------------------------------------------------

    async def _on_signaling_in(self, data: bytes) -> None:
        call = self._call
        if call is not None and call.media is not None and call.teardown_task is None:
            await call.media.feed_signaling(data)

    async def _on_remote_hangup(self, reason: str) -> None:
        call = self._call
        if call is not None and call.teardown_task is None:
            self._spawn(self._abort(call, "remote_hangup", reason))

    def _on_media_state(self, call: _Call, state: MediaState) -> None:
        """Runs on the event loop (engines marshal their callbacks)."""
        if call.teardown_task is not None:
            return
        if state is MediaState.CONNECTED:
            call.connected.set()
        elif state in (MediaState.FAILED, MediaState.TIMEOUT):
            call.media_failure = f"media {state.value}"
            call.connected.set()
            if call.setup_done:
                self._spawn(self._abort(call, "media_failed" if state is MediaState.FAILED
                                        else "media_timeout", call.media_failure))
        elif state is MediaState.CLOSED and call.setup_done:
            self._spawn(self._abort(call, "media_closed"))

    def _spawn(self, coro) -> None:
        t = asyncio.ensure_future(coro)
        self._bg.add(t)
        t.add_done_callback(self._bg.discard)

    # ---- abort / teardown --------------------------------------------------------------------

    async def _abort(self, call: _Call, reason: str, detail: Optional[str] = None) -> None:
        if call.abort is None:
            call.abort = (reason, detail)
        t = call.task
        if (t is not None and not t.done() and not call.setup_done
                and t is not asyncio.current_task()):
            t.cancel()                       # its CancelledError handler tears down
            await asyncio.wait({t})
        else:
            await self._teardown(call, *call.abort)

    async def _teardown(self, call: _Call, reason: str, detail: Optional[str] = None) -> None:
        if call.teardown_task is None:
            call.teardown_task = asyncio.ensure_future(self._do_teardown(call, reason, detail))
        await asyncio.shield(call.teardown_task)

    async def _do_teardown(self, call: _Call, reason: str, detail: Optional[str]) -> None:
        async with self._cond:
            self._state = CallState.ENDING
            self._cond.notify_all()
        try:
            if call.bridge is not None:
                await call.bridge.stop(reason)
        except Exception:  # noqa: BLE001
            log.exception("bridge stop failed")
        try:
            await self._sig.discard_call("disconnect" if reason in _DISCONNECT_REASONS else
                                         "missed" if reason == "timeout" else "hangup")
        except Exception:  # noqa: BLE001
            log.exception("discard_call failed")
        try:
            if call.media is not None:
                await call.media.stop()
        except Exception:  # noqa: BLE001
            log.exception("media stop failed")
        async with self._cond:
            self.history.append(CallEnd(reason, call.direction, call.call_id, call.peer_id, detail))
            self._call = None
            self._state = CallState.IDLE
            self._cond.notify_all()

    def _classify(self, call: _Call, e: BaseException) -> tuple[str, Optional[str]]:
        if call.abort:
            return call.abort
        if isinstance(e, CallDiscarded):
            if e.reason == "hangup":
                return ("declined" if call.direction is Direction.OUTGOING else "caller_cancelled"), None
            return e.reason, None
        if isinstance(e, CallTimeout):
            return ("timeout" if call.stage == "answer" else f"{call.stage}_timeout"), str(e)
        if isinstance(e, SignalingError):
            return "signaling_error", e.code or str(e)
        if isinstance(e, KeyExchangeError):
            return "key_exchange_failed", str(e)
        if isinstance(e, MediaError):
            return "media_failed", str(e)
        log.exception("unexpected error in call setup (stage=%s)", call.stage)
        return "internal_error", f"{type(e).__name__}: {e}"
