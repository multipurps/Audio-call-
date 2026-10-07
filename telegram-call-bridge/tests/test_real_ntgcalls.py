"""Real ntgcalls engine (real DH, WebRTC, PCM) with a FAKE Telegram signaling hub.

Proves: manager + signaling logic + NTgCalls media + PCM bridge work together.
Does NOT prove: Telegram's servers/relays accept our requests (needs a live account)."""
import asyncio

import pytest

ntgcalls = pytest.importorskip("ntgcalls")

from emysa_tgcall import CallFailed, CallState, KnownAudioAdapter, MediaError, accept_all
from emysa_tgcall.media import NTgCallsMedia, build_rtc_servers
from emysa_tgcall.pcm import KNOWN_SEQUENCE_HZ, PROBE_HZ, detect_sequence, dominant_frequency, tone
from emysa_tgcall.testing import FakeTelegramHub
from emysa_tgcall.types import RelayConnection

from helpers import active, idle, make_node

pytestmark = [pytest.mark.real_ntgcalls]
ALL = KNOWN_SEQUENCE_HZ + (PROBE_HZ,)


async def real_world(adapter_a=None, adapter_b=None, **cfg):
    hub = FakeTelegramHub()
    a = await make_node(hub, 1, NTgCallsMedia, accept_all, adapter_a, connect_timeout=15, **cfg)
    b = await make_node(hub, 2, NTgCallsMedia, accept_all, adapter_b, connect_timeout=15, **cfg)
    return hub, a, b


async def test_full_call_two_way_pcm_known_audio_returned():
    probe = lambda: KnownAudioAdapter(reply=tone(PROBE_HZ, 5000), trigger="start")
    echo = lambda: KnownAudioAdapter(trigger="first_caller_frame")       # returns known 500/700/900 clip
    hub, a, b = await real_world(probe, echo)
    info = await a.mgr.place_call(2)
    await active(a, b)
    assert info.library_versions[0] == "13.0.0"                # highest common version negotiated
    await asyncio.sleep(4.0)
    ad_a, ad_b = a.adapters[0], b.adapters[0]
    assert ad_b.reply_started and ad_b.rx_frames > 100 and ad_a.rx_frames > 100
    assert ad_a.bad_frames == ad_b.bad_frames == 0             # every frame exactly 960 bytes
    # callee heard the caller's probe tone; caller heard the callee's known clip, in order
    assert dominant_frequency(ad_b.received_pcm()[-48000 * 2:], ALL) == PROBE_HZ
    assert detect_sequence(ad_a.received_pcm(), ALL, window_ms=50) == list(KNOWN_SEQUENCE_HZ)
    assert hub.signaling_blobs > 0                              # media handshake really went via signaling
    # termination: both idle, engines hold no calls
    ntg_a, ntg_b = a.mgr._call.media._ntg, b.mgr._call.media._ntg
    await a.mgr.hangup(); await idle(a, b)
    assert b.mgr.last_end.reason == "remote_hangup"
    assert await ntg_a.calls() == {} and await ntg_b.calls() == {}


async def test_real_engine_rejects_tampered_key_exchange():
    hub, a, b = await real_world()
    hub.tamper_g_a = True
    try:
        await a.mgr.place_call(2)
    except CallFailed:
        pass
    await idle(a, b, timeout=20)
    assert b.mgr.last_end.reason == "key_exchange_failed"
    assert "Hash mismatch" in (b.mgr.last_end.detail or "")
    assert b.adapters == [] or b.adapters[0].info is None       # callee never went live


async def test_real_engine_one_call_limit_busy():
    hub = FakeTelegramHub()
    a = await make_node(hub, 1, NTgCallsMedia, accept_all, None, connect_timeout=15)
    b = await make_node(hub, 2, NTgCallsMedia, accept_all, None, connect_timeout=15)
    c = await make_node(hub, 3, NTgCallsMedia, accept_all, None, connect_timeout=15)
    await a.mgr.place_call(2); await active(a, b)
    with pytest.raises(CallFailed) as e:
        await c.mgr.place_call(2)
    assert e.value.reason == "busy" and a.mgr.state is CallState.ACTIVE and b.mgr.state is CallState.ACTIVE
    await a.mgr.hangup(); await idle(a, b, c)


async def test_remote_hangup_from_callee_real_engine():
    hub, a, b = await real_world()
    await a.mgr.place_call(2); await active(a, b)
    await b.mgr.hangup(); await idle(a, b)
    assert a.mgr.last_end.reason == "remote_hangup"


async def test_unsupported_protocol_version_is_media_error():
    m = NTgCallsMedia()
    from emysa_tgcall.testing import TELEGRAM_DH_PRIME
    from emysa_tgcall.types import DhParams
    await m.create_call(5)
    gh = await m.init_exchange(DhParams(3, TELEGRAM_DH_PRIME, b"\x01" * 256), None)
    peer = NTgCallsMedia()
    await peer.create_call(6)
    gb = await peer.init_exchange(DhParams(3, TELEGRAM_DH_PRIME, b"\x02" * 256), gh)
    auth = await m.exchange_keys(gb, 0)
    with pytest.raises(MediaError, match="SignalingUnsupported"):
        await m.connect([], ["11.0.0"], True)
    await m.stop(); await peer.stop()


async def test_exchange_before_init_is_media_error():
    m = NTgCallsMedia()
    await m.create_call(1)
    with pytest.raises(MediaError):
        await m.exchange_keys(b"x" * 256, 0)
    await m.stop()


def test_relay_mapping_to_rtcserver():
    servers = build_rtc_servers([
        RelayConnection(1, "1.2.3.4", "::1", 443, "u", "p", turn=True, stun=True, webrtc=True),
        RelayConnection(2, "5.6.7.8", "::2", 596, peer_tag=b"T" * 16, tcp=False)])
    assert len(servers) == 2 and servers[0].username == "u" and servers[1].peer_tag == b"T" * 16
