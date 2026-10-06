"""Live call monitoring: token grants, room fan-out, websocket delivery.

The JS mint in api/calls.js produces the same token shape and signature —
tests/monitor-token.test.mjs cross-checks it against this scheme. These tests
assert the server side: verification, per-session isolation, the binary frame
layout the browser parses (1B direction + u32 LE rate + PCM16LE), bounded
queues that shed rather than lag, and the 'ended' signal on call end.
"""

import asyncio
import struct
import time

import pytest

from app.monitor import (
    MonitorHub,
    TokenError,
    get_hub,
    pack_monitor_frame,
    reset_hub,
    run_monitor_socket,
    sign_monitor_token,
    verify_monitor_token,
)

SECRET = "monitor-secret-test"


class TestMonitorTokens:
    def test_sign_then_verify_round_trip(self):
        token = sign_monitor_token(SECRET, session_id="call-42", user_id="user-1", ttl_secs=600)
        assert verify_monitor_token(SECRET, token, session_id="call-42") == "user-1"

    def test_token_shape_is_exp_user_sig(self):
        token = sign_monitor_token(SECRET, session_id="call-42", user_id="user-1", ttl_secs=600)
        exp, user, sig = token.split(".")
        assert user == "user-1"
        assert int(exp) > time.time()
        assert len(sig) == 64  # sha256 hex

    def test_cross_language_compatibility_with_the_js_mint(self):
        # api/calls.js monitorToken builds:
        #   exp = floor(now/1000)+6*3600
        #   sig = HMAC_SHA256(SECRET, `monitor:${sessionId}:${userId}:${exp}`).hex()
        #   token = `${exp}.${userId}.${sig}`
        import hashlib
        import hmac as hmac_mod

        exp = int(time.time()) + 6 * 3600
        expected = hmac_mod.new(
            SECRET.encode(), f"monitor:call-42:user-1:{exp}".encode(), hashlib.sha256
        ).hexdigest()
        token = f"{exp}.user-1.{expected}"
        assert verify_monitor_token(SECRET, token, session_id="call-42") == "user-1"

    def test_wrong_session_is_rejected(self):
        token = sign_monitor_token(SECRET, session_id="call-42", user_id="user-1", ttl_secs=600)
        with pytest.raises(TokenError):
            verify_monitor_token(SECRET, token, session_id="call-43")

    def test_expired_tokens_are_rejected(self):
        token = sign_monitor_token(SECRET, session_id="call-42", user_id="user-1", expires_at=int(time.time()) - 600)
        with pytest.raises(TokenError, match="expired"):
            verify_monitor_token(SECRET, token, session_id="call-42")

    def test_tampering_is_rejected(self):
        token = sign_monitor_token(SECRET, session_id="call-42", user_id="user-1", ttl_secs=600)
        exp, user, sig = token.split(".")
        with pytest.raises(TokenError):
            verify_monitor_token(SECRET, f"{exp}.user-2.{sig}", session_id="call-42")
        with pytest.raises(TokenError):
            verify_monitor_token(SECRET, f"{exp}.{user}.{sig[:-4]}beef", session_id="call-42")

    def test_missing_configuration_fails_loudly(self):
        with pytest.raises(TokenError):
            sign_monitor_token("", session_id="call-42", user_id="user-1")
        token = sign_monitor_token(SECRET, session_id="call-42", user_id="user-1")
        with pytest.raises(TokenError):
            verify_monitor_token("", token, session_id="call-42")


class TestFrameLayout:
    def test_frame_matches_the_browser_parser(self):
        # app.js parses: 1 byte direction, u32 LE sample rate, then Int16 LE.
        pcm = struct.pack("<4h", 0, 1000, -1000, 32767)
        frame = pack_monitor_frame(1, 16000, pcm)
        assert frame[0] == 1
        assert struct.unpack_from("<I", frame, 1)[0] == 16000
        assert frame[5:] == pcm


class TestMonitorHub:
    def test_frames_fan_out_to_all_subscribers_in_the_room(self):
        hub = MonitorHub()
        a = hub.subscribe("call-42")
        b = hub.subscribe("call-42")
        hub.publish("call-42", 1, 16000, b"\x01\x02")

        async def collect(sub):
            return await asyncio.wait_for(sub.get(), 1)

        async def run():
            frame_a, frame_b = await asyncio.gather(collect(a), collect(b))
            assert frame_a == frame_b == pack_monitor_frame(1, 16000, b"\x01\x02")

        asyncio.run(run())

    def test_rooms_are_isolated(self):
        hub = MonitorHub()
        a = hub.subscribe("call-42")
        b = hub.subscribe("call-43")
        hub.publish("call-43", 2, 24000, b"\xff")

        async def run():
            frame_b = await asyncio.wait_for(b.get(), 1)
            assert frame_b == pack_monitor_frame(2, 24000, b"\xff")
            assert a._queue.empty()

        asyncio.run(run())

    def test_slow_subscriber_queue_sheds_oldest_instead_of_lagging(self):
        hub = MonitorHub()
        sub = hub.subscribe("call-42")
        for i in range(300):
            hub.publish("call-42", 1, 16000, bytes([i % 256]))
        assert sub.frames_dropped > 0
        assert sub._queue.qsize() <= 150

    def test_close_room_signals_end_and_releases(self):
        hub = MonitorHub()
        sub = hub.subscribe("call-42")
        hub.publish("call-42", 1, 16000, b"\x01")
        hub.close_room("call-42")

        async def run():
            first = await asyncio.wait_for(sub.get(), 1)
            assert first == pack_monitor_frame(1, 16000, b"\x01")
            assert await asyncio.wait_for(sub.get(), 1) is None

        asyncio.run(run())
        assert hub.subscriber_count("call-42") == 0

    def test_subscription_cap_is_enforced(self):
        hub = MonitorHub(max_subscribers=2)
        assert hub.subscribe("call-42") is not None
        assert hub.subscribe("call-42") is not None
        assert hub.subscribe("call-42") is None  # third listener refused

    def test_publish_never_raises_without_listeners_or_audio(self):
        hub = MonitorHub()
        hub.publish("nobody-here", 1, 16000, b"\x01")
        sub = hub.subscribe("call-42")
        hub.publish("call-42", 1, 16000, b"")
        assert sub._queue.empty()


class _FakeWebSocket:
    def __init__(self):
        self.sent = []
        self.closed = False
        self._disconnect = asyncio.Event()

    async def send_bytes(self, data):
        self.sent.append(("bytes", data))

    async def send_json(self, data):
        self.sent.append(("json", data))

    async def close(self, code=1000):
        self.closed = True
        self._disconnect.set()

    async def receive(self):
        await self._disconnect.wait()
        return {"type": "websocket.disconnect"}


class TestMonitorSocket:
    def test_socket_delivers_frames_then_ended_on_call_close(self):
        async def run():
            hub = reset_hub()
            ws = _FakeWebSocket()
            task = asyncio.create_task(run_monitor_socket(ws, hub=hub, session_id="call-42"))
            await asyncio.sleep(0.05)
            assert hub.subscriber_count("call-42") == 1
            hub.publish("call-42", 1, 16000, b"\x07\x08")
            hub.publish("call-42", 2, 16000, b"\x09")
            await asyncio.sleep(0.2)  # pump delivers the two frames
            hub.close_room("call-42")
            await asyncio.wait_for(task, 2)
            kinds = [kind for kind, _ in ws.sent]
            assert kinds.count("bytes") == 2, ws.sent
            assert ws.sent[0] == ("bytes", pack_monitor_frame(1, 16000, b"\x07\x08"))
            assert ws.sent[1] == ("bytes", pack_monitor_frame(2, 16000, b"\x09"))
            assert ws.sent[-1] == ("json", {"type": "ended"})
            assert ws.closed
            assert hub.subscriber_count("call-42") == 0

        asyncio.run(run())

    def test_refused_when_the_room_is_full(self):
        async def run():
            hub = MonitorHub(max_subscribers=1)
            assert hub.subscribe("call-42") is not None
            ws = _FakeWebSocket()
            await asyncio.wait_for(run_monitor_socket(ws, hub=hub, session_id="call-42"), 2)
            assert ws.sent and ws.sent[0][1] == {"type": "error", "reason": "too-many-listeners"}

        asyncio.run(run())

    def test_client_disconnect_releases_the_slot(self):
        async def run():
            hub = reset_hub()
            ws = _FakeWebSocket()
            task = asyncio.create_task(run_monitor_socket(ws, hub=hub, session_id="call-42"))
            await asyncio.sleep(0.05)
            assert hub.subscriber_count("call-42") == 1
            await ws.close()  # browser tab goes away
            await asyncio.wait_for(task, 2)
            assert hub.subscriber_count("call-42") == 0

        asyncio.run(run())


class TestMonitorRoute:
    """The /monitor websocket must say WHY it refused or whether the AI is on the call."""

    def _client(self, monkeypatch):
        from fastapi.testclient import TestClient

        from app.config import Settings
        from app.main import create_app

        settings = Settings(bridge_secret=SECRET)
        return TestClient(create_app(settings))

    def test_bad_token_is_accepted_then_explained(self, monkeypatch):
        client = self._client(monkeypatch)
        with client.websocket_connect("/monitor/call-1?token=bad.token.value") as ws:
            msg = ws.receive_json()
            assert msg["type"] == "error"
            assert msg["reason"] == "auth-refused"

    def test_ready_reports_call_not_live(self, monkeypatch):
        client = self._client(monkeypatch)
        token = sign_monitor_token(SECRET, session_id="call-9", user_id="user-1", ttl_secs=600)
        with client.websocket_connect(f"/monitor/call-9?token={token}") as ws:
            msg = ws.receive_json()
            assert msg["type"] == "ready"
            assert msg["callLive"] is False


class TestLiveTranscript:
    def test_transcript_turns_reach_listeners_immediately_in_order(self):
        async def run():
            hub = reset_hub()
            ws = _FakeWebSocket()
            task = asyncio.create_task(run_monitor_socket(ws, hub=hub, session_id="call-9"))
            await asyncio.sleep(0.05)
            hub.publish_transcript("call-9", {"speaker": "ai", "content": "Hello, how are you?", "at": "t1"})
            hub.publish_transcript("call-9", {"speaker": "contact", "content": "Fine, thanks.", "at": "t2", "interrupted": True})
            await asyncio.sleep(0.1)
            hub.close_room("call-9")
            await asyncio.wait_for(task, 2)
            events = [d for kind, d in ws.sent if kind == "json" and d.get("type") == "transcript"]
            assert [e["seq"] for e in events] == [1, 2]
            assert events[0]["speaker"] == "ai" and events[0]["content"] == "Hello, how are you?"
            assert events[1].get("interrupted") is True

        asyncio.run(run())

    def test_listener_joining_mid_call_gets_a_snapshot(self):
        async def run():
            hub = reset_hub()
            hub.publish_transcript("call-9", {"speaker": "ai", "content": "Hi", "at": "t1"})
            hub.publish_transcript("call-9", {"speaker": "contact", "content": "Hello", "at": "t2"})
            ws = _FakeWebSocket()
            task = asyncio.create_task(run_monitor_socket(ws, hub=hub, session_id="call-9"))
            await asyncio.sleep(0.05)
            hub.close_room("call-9")
            await asyncio.wait_for(task, 2)
            snap = next(d for kind, d in ws.sent if kind == "json" and d.get("type") == "transcript_snapshot")
            assert [e["content"] for e in snap["entries"]] == ["Hi", "Hello"]

        asyncio.run(run())

    def test_captions_only_listener_gets_text_but_no_audio(self):
        async def run():
            hub = reset_hub()
            ws = _FakeWebSocket()
            task = asyncio.create_task(run_monitor_socket(ws, hub=hub, session_id="call-9", audio=False))
            await asyncio.sleep(0.05)
            hub.publish("call-9", 1, 16000, b"\x01\x02")
            hub.publish_transcript("call-9", {"speaker": "ai", "content": "Hi", "at": "t1"})
            await asyncio.sleep(0.1)
            hub.close_room("call-9")
            await asyncio.wait_for(task, 2)
            assert not [1 for kind, _ in ws.sent if kind == "bytes"], "no audio for a captions-only listener"
            assert any(d.get("type") == "transcript" for kind, d in ws.sent if kind == "json")

        asyncio.run(run())

    def test_transcript_log_hands_each_new_turn_to_on_entry_and_survives_a_bad_callback(self):
        from app.call_context import TranscriptLog

        seen = []
        log = TranscriptLog(object(), on_entry=lambda e: seen.append(e))
        log._schedule = lambda: None  # no DB in this test
        log.note("ai", "Hello there")
        log.note("contact", "Hi")
        assert [e["content"] for e in seen] == ["Hello there", "Hi"]
        assert [e["speaker"] for e in seen] == ["ai", "contact"]

        def boom(_):
            raise RuntimeError("feed down")

        log2 = TranscriptLog(object(), on_entry=boom)
        log2._schedule = lambda: None
        log2.note("ai", "Still recorded")  # must not raise
        assert log2.entries[0]["content"] == "Still recorded"
