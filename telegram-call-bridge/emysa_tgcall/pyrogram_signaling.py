"""Real Telegram transport: a normal USER account via Pyrogram's raw MTProto API.

Not a bot, not a group call. This is the only module that imports Pyrogram.

STATUS: the TL objects built here are unit-tested against Pyrogram 2.0.106's
real TL schema with a mocked ``Client.invoke``. It has **not** been run against
live Telegram servers in this phase (no account/API credentials available in
the build sandbox). The sequencing follows foobar26/tg2sip's
``telegram_signaling.py`` (Apache-2.0), which reports working calls.
"""
from __future__ import annotations

import logging
import random
import re
from typing import Any

from pyrogram import Client
from pyrogram.errors import RPCError
from pyrogram.handlers import RawUpdateHandler
from pyrogram.raw import functions, types

from .errors import SignalingError
from .signaling import SignalingBase
from .types import (CallProtocol, DhParams, Established, IncomingRequest, RelayConnection,
                    ResolvedUser)

log = logging.getLogger(__name__)

_DISCARD_REASONS = {
    "hangup": types.PhoneCallDiscardReasonHangup,
    "busy": types.PhoneCallDiscardReasonBusy,
    "missed": types.PhoneCallDiscardReasonMissed,
    "disconnect": types.PhoneCallDiscardReasonDisconnect,
}
_REASON_NAMES = {
    "PhoneCallDiscardReasonHangup": "hangup",
    "PhoneCallDiscardReasonBusy": "busy",
    "PhoneCallDiscardReasonMissed": "missed",
    "PhoneCallDiscardReasonDisconnect": "disconnect",
}


def protocol_to_tl(p: CallProtocol) -> types.PhoneCallProtocol:
    return types.PhoneCallProtocol(min_layer=p.min_layer, max_layer=p.max_layer,
                                   udp_p2p=p.udp_p2p, udp_reflector=p.udp_reflector,
                                   library_versions=list(p.library_versions))


def connection_from_tl(c: Any) -> RelayConnection:
    if type(c).__name__ == "PhoneConnectionWebrtc":
        return RelayConnection(id=c.id, ip=c.ip, ipv6=c.ipv6, port=c.port, username=c.username,
                               password=c.password, turn=bool(c.turn), stun=bool(c.stun), webrtc=True)
    return RelayConnection(id=c.id, ip=c.ip, ipv6=c.ipv6, port=c.port, tcp=bool(getattr(c, "tcp", False)),
                           peer_tag=bytes(c.peer_tag), turn=True, webrtc=False)


def established_from_tl(pc: types.PhoneCall) -> Established:
    return Established(g_a_or_b=bytes(pc.g_a_or_b), key_fingerprint=int(pc.key_fingerprint),
                       connections=tuple(connection_from_tl(c) for c in pc.connections),
                       library_versions=tuple(pc.protocol.library_versions),
                       p2p_allowed=bool(pc.p2p_allowed))


def _wrap(e: RPCError) -> SignalingError:
    code = getattr(e, "ID", None) or getattr(e, "MESSAGE", None) or type(e).__name__
    return SignalingError(f"{type(e).__name__}: {e}", code=str(code))


class PyrogramSignaling(SignalingBase):
    """``client`` must belong to a *user* session (``Client(name, api_id, api_hash)``
    logged in with a phone number), not a bot token."""

    def __init__(self, client: Client, *, manage_client: bool = False):
        super().__init__()
        self._client = client
        self._manage = manage_client
        self._handler = RawUpdateHandler(self._on_update)

    async def start(self) -> None:
        if self._manage:
            await self._client.start()
        self._client.add_handler(self._handler)

    async def stop(self) -> None:
        try:
            self._client.remove_handler(self._handler)
        except Exception:  # noqa: BLE001
            pass
        if self._manage:
            await self._client.stop()

    async def _invoke(self, req: Any) -> Any:
        try:
            return await self._client.invoke(req)
        except RPCError as e:
            raise _wrap(e) from e

    # ---- wire ops ------------------------------------------------------------------

    async def _wire_get_dh(self) -> DhParams:
        dh = await self._invoke(functions.messages.GetDhConfig(version=0, random_length=256))
        if not isinstance(dh, types.messages.DhConfig):
            raise SignalingError(f"unexpected DhConfig response: {type(dh).__name__}")
        return DhParams(g=dh.g, p=bytes(dh.p), random=bytes(dh.random))

    async def _wire_resolve(self, target: Any) -> ResolvedUser:
        key = str(target).strip()
        if isinstance(target, str) and re.fullmatch(r"\+\d{5,15}", key):
            res = await self._invoke(functions.contacts.ImportContacts(contacts=[
                types.InputPhoneContact(client_id=random.getrandbits(63), phone=key,
                                        first_name="emysa", last_name="")]))
            for u in res.users:
                return ResolvedUser(u.id, types.InputUser(user_id=u.id, access_hash=u.access_hash))
            raise SignalingError(f"phone {key} is not a Telegram user", code="PHONE_NOT_OCCUPIED")
        try:
            peer = await self._client.resolve_peer(target)
        except RPCError as e:
            raise _wrap(e) from e
        except (KeyError, ValueError) as e:
            raise SignalingError(f"cannot resolve {target!r}: {e}", code="PEER_ID_INVALID") from e
        if not isinstance(peer, types.InputPeerUser):
            raise SignalingError(f"{target!r} is not a user ({type(peer).__name__})")
        return ResolvedUser(peer.user_id, types.InputUser(user_id=peer.user_id,
                                                          access_hash=peer.access_hash))

    async def _wire_request(self, user, g_a_hash, protocol, video):
        res = await self._invoke(functions.phone.RequestCall(
            user_id=user.handle, random_id=random.randint(0, 0x7FFFFFFF - 1),
            g_a_hash=g_a_hash, protocol=protocol_to_tl(protocol), video=video or None))
        return res.phone_call.id, res.phone_call.access_hash

    async def _wire_confirm(self, call_id, access_hash, g_a, fingerprint, protocol) -> Established:
        res = await self._invoke(functions.phone.ConfirmCall(
            peer=types.InputPhoneCall(id=call_id, access_hash=access_hash), g_a=g_a,
            key_fingerprint=fingerprint, protocol=protocol_to_tl(protocol)))
        return established_from_tl(res.phone_call)

    async def _wire_accept(self, call_id, access_hash, g_b, protocol) -> None:
        await self._invoke(functions.phone.AcceptCall(
            peer=types.InputPhoneCall(id=call_id, access_hash=access_hash), g_b=g_b,
            protocol=protocol_to_tl(protocol)))

    async def _wire_received(self, call_id, access_hash) -> None:
        await self._invoke(functions.phone.ReceivedCall(
            peer=types.InputPhoneCall(id=call_id, access_hash=access_hash)))

    async def _wire_discard(self, call_id, access_hash, reason) -> None:
        await self._invoke(functions.phone.DiscardCall(
            peer=types.InputPhoneCall(id=call_id, access_hash=access_hash), duration=0,
            reason=_DISCARD_REASONS.get(reason, types.PhoneCallDiscardReasonHangup)(),
            connection_id=0))

    async def _wire_send_signaling(self, call_id, access_hash, data) -> None:
        await self._invoke(functions.phone.SendSignalingData(
            peer=types.InputPhoneCall(id=call_id, access_hash=access_hash), data=data))

    # ---- updates -> base delivery ---------------------------------------------------------

    async def _on_update(self, _client, update, _users, _chats) -> None:
        if isinstance(update, types.UpdatePhoneCallSignalingData):
            await self.deliver_signaling(update.phone_call_id, bytes(update.data))
            return
        if not isinstance(update, types.UpdatePhoneCall):
            return
        pc = update.phone_call
        if isinstance(pc, types.PhoneCallRequested):
            await self.deliver_incoming(IncomingRequest(
                call_id=pc.id, access_hash=pc.access_hash, caller_id=pc.admin_id,
                g_a_hash=bytes(pc.g_a_hash), video=bool(getattr(pc, "video", False))))
        elif isinstance(pc, types.PhoneCallAccepted):
            self.deliver_accepted(pc.id, bytes(pc.g_b))
        elif isinstance(pc, types.PhoneCall):
            self.deliver_established(pc.id, established_from_tl(pc))
        elif isinstance(pc, types.PhoneCallDiscarded):
            name = _REASON_NAMES.get(type(pc.reason).__name__, "unknown") if pc.reason else "unknown"
            await self.deliver_discarded(pc.id, name)
        # PhoneCallWaiting / PhoneCallEmpty: informational, ignored
