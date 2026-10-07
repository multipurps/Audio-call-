"""Test doubles: a fake Telegram signaling hub and a fake media fabric.

``FakeTelegramHub`` plays the role of Telegram's servers for *call signaling
only*: it routes requestCall / acceptCall / confirmCall / discardCall /
signaling blobs between ``FakeSignaling`` endpoints (one per fake user).
``FakeSignaling`` subclasses the real ``SignalingBase``, so all call-state
logic under test is the production code; only the wire is faked.

What this does NOT model: Telegram privacy settings, rate limits, relay
servers, real RPC error behaviour, or protocol-version rejection by servers.
Those can only be checked against live Telegram.

``FakeMedia`` is a crude stand-in for NTgCalls (no crypto, no network) used
for fast state-machine tests. The real engine is exercised separately in
tests/test_real_ntgcalls.py.
"""
from __future__ import annotations

import asyncio
import hashlib
import logging
import os
from typing import Any, Callable, Optional, Sequence

from .errors import KeyExchangeError, MediaError, SignalingError
from .media import MediaEngine
from .signaling import SignalingBase
from .types import (AuthParams, CallProtocol, DhParams, Established, IncomingRequest, MediaState,
                    RelayConnection, ResolvedUser)

log = logging.getLogger(__name__)

# MTProto's DH prime (2048-bit safe prime; primality of p and (p-1)/2 was
# checked with Miller-Rabin when this prototype was built). g = 3.
TELEGRAM_DH_PRIME_HEX = (
    "C71CAEB9C6B1C9048E6C522F70F13F73980D40238E3E21C14934D037563D930F48198A0AA7C14058229493D22530F4DB"
    "FA336F6E0AC925139543AED44CCE7C3720FD51F69458705AC68CD4FE6B6B13ABDC9746512969328454F18FAF8C595F64"
    "2477FE96BB2A941D5BCD1D4AC8CC49880708FA9B378E3C4F3A9060BEE67CF9A4A4A695811051907E162753B56B0F6B41"
    "0DBA74D8A84B2A14B3144E0EF1284754FD17ED950D5965B4B9DD46582DB1178D169C6BC465B0D6FF9CA3928FEF5B9AE4"
    "E418FC15E83EBEA0F87FA9FF5EED70050DED2849F47BF959D956850CE929851F0D8115F635B105EE2E4E15D04B2454BF"
    "6F4FADF034B10403119CD8E3B92FCC5B")
TELEGRAM_DH_PRIME = bytes.fromhex(TELEGRAM_DH_PRIME_HEX)


class _HubCall:
    def __init__(self, call_id: int, caller: int, callee: int, g_a_hash: bytes,
                 proto: CallProtocol, video: bool):
        self.id, self.caller, self.callee = call_id, caller, callee
        self.g_a_hash, self.caller_proto, self.video = g_a_hash, proto, video
        self.callee_proto: Optional[CallProtocol] = None
        self.g_b: Optional[bytes] = None
        self.state = "requested"      # requested -> accepted -> confirmed ; any -> discarded


class FakeTelegramHub:
    def __init__(self) -> None:
        self._eps: dict[int, "FakeSignaling"] = {}
        self._calls: dict[int, _HubCall] = {}
        self._next_id = 1000
        self._tasks: set[asyncio.Task] = set()
        self.wire_log: list[tuple] = []
        # failure injection -------------------------------------------------
        self.fail_next: dict[str, SignalingError] = {}   # op -> error raised once
        self.drop_signaling = False                       # swallow media handshake blobs
        self.tamper_g_a = False                           # flip a bit of g_a at confirmCall
        self.signaling_blobs = 0

    def endpoint(self, user_id: int) -> "FakeSignaling":
        ep = FakeSignaling(self, user_id)
        self._eps[user_id] = ep
        return ep

    def discards(self) -> list[tuple]:
        return [e for e in self.wire_log if e[0] == "discard"]

    def _spawn(self, coro) -> None:
        t = asyncio.ensure_future(coro)
        self._tasks.add(t)
        t.add_done_callback(self._tasks.discard)

    def _maybe_fail(self, op: str) -> None:
        err = self.fail_next.pop(op, None)
        if err is not None:
            raise err

    def _call(self, call_id: int) -> _HubCall:
        c = self._calls.get(call_id)
        if c is None or c.state == "discarded":
            raise SignalingError("call already declined or unknown", code="CALL_ALREADY_DECLINED")
        return c

    # ---- operations used by FakeSignaling -------------------------------------------

    async def request(self, uid: int, target: int, g_a_hash: bytes, proto: CallProtocol, video: bool):
        self._maybe_fail("request")
        if target not in self._eps:
            raise SignalingError("user not found", code="PEER_ID_INVALID")
        self._next_id += 1
        c = _HubCall(self._next_id, uid, target, g_a_hash, proto, video)
        self._calls[c.id] = c
        self.wire_log.append(("request", c.id, uid, target))
        self._spawn(self._eps[target].deliver_incoming(
            IncomingRequest(c.id, c.id * 7, uid, g_a_hash, video)))
        return c.id, c.id * 7

    async def received(self, uid: int, call_id: int) -> None:
        self._maybe_fail("received")
        self.wire_log.append(("received", call_id, uid))

    async def accept(self, uid: int, call_id: int, g_b: bytes, proto: CallProtocol) -> None:
        self._maybe_fail("accept")
        c = self._call(call_id)
        if c.callee != uid or c.state != "requested":
            raise SignalingError("bad accept", code="CALL_PEER_INVALID")
        c.g_b, c.callee_proto, c.state = g_b, proto, "accepted"
        self.wire_log.append(("accept", call_id, uid))
        self._spawn_deliver(c.caller, lambda ep: ep.deliver_accepted(call_id, g_b))

    def _spawn_deliver(self, uid: int, fn: Callable[["FakeSignaling"], Any]) -> None:
        async def run():
            r = fn(self._eps[uid])
            if asyncio.iscoroutine(r):
                await r
        self._spawn(run())

    async def confirm(self, uid: int, call_id: int, g_a: bytes, fp: int, proto: CallProtocol) -> Established:
        self._maybe_fail("confirm")
        c = self._call(call_id)
        if c.caller != uid or c.state != "accepted":
            raise SignalingError("bad confirm", code="CALL_PEER_INVALID")
        offered = [v for v in (c.callee_proto.library_versions if c.callee_proto else ())
                   if v in proto.library_versions]
        if not offered:
            raise SignalingError("no common protocol version", code="CALL_PROTOCOL_COMPAT_LAYER_INVALID")
        versions = tuple(sorted(offered, key=lambda v: tuple(int(x) for x in v.split(".")), reverse=True))
        if self.tamper_g_a:
            b = bytearray(g_a)
            b[7] ^= 0x01
            g_a = bytes(b)
        c.state = "confirmed"
        self.wire_log.append(("confirm", call_id, uid))
        est_callee = Established(g_a, fp, (), versions, True)
        self._spawn_deliver(c.callee, lambda ep: ep.deliver_established(call_id, est_callee))
        return Established(c.g_b or b"", fp, (), versions, True)

    async def discard(self, uid: int, call_id: int, reason: str) -> None:
        self._maybe_fail("discard")
        c = self._call(call_id)
        c.state = "discarded"
        self.wire_log.append(("discard", call_id, uid, reason))
        other = c.callee if uid == c.caller else c.caller
        self._spawn_deliver(other, lambda ep: ep.deliver_discarded(call_id, reason))

    async def signaling(self, uid: int, call_id: int, data: bytes) -> None:
        self._maybe_fail("signaling")
        c = self._calls.get(call_id)
        if c is None or c.state == "discarded":
            raise SignalingError("call gone", code="CALL_ALREADY_DECLINED")
        self.signaling_blobs += 1
        if self.drop_signaling:
            return
        other = c.callee if uid == c.caller else c.caller
        self._spawn_deliver(other, lambda ep: ep.deliver_signaling(call_id, data))

    async def drain(self, rounds: int = 5) -> None:
        for _ in range(rounds):
            await asyncio.sleep(0)
            if self._tasks:
                await asyncio.wait(set(self._tasks), timeout=1.0)


class FakeSignaling(SignalingBase):
    def __init__(self, hub: FakeTelegramHub, user_id: int):
        super().__init__()
        self.hub, self.user_id = hub, user_id

    async def _wire_get_dh(self) -> DhParams:
        self.hub._maybe_fail("get_dh")
        return DhParams(3, TELEGRAM_DH_PRIME, os.urandom(256))

    async def _wire_resolve(self, target: Any) -> ResolvedUser:
        uid = int(str(target).lstrip("@")) if str(target).lstrip("@").isdigit() else None
        if uid is None or uid not in self.hub._eps:
            raise SignalingError(f"cannot resolve {target!r}", code="USERNAME_NOT_OCCUPIED")
        return ResolvedUser(uid)

    async def _wire_request(self, user, g_a_hash, protocol, video):
        return await self.hub.request(self.user_id, user.user_id, g_a_hash, protocol, video)

    async def _wire_confirm(self, call_id, access_hash, g_a, fingerprint, protocol):
        return await self.hub.confirm(self.user_id, call_id, g_a, fingerprint, protocol)

    async def _wire_accept(self, call_id, access_hash, g_b, protocol):
        await self.hub.accept(self.user_id, call_id, g_b, protocol)

    async def _wire_received(self, call_id, access_hash):
        await self.hub.received(self.user_id, call_id)

    async def _wire_discard(self, call_id, access_hash, reason):
        await self.hub.discard(self.user_id, call_id, reason)

    async def _wire_send_signaling(self, call_id, access_hash, data):
        await self.hub.signaling(self.user_id, call_id, data)


# --------------------------------------------------------------------------------
# fake media
# --------------------------------------------------------------------------------

class FakeMediaFabric:
    """Connects two FakeMedia instances: frames sent by one arrive at the other."""

    def __init__(self) -> None:
        self.instances: list["FakeMedia"] = []
        self.fail_at: dict[int, str] = {}                  # user id -> op name that raises MediaError
        self.state_instead: dict[int, MediaState] = {}     # user id -> state emitted instead of CONNECTED
        self.stopped: list[int] = []

    def factory(self, self_id: int) -> Callable[[], "FakeMedia"]:
        return lambda: FakeMedia(self, self_id)

    def of(self, self_id: int) -> "FakeMedia":
        return [m for m in self.instances if m.self_id == self_id][-1]

    def _peer_of(self, m: "FakeMedia") -> Optional["FakeMedia"]:
        for o in reversed(self.instances):
            if o is not m and o.self_id == m.peer_id and o.peer_id == m.self_id and not o.stopped:
                return o
        return None

    def _maybe_connected(self, m: "FakeMedia") -> None:
        p = self._peer_of(m)
        if p is not None and m.connect_called and p.connect_called:
            for x in (m, p):
                x._emit(self.state_instead.get(x.self_id, MediaState.CONNECTED))


class FakeMedia(MediaEngine):
    def __init__(self, fabric: FakeMediaFabric, self_id: int):
        self.fabric, self.self_id = fabric, self_id
        self.peer_id: Optional[int] = None
        self.connect_called = False
        self.stopped = False
        self.sent_frames = 0
        self.fed_signaling: list[bytes] = []
        self._on_frame = self._on_state = self._sig_sender = None
        self._g_a = self._g_b = self._expect = None
        self._incoming = False
        fabric.instances.append(self)

    def protocol(self) -> CallProtocol:
        return CallProtocol(92, 92, True, True, ("9.0.0",))

    def set_callbacks(self, *, on_frame, on_state, signaling_sender) -> None:
        self._on_frame, self._on_state, self._sig_sender = on_frame, on_state, signaling_sender

    def _maybe_fail(self, op: str) -> None:
        if self.fabric.fail_at.get(self.self_id) == op:
            raise (KeyExchangeError if op in ("init_exchange", "exchange_keys") else MediaError)(
                f"injected failure at {op}")

    def _emit(self, st: MediaState) -> None:
        if self._on_state is not None and not self.stopped:
            asyncio.get_running_loop().call_soon(self._on_state, st)

    async def create_call(self, peer_id: int) -> None:
        self._maybe_fail("create_call")
        self.peer_id = peer_id

    async def init_exchange(self, dh: DhParams, g_a_hash: Optional[bytes] = None) -> bytes:
        self._maybe_fail("init_exchange")
        if g_a_hash is None:
            self._g_a = os.urandom(32)
            return hashlib.sha256(self._g_a).digest()
        self._incoming, self._expect, self._g_b = True, g_a_hash, os.urandom(32)
        return self._g_b

    async def exchange_keys(self, g_a_or_b: bytes, fingerprint: int) -> AuthParams:
        self._maybe_fail("exchange_keys")
        if self._incoming:
            if hashlib.sha256(g_a_or_b).digest() != self._expect:
                raise KeyExchangeError("Hash mismatch")
            return AuthParams(self._g_b or b"", fingerprint)
        return AuthParams(self._g_a or b"", 0x1234)

    async def connect(self, relays: Sequence[RelayConnection], versions: Sequence[str],
                      p2p_allowed: bool) -> None:
        self._maybe_fail("connect")
        self.connect_called = True
        self.versions = tuple(versions)
        self.fabric._maybe_connected(self)

    async def feed_signaling(self, data: bytes) -> None:
        self.fed_signaling.append(data)

    async def send_frame(self, frame: bytes) -> None:
        if self.stopped:
            return
        peer = self.fabric._peer_of(self)
        if peer is not None and peer.connect_called and peer._on_frame is not None and not peer.stopped:
            self.sent_frames += 1
            peer._on_frame(frame)

    async def stop(self) -> None:
        if not self.stopped:
            self.stopped = True
            self.fabric.stopped.append(self.self_id)

    def inject_state(self, st: MediaState) -> None:
        """Simulate the engine reporting a state change mid-call."""
        self._emit(st)
