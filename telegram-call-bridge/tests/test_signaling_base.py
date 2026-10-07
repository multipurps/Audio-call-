import asyncio

import pytest

from emysa_tgcall import BusyError, CallDiscarded, CallTimeout, IncomingRequest, SignalingError
from emysa_tgcall.types import CallProtocol
from emysa_tgcall.testing import FakeTelegramHub

P = CallProtocol(92, 92, True, True, ("9.0.0",))


async def test_one_active_call_per_signaling():
    hub = FakeTelegramHub(); a, b = hub.endpoint(1), hub.endpoint(2)
    u = await a.resolve_user(2)
    await a.request_call(u, b"h" * 32, P)
    with pytest.raises(BusyError):
        await a.request_call(u, b"h" * 32, P)
    with pytest.raises(BusyError):
        a.bind_incoming(IncomingRequest(5, 5, 9, b""))


async def test_wait_accepted_timeout_and_discard():
    hub = FakeTelegramHub(); a, b = hub.endpoint(1), hub.endpoint(2)
    u = await a.resolve_user(2)
    cid = await a.request_call(u, b"h" * 32, P)
    with pytest.raises(CallTimeout):
        await a.wait_accepted(0.1)
    await hub.drain()
    await a.deliver_discarded(cid, "busy")                  # pending waiter is armed -> surfaces
    with pytest.raises(CallDiscarded) as e:
        await a.wait_accepted(0.5)
    assert e.value.reason == "busy" and a.active_call_id is None


async def test_remote_hangup_callback_only_after_setup_and_not_for_own_discard():
    hub = FakeTelegramHub(); a, b = hub.endpoint(1), hub.endpoint(2)
    seen = []
    async def cb(reason): seen.append(reason)
    a.set_remote_hangup_callback(cb)
    u = await a.resolve_user(2)
    cid = await a.request_call(u, b"h" * 32, P)
    a._accepted.set_result(b"gb")                            # setup finished
    await a.deliver_discarded(cid, "hangup")
    assert seen == ["hangup"] and a.active_call_id is None
    cid2 = await a.request_call(u, b"h" * 32, P)
    await a.discard_call()                                   # our own hangup
    await a.deliver_discarded(cid2, "hangup")                # echo from server: ignored
    assert seen == ["hangup"]


async def test_stale_updates_for_other_calls_are_ignored():
    hub = FakeTelegramHub(); a, b = hub.endpoint(1), hub.endpoint(2)
    got = []
    async def cb(d): got.append(d)
    a.set_signaling_in_callback(cb)
    u = await a.resolve_user(2)
    cid = await a.request_call(u, b"h" * 32, P)
    await a.deliver_signaling(cid + 1, b"nope")
    await a.deliver_signaling(cid, b"yes")
    assert got == [b"yes"]


async def test_discard_call_noop_when_idle_and_discard_incoming_never_touches_active():
    hub = FakeTelegramHub(); a, b = hub.endpoint(1), hub.endpoint(2)
    await a.discard_call()
    u = await a.resolve_user(2)
    cid = await a.request_call(u, b"h" * 32, P)
    await a.discard_incoming(IncomingRequest(12345, 1, 9, b""), busy=True)   # unknown call: error swallowed
    assert a.active_call_id == cid
