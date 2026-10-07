import asyncio

import pytest

from emysa_tgcall import (AllowList, BusyError, CallFailed, CallState, Direction, KnownAudioAdapter,
                          MediaState, accept_all, deny_all)
from emysa_tgcall.pcm import KNOWN_SEQUENCE_HZ, PROBE_HZ, detect_sequence, dominant_frequency, tone
from emysa_tgcall.types import CallEnd

from helpers import active, fake_world, idle, make_node

# ---------------------------------------------------------------- outgoing / acceptance

async def test_outgoing_call_accepted_becomes_active_on_both_sides():
    hub, fab, (a, b) = await fake_world()
    info = await a.mgr.place_call(2)
    await active(a, b)
    assert info.direction is Direction.OUTGOING and info.peer_id == 2
    assert info.library_versions == ("9.0.0",)
    assert b.mgr.call_info.direction is Direction.INCOMING and b.mgr.call_info.peer_id == 1
    assert ("accept", info.call_id, 2) in hub.wire_log
    await a.mgr.hangup(); await idle(a, b)


async def test_incoming_declined_by_policy_caller_sees_declined():
    hub, fab, (a, b) = await fake_world(policy_b=AllowList({999}))
    with pytest.raises(CallFailed) as e:
        await a.mgr.place_call(2)
    assert e.value.reason == "declined"
    await idle(a, b)
    assert b.mgr.last_end.reason == "not_allowed"
    assert not b.adapters and not fab.of(1).connect_called


async def test_default_policy_denies_everyone():
    hub, fab, (a, b) = await fake_world(policy_b=deny_all)
    with pytest.raises(CallFailed):
        await a.mgr.place_call(2)
    await idle(b)
    assert b.mgr.last_end.reason == "not_allowed"


async def test_allowlist_accepts_listed_caller():
    hub, fab, (a, b) = await fake_world(policy_b=AllowList({1}))
    await a.mgr.place_call(2); await active(a, b)
    await a.mgr.hangup(); await idle(a, b)


async def test_policy_exception_is_denied_not_crashed():
    async def boom(req): raise RuntimeError("x")
    hub, fab, (a, b) = await fake_world(policy_b=boom)
    with pytest.raises(CallFailed):
        await a.mgr.place_call(2)
    await idle(b)
    assert b.mgr.last_end.reason == "not_allowed"


async def test_video_call_request_is_declined():
    hub, fab, (a, b) = await fake_world()
    sig = a.mgr._sig
    user = await sig.resolve_user(2)
    media = fab.factory(1)()
    proto = media.protocol()
    await media.create_call(2)
    gh = await media.init_exchange(await sig.get_dh_config(), None)
    await sig.request_call(user, gh, proto, video=True)
    await hub.drain()
    await idle(b)
    assert b.mgr.last_end.reason == "video_not_supported"
    assert any(e[0] == "discard" and e[2] == 2 for e in hub.wire_log)

# ---------------------------------------------------------------- termination

async def test_local_hangup_ends_both_sides_and_cleans_up():
    hub, fab, (a, b) = await fake_world()
    await a.mgr.place_call(2); await active(a, b)
    await a.mgr.hangup()
    await idle(a, b)
    assert a.mgr.last_end.reason == "local_hangup"
    assert b.mgr.last_end.reason == "remote_hangup"
    assert a.adapters[0].ended_reason == "local_hangup" and b.adapters[0].ended_reason == "remote_hangup"
    assert sorted(fab.stopped) == [1, 2]
    assert a.mgr.bridge is None and a.mgr.call_info is None


async def test_remote_hangup_from_callee():
    hub, fab, (a, b) = await fake_world()
    await a.mgr.place_call(2); await active(a, b)
    await b.mgr.hangup()
    await idle(a, b)
    assert a.mgr.last_end.reason == "remote_hangup" and b.mgr.last_end.reason == "local_hangup"


async def test_hangup_is_idempotent_and_safe_when_idle():
    hub, fab, (a, b) = await fake_world()
    await a.mgr.hangup()
    await a.mgr.place_call(2); await active(a, b)
    await asyncio.gather(a.mgr.hangup(), a.mgr.hangup(), b.mgr.hangup())
    await idle(a, b)
    assert len(a.mgr.history) == 1 and len(b.mgr.history) == 1


async def test_cancel_while_ringing():
    gate = asyncio.Event()
    async def slow(req): await gate.wait(); return True
    hub, fab, (a, b) = await fake_world(policy_b=slow, answer_timeout=5.0)
    t = asyncio.create_task(a.mgr.place_call(2))
    await asyncio.sleep(0.2)
    await a.mgr.hangup()
    with pytest.raises(CallFailed) as e:
        await t
    assert e.value.reason == "local_hangup"
    await idle(a)
    gate.set()
    await idle(b)                      # late-accepting callee unwinds cleanly
    assert b.mgr.state is CallState.IDLE

# ---------------------------------------------------------------- bidirectional audio

async def test_bidirectional_audio_receive_then_return_known_pcm():
    probe = lambda: KnownAudioAdapter(reply=tone(PROBE_HZ, 2500), trigger="start")
    echo = lambda: KnownAudioAdapter(trigger="first_caller_frame")      # known 500/700/900 clip
    hub, fab, (a, b) = await fake_world(adapter_a=probe, adapter_b=echo)
    await a.mgr.place_call(2); await active(a, b)
    await asyncio.sleep(2.4)
    ad_a, ad_b = a.adapters[0], b.adapters[0]
    heard_by_b, heard_by_a = ad_b.received_pcm(), ad_a.received_pcm()
    assert ad_b.reply_started, "reply must be triggered by receiving caller audio"
    assert dominant_frequency(heard_by_b, KNOWN_SEQUENCE_HZ + (PROBE_HZ,)) == PROBE_HZ
    assert detect_sequence(heard_by_a, KNOWN_SEQUENCE_HZ + (PROBE_HZ,)) == list(KNOWN_SEQUENCE_HZ)
    assert ad_a.bad_frames == ad_b.bad_frames == 0
    await a.mgr.hangup(); await idle(a, b)

# ---------------------------------------------------------------- one call at a time

async def test_second_incoming_call_gets_busy_and_active_call_survives():
    hub, fab, (a, b, c) = await fake_world(users=(1, 2, 3))
    await a.mgr.place_call(2); await active(a, b)
    with pytest.raises(CallFailed) as e:
        await c.mgr.place_call(2)
    assert e.value.reason == "busy"
    assert b.mgr.state is CallState.ACTIVE and a.mgr.state is CallState.ACTIVE
    assert b.mgr.history[-1].reason == "busy_rejected"
    assert any(x[0] == "discard" and x[3] == "busy" for x in hub.wire_log)
    await idle(c)
    await a.mgr.hangup(); await idle(a, b)


async def test_place_call_while_active_raises_busy_both_directions():
    hub, fab, (a, b, c) = await fake_world(users=(1, 2, 3))
    await a.mgr.place_call(2); await active(a, b)
    for n, tgt in ((a, 3), (b, 3)):
        with pytest.raises(BusyError):
            await n.mgr.place_call(tgt)
    assert a.mgr.state is CallState.ACTIVE
    await a.mgr.hangup(); await idle(a, b)


async def test_concurrent_calls_during_setup_only_one_wins():
    gate = asyncio.Event()
    async def slow(req): await gate.wait(); return True
    hub, fab, (a, b, c) = await fake_world(policy_b=slow, users=(1, 2, 3), answer_timeout=5.0)
    t1 = asyncio.create_task(a.mgr.place_call(2))
    await asyncio.sleep(0.1)
    with pytest.raises(CallFailed) as e:                  # B is RINGING_IN -> busy
        await c.mgr.place_call(2)
    assert e.value.reason == "busy"
    gate.set()
    await t1
    await active(a, b)
    await a.mgr.hangup(); await idle(a, b)


async def test_sequential_calls_reuse_manager():
    hub, fab, (a, b) = await fake_world()
    for _ in range(3):
        await a.mgr.place_call(2); await active(a, b)
        await a.mgr.hangup(); await idle(a, b)
    assert [h.reason for h in a.mgr.history] == ["local_hangup"] * 3
