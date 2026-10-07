import asyncio

import pytest

from emysa_tgcall import CallFailed, CallState, MediaState, SignalingError
from helpers import active, fake_world, idle


async def test_request_call_rpc_error_surfaces_code_and_cleans_up():
    hub, fab, (a, b) = await fake_world()
    hub.fail_next["request"] = SignalingError("privacy", code="USER_PRIVACY_RESTRICTED")
    with pytest.raises(CallFailed) as e:
        await a.mgr.place_call(2)
    assert (e.value.reason, e.value.detail) == ("signaling_error", "USER_PRIVACY_RESTRICTED")
    assert a.mgr.state is CallState.IDLE and 1 in fab.stopped
    assert not hub.discards()                       # nothing to discard: call never existed
    await a.mgr.place_call(2); await active(a, b)   # manager is reusable afterwards
    await a.mgr.hangup(); await idle(a, b)


async def test_unknown_target_fails_cleanly():
    hub, fab, (a, b) = await fake_world()
    with pytest.raises(CallFailed) as e:
        await a.mgr.place_call(404)
    assert e.value.reason == "signaling_error" and a.mgr.state is CallState.IDLE


async def test_dh_config_failure():
    hub, fab, (a, b) = await fake_world()
    hub.fail_next["get_dh"] = SignalingError("flood", code="FLOOD_WAIT_3")
    with pytest.raises(CallFailed) as e:
        await a.mgr.place_call(2)
    assert e.value.detail == "FLOOD_WAIT_3" and a.mgr.state is CallState.IDLE


async def test_answer_timeout_sends_missed_discard():
    async def never(req): await asyncio.sleep(30)
    hub, fab, (a, b) = await fake_world(policy_b=never, answer_timeout=0.3)
    with pytest.raises(CallFailed) as e:
        await a.mgr.place_call(2)
    assert e.value.reason == "timeout"
    assert [x[3] for x in hub.discards()] == ["missed"]
    await idle(a)


async def test_confirm_call_failure_unwinds_both_sides():
    hub, fab, (a, b) = await fake_world()
    hub.fail_next["confirm"] = SignalingError("bad", code="CALL_PROTOCOL_COMPAT_LAYER_INVALID")
    with pytest.raises(CallFailed) as e:
        await a.mgr.place_call(2)
    assert e.value.detail == "CALL_PROTOCOL_COMPAT_LAYER_INVALID"
    await idle(a, b)
    assert b.mgr.last_end.reason in ("remote_hangup", "key_exchange_timeout", "caller_cancelled")


async def test_callee_accept_rpc_failure():
    hub, fab, (a, b) = await fake_world()
    hub.fail_next["accept"] = SignalingError("gone", code="CALL_ALREADY_DECLINED")
    with pytest.raises(CallFailed):
        await a.mgr.place_call(2)
    await idle(a, b)
    assert b.mgr.last_end.reason == "signaling_error"


async def test_caller_never_confirms_callee_times_out():
    hub, fab, (a, b) = await fake_world(key_exchange_timeout=0.3, answer_timeout=5.0)
    hub.fail_next["confirm"] = SignalingError("x", code="X")   # caller aborts after callee accepted
    hub.drop_signaling = True
    with pytest.raises(CallFailed):
        await a.mgr.place_call(2)
    await idle(a, b)


async def test_media_failure_during_key_exchange():
    hub, fab, (a, b) = await fake_world()
    fab.fail_at[1] = "init_exchange"
    with pytest.raises(CallFailed) as e:
        await a.mgr.place_call(2)
    assert e.value.reason == "key_exchange_failed" and a.mgr.state is CallState.IDLE
    assert b.mgr.state is CallState.IDLE


async def test_tampered_key_exchange_rejected_by_callee():
    hub, fab, (a, b) = await fake_world()
    hub.tamper_g_a = True
    with pytest.raises((CallFailed,)):
        await a.mgr.place_call(2)
    await idle(a, b)
    assert b.mgr.last_end.reason == "key_exchange_failed"
    assert not fab.of(2).connect_called          # callee never connects on a bad key


async def test_media_connect_failure_state_ends_calls():
    hub, fab, (a, b) = await fake_world()
    fab.state_instead[2] = MediaState.FAILED
    try:
        await a.mgr.place_call(2)
    except CallFailed:
        pass
    await idle(a, b)
    assert b.mgr.last_end.reason == "media_failed"


async def test_media_connect_timeout():
    hub, fab, (a, b) = await fake_world(connect_timeout=0.3)
    fab.fail_at[2] = "connect"                    # callee never connects -> caller never CONNECTED
    with pytest.raises(CallFailed) as e:
        await a.mgr.place_call(2)
    assert e.value.reason in ("connect_timeout", "remote_hangup")
    await idle(a, b)


async def test_media_dies_mid_call_hangs_up_peer():
    hub, fab, (a, b) = await fake_world()
    await a.mgr.place_call(2); await active(a, b)
    fab.of(1).inject_state(MediaState.FAILED)
    await idle(a, b)
    assert a.mgr.last_end.reason == "media_failed"
    assert b.mgr.last_end.reason == "remote_hangup"
    assert [x[3] for x in hub.discards()] == ["disconnect"]


async def test_signaling_blob_failures_do_not_end_call():
    hub, fab, (a, b) = await fake_world()
    await a.mgr.place_call(2); await active(a, b)
    hub.fail_next["signaling"] = SignalingError("net", code="TIMEOUT")
    await a.mgr._sig.send_signaling_data(b"blob")       # swallowed + logged
    assert a.mgr.state is CallState.ACTIVE
    await a.mgr.hangup(); await idle(a, b)


async def test_discard_rpc_failure_still_returns_to_idle():
    hub, fab, (a, b) = await fake_world()
    await a.mgr.place_call(2); await active(a, b)
    hub.fail_next["discard"] = SignalingError("x", code="X")
    await a.mgr.hangup()
    await idle(a)
    assert a.mgr.state is CallState.IDLE and 1 in fab.stopped
