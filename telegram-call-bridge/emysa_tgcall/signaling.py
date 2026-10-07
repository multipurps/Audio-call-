"""MTProto call-signaling layer (transport-agnostic part).

``SignalingBase`` holds *all* call-state logic: the single active call, the
futures that wait for accept/confirm/discard, hangup-vs-setup-failure
classification, and error wrapping. Concrete transports implement only the
thin ``_wire_*`` methods:

* ``pyrogram_signaling.PyrogramSignaling`` - real Telegram user account;
* ``testing.FakeSignaling``                - in-process fake Telegram.

Because both share this base, the tests exercise the same logic that runs in
production; only the wire encoding is swapped.

Message flow (we never compute DH here - the media engine owns it):

  outgoing:  requestCall(g_a_hash) -> phoneCallAccepted(g_b) -> confirmCall(g_a, fp)
                                    -> relay connections + versions
  incoming:  phoneCallRequested(g_a_hash) -> receivedCall -> acceptCall(g_b)
                                    -> phoneCall(g_a, fp, connections, versions)
  both:      sendSignalingData <-> updatePhoneCallSignalingData (media handshake)
             discardCall / phoneCallDiscarded
"""
from __future__ import annotations

import asyncio
import logging
from abc import ABC, abstractmethod
from typing import Any, Awaitable, Callable, Optional

from .errors import BusyError, CallDiscarded, CallTimeout, SignalingError
from .types import (CallProtocol, DhParams, Established, IncomingRequest, ResolvedUser)

log = logging.getLogger(__name__)

IncomingCb = Callable[[IncomingRequest], Awaitable[None]]
SignalingInCb = Callable[[bytes], Awaitable[None]]
HangupCb = Callable[[str], Awaitable[None]]


class SignalingBase(ABC):
    def __init__(self) -> None:
        self._call_id: Optional[int] = None
        self._access_hash: Optional[int] = None
        self._accepted: Optional[asyncio.Future] = None
        self._established: Optional[asyncio.Future] = None
        self._discarded: Optional[asyncio.Future] = None
        self._on_incoming: Optional[IncomingCb] = None
        self._on_signaling_in: Optional[SignalingInCb] = None
        self._on_remote_hangup: Optional[HangupCb] = None

    # ---- wiring ----------------------------------------------------------------

    def set_incoming_callback(self, cb: IncomingCb) -> None:
        self._on_incoming = cb

    def set_signaling_in_callback(self, cb: SignalingInCb) -> None:
        self._on_signaling_in = cb

    def set_remote_hangup_callback(self, cb: HangupCb) -> None:
        self._on_remote_hangup = cb

    @property
    def active_call_id(self) -> Optional[int]:
        return self._call_id

    # ---- transport primitives (implemented by subclasses) ------------------------

    @abstractmethod
    async def _wire_get_dh(self) -> DhParams: ...

    @abstractmethod
    async def _wire_resolve(self, target: Any) -> ResolvedUser: ...

    @abstractmethod
    async def _wire_request(self, user: ResolvedUser, g_a_hash: bytes, protocol: CallProtocol,
                            video: bool) -> tuple[int, int]:
        """-> (call_id, access_hash)"""

    @abstractmethod
    async def _wire_confirm(self, call_id: int, access_hash: int, g_a: bytes, fingerprint: int,
                            protocol: CallProtocol) -> Established: ...

    @abstractmethod
    async def _wire_accept(self, call_id: int, access_hash: int, g_b: bytes,
                           protocol: CallProtocol) -> None: ...

    @abstractmethod
    async def _wire_received(self, call_id: int, access_hash: int) -> None: ...

    @abstractmethod
    async def _wire_discard(self, call_id: int, access_hash: int, reason: str) -> None:
        """reason in {"hangup", "busy", "missed", "disconnect"}"""

    @abstractmethod
    async def _wire_send_signaling(self, call_id: int, access_hash: int, data: bytes) -> None: ...

    # ---- public API -----------------------------------------------------------------

    async def get_dh_config(self) -> DhParams:
        return await self._wire_get_dh()

    async def resolve_user(self, target: Any) -> ResolvedUser:
        return await self._wire_resolve(target)

    async def request_call(self, user: ResolvedUser, g_a_hash: bytes, protocol: CallProtocol,
                           video: bool = False) -> int:
        """Outgoing: send requestCall. Raises BusyError if a call is active."""
        if self._call_id is not None:
            raise BusyError("another call is already active")
        loop = asyncio.get_running_loop()
        # arm waiters *before* the request so an early update cannot be missed
        self._accepted = loop.create_future()
        self._established = None
        self._discarded = loop.create_future()
        try:
            call_id, access_hash = await self._wire_request(user, g_a_hash, protocol, video)
        except BaseException:
            self._accepted = self._discarded = None
            raise
        self._call_id, self._access_hash = call_id, access_hash
        return call_id

    async def wait_accepted(self, timeout: float) -> bytes:
        """Outgoing: block until the callee accepts (-> g_b)."""
        acc, dis = self._accepted, self._discarded
        assert acc is not None and dis is not None, "request_call() first"
        done, _ = await asyncio.wait({acc, dis}, timeout=timeout,
                                     return_when=asyncio.FIRST_COMPLETED)
        if not done:
            raise CallTimeout("timed out waiting for the callee to answer")
        if dis in done:
            reason = dis.result()
            self._clear()          # already dead on Telegram's side: nothing to discard
            raise CallDiscarded(reason)
        return acc.result()

    async def confirm_call(self, g_a: bytes, fingerprint: int, protocol: CallProtocol) -> Established:
        """Outgoing: send confirmCall -> relay connections + negotiated versions."""
        cid, ah = self._require_call()
        return await self._wire_confirm(cid, ah, g_a, fingerprint, protocol)

    def bind_incoming(self, req: IncomingRequest) -> None:
        """Incoming: adopt ``req`` as the active call (arms the discard waiter so a
        caller cancel during setup is noticed)."""
        if self._call_id is not None:
            raise BusyError("another call is already active")
        loop = asyncio.get_running_loop()
        self._call_id, self._access_hash = req.call_id, req.access_hash
        self._accepted = None
        self._established = None
        self._discarded = loop.create_future()

    async def received_call(self) -> None:
        """Incoming: tell Telegram we are ringing."""
        cid, ah = self._require_call()
        try:
            await self._wire_received(cid, ah)
        except SignalingError as e:
            log.debug("receivedCall failed: %s", e)

    async def accept_call(self, g_b: bytes, protocol: CallProtocol) -> None:
        """Incoming: send acceptCall; arms the established waiter."""
        cid, ah = self._require_call()
        self._established = asyncio.get_running_loop().create_future()
        await self._wire_accept(cid, ah, g_b, protocol)

    async def wait_established(self, timeout: float) -> Established:
        """Incoming: block until the caller confirms (phoneCall)."""
        est, dis = self._established, self._discarded
        assert est is not None and dis is not None, "accept_call() first"
        done, _ = await asyncio.wait({est, dis}, timeout=timeout,
                                     return_when=asyncio.FIRST_COMPLETED)
        if not done:
            raise CallTimeout("timed out waiting for the caller to confirm")
        if dis in done:
            reason = dis.result()
            self._clear()
            raise CallDiscarded(reason)
        return est.result()

    async def discard_incoming(self, req: IncomingRequest, busy: bool = False) -> None:
        """Decline an inbound call we will not handle, *without* touching the
        state of any call that is currently active."""
        try:
            await self._wire_discard(req.call_id, req.access_hash, "busy" if busy else "hangup")
        except SignalingError as e:
            log.warning("discard_incoming failed: %s", e)

    async def discard_call(self, reason: str = "hangup") -> None:
        """Hang up the active call (no-op if there is none)."""
        if self._call_id is None:
            return
        cid, ah = self._call_id, self._access_hash
        self._clear()
        try:
            await self._wire_discard(cid, ah or 0, reason)
        except SignalingError as e:
            log.warning("discardCall failed: %s", e)

    async def send_signaling_data(self, data: bytes) -> None:
        """Relay a media-handshake blob to the peer. Failures are logged, never
        fatal: a lost blob is recoverable, a crashed relay task is not."""
        if self._call_id is None:
            return
        try:
            await self._wire_send_signaling(self._call_id, self._access_hash or 0, data)
        except Exception as e:  # noqa: BLE001
            log.warning("sendSignalingData failed: %s", e)

    # ---- delivery: called by the transport when Telegram pushes an update ---------------

    async def deliver_incoming(self, req: IncomingRequest) -> None:
        if self._on_incoming is not None:
            await self._on_incoming(req)

    def deliver_accepted(self, call_id: int, g_b: bytes) -> None:
        if call_id == self._call_id and self._accepted and not self._accepted.done():
            self._accepted.set_result(g_b)

    def deliver_established(self, call_id: int, est: Established) -> None:
        if call_id == self._call_id and self._established and not self._established.done():
            self._established.set_result(est)

    async def deliver_signaling(self, call_id: int, data: bytes) -> None:
        if call_id == self._call_id and self._on_signaling_in is not None:
            await self._on_signaling_in(bytes(data))

    async def deliver_discarded(self, call_id: int, reason: str) -> None:
        if self._call_id is None or call_id != self._call_id:
            return
        pending = ((self._accepted is not None and not self._accepted.done())
                   or (self._established is not None and not self._established.done()))
        if pending and self._discarded is not None and not self._discarded.done():
            # a setup waiter is blocked: let it surface the discard as CallDiscarded
            self._discarded.set_result(reason)
            return
        # call was past setup -> plain remote hangup
        self._clear()
        if self._on_remote_hangup is not None:
            await self._on_remote_hangup(reason)

    # ---- helpers ---------------------------------------------------------------------------

    def _require_call(self) -> tuple[int, int]:
        if self._call_id is None:
            raise SignalingError("no active call")
        return self._call_id, self._access_hash or 0

    def _clear(self) -> None:
        self._call_id = self._access_hash = None
        self._accepted = self._established = self._discarded = None
