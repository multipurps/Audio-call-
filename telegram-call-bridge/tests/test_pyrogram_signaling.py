"""Pyrogram transport tests: real Pyrogram 2.0.106 TL types, mocked Client.invoke.
They prove the wire objects are well-formed against the real schema; they do
NOT prove Telegram's servers accept them."""
import asyncio
from unittest.mock import AsyncMock, MagicMock

import pytest
from pyrogram.errors import RPCError
from pyrogram.raw import functions, types

from emysa_tgcall import CallDiscarded, SignalingError
from emysa_tgcall.pyrogram_signaling import (PyrogramSignaling, connection_from_tl, established_from_tl,
                                             protocol_to_tl)
from emysa_tgcall.types import CallProtocol

PROTO = CallProtocol(92, 92, True, True, ("8.0.0", "9.0.0", "12.0.0", "13.0.0"))
TLP = types.PhoneCallProtocol(min_layer=92, max_layer=92, udp_p2p=True, udp_reflector=True,
                              library_versions=["9.0.0", "13.0.0"])


def phone_call(**kw):
    d = dict(id=7, access_hash=70, date=0, admin_id=1, participant_id=2, g_a_or_b=b"G" * 256,
             key_fingerprint=-5, protocol=TLP, start_date=0, p2p_allowed=True, connections=[
                 types.PhoneConnectionWebrtc(id=1, ip="1.2.3.4", ipv6="::1", port=443, username="u",
                                             password="p", turn=True, stun=True),
                 types.PhoneConnection(id=2, ip="5.6.7.8", ipv6="::2", port=596, peer_tag=b"T" * 16)])
    d.update(kw)
    return types.PhoneCall(**d)


def make():
    client = MagicMock()
    client.invoke = AsyncMock()
    sig = PyrogramSignaling(client)
    return sig, client


async def test_request_call_builds_valid_tl_and_records_call():
    sig, client = make()
    waiting = types.PhoneCallWaiting(id=7, access_hash=70, date=0, admin_id=1, participant_id=2, protocol=TLP)
    client.invoke.return_value = types.phone.PhoneCall(phone_call=waiting, users=[])
    user = types.InputUser(user_id=2, access_hash=22)
    from emysa_tgcall.types import ResolvedUser
    cid = await sig.request_call(ResolvedUser(2, user), b"h" * 32, PROTO)
    req = client.invoke.call_args.args[0]
    assert isinstance(req, functions.phone.RequestCall)
    assert req.user_id is user and req.g_a_hash == b"h" * 32 and not req.video
    assert (req.protocol.min_layer, req.protocol.max_layer) == (92, 92)
    assert list(req.protocol.library_versions) == ["8.0.0", "9.0.0", "12.0.0", "13.0.0"]
    assert req.protocol.udp_p2p and req.protocol.udp_reflector
    assert cid == 7 and sig.active_call_id == 7
    req.write()                                   # serialises against the real TL schema


async def test_confirm_accept_discard_received_signaling_shapes():
    sig, client = make()
    sig._call_id, sig._access_hash = 7, 70
    client.invoke.return_value = types.phone.PhoneCall(phone_call=phone_call(), users=[])
    est = await sig.confirm_call(b"A" * 256, -123, PROTO)
    r = client.invoke.call_args.args[0]
    assert isinstance(r, functions.phone.ConfirmCall) and r.g_a == b"A" * 256 and r.key_fingerprint == -123
    assert (r.peer.id, r.peer.access_hash) == (7, 70)
    assert est.library_versions == ("9.0.0", "13.0.0") and est.p2p_allowed and len(est.connections) == 2
    r.write()

    await sig.accept_call(b"B" * 256, PROTO)
    r = client.invoke.call_args.args[0]
    assert isinstance(r, functions.phone.AcceptCall) and r.g_b == b"B" * 256
    r.write()

    await sig.received_call()
    assert isinstance(client.invoke.call_args.args[0], functions.phone.ReceivedCall)

    await sig.send_signaling_data(b"blob")
    r = client.invoke.call_args.args[0]
    assert isinstance(r, functions.phone.SendSignalingData) and r.data == b"blob"
    r.write()

    await sig.discard_call("busy")
    r = client.invoke.call_args.args[0]
    assert isinstance(r, functions.phone.DiscardCall) and isinstance(r.reason, types.PhoneCallDiscardReasonBusy)
    r.write()
    assert sig.active_call_id is None


@pytest.mark.parametrize("reason,cls", [("hangup", types.PhoneCallDiscardReasonHangup),
                                        ("missed", types.PhoneCallDiscardReasonMissed),
                                        ("disconnect", types.PhoneCallDiscardReasonDisconnect)])
async def test_discard_reasons_map(reason, cls):
    sig, client = make()
    sig._call_id, sig._access_hash = 7, 70
    await sig.discard_call(reason)
    assert isinstance(client.invoke.call_args.args[0].reason, cls)


async def test_connection_mapping():
    c = phone_call().connections
    w, u = connection_from_tl(c[0]), connection_from_tl(c[1])
    assert w.webrtc and (w.username, w.password, w.turn, w.stun) == ("u", "p", True, True)
    assert not u.webrtc and u.peer_tag == b"T" * 16 and u.turn


async def test_updates_incoming_accepted_established_discarded_signaling():
    sig, client = make()
    got = {"in": [], "sig": [], "hang": []}
    async def on_in(r): got["in"].append(r)
    async def on_sig(d): got["sig"].append(d)
    async def on_hang(r): got["hang"].append(r)
    sig.set_incoming_callback(on_in); sig.set_signaling_in_callback(on_sig); sig.set_remote_hangup_callback(on_hang)

    await sig._on_update(None, types.UpdatePhoneCall(phone_call=types.PhoneCallRequested(
        id=9, access_hash=90, date=0, admin_id=5, participant_id=2, g_a_hash=b"H" * 32, protocol=TLP, video=True)), {}, {})
    r = got["in"][0]
    assert (r.call_id, r.access_hash, r.caller_id, r.g_a_hash, r.video) == (9, 90, 5, b"H" * 32, True)

    # outgoing: accepted
    sig._call_id, sig._access_hash = 7, 70
    sig._accepted = asyncio.get_running_loop().create_future()
    sig._discarded = asyncio.get_running_loop().create_future()
    await sig._on_update(None, types.UpdatePhoneCall(phone_call=types.PhoneCallAccepted(
        id=7, access_hash=70, date=0, admin_id=1, participant_id=2, g_b=b"GB", protocol=TLP)), {}, {})
    assert await sig.wait_accepted(0.5) == b"GB"

    # incoming: established
    sig._established = asyncio.get_running_loop().create_future()
    sig._discarded = asyncio.get_running_loop().create_future()
    await sig._on_update(None, types.UpdatePhoneCall(phone_call=phone_call()), {}, {})
    assert (await sig.wait_established(0.5)).key_fingerprint == -5

    await sig._on_update(None, types.UpdatePhoneCallSignalingData(phone_call_id=7, data=b"sd"), {}, {})
    assert got["sig"] == [b"sd"]

    # discard after setup => remote hangup with reason name
    await sig._on_update(None, types.UpdatePhoneCall(phone_call=types.PhoneCallDiscarded(
        id=7, reason=types.PhoneCallDiscardReasonBusy())), {}, {})
    assert got["hang"] == ["busy"]


async def test_discard_during_setup_surfaces_as_calldiscarded():
    sig, client = make()
    sig._call_id = 7
    loop = asyncio.get_running_loop()
    sig._accepted, sig._discarded = loop.create_future(), loop.create_future()
    await sig._on_update(None, types.UpdatePhoneCall(phone_call=types.PhoneCallDiscarded(
        id=7, reason=types.PhoneCallDiscardReasonMissed())), {}, {})
    with pytest.raises(CallDiscarded) as e:
        await sig.wait_accepted(0.5)
    assert e.value.reason == "missed"


async def test_rpc_error_wrapped_with_code():
    class CompatInvalid(RPCError):
        CODE, ID, MESSAGE = 406, "CALL_PROTOCOL_COMPAT_LAYER_INVALID", "layer invalid"
    sig, client = make()
    client.invoke.side_effect = CompatInvalid()
    with pytest.raises(SignalingError) as e:
        await sig.get_dh_config()
    assert e.value.code == "CALL_PROTOCOL_COMPAT_LAYER_INVALID"


async def test_dh_config_mapping():
    sig, client = make()
    client.invoke.return_value = types.messages.DhConfig(g=3, p=b"P" * 256, version=1, random=b"R" * 256)
    dh = await sig.get_dh_config()
    r = client.invoke.call_args.args[0]
    assert isinstance(r, functions.messages.GetDhConfig) and r.random_length == 256
    assert (dh.g, dh.p, dh.random) == (3, b"P" * 256, b"R" * 256)
