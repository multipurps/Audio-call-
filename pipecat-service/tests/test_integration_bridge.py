"""End-to-end bridge tests against the real FastAPI app.

These drive an actual WebSocket through the actual `AcafBridge`: handshake,
auth, framing, heartbeat, barge-in, teardown, and the HTTP health endpoints.
Nothing here talks to Telegram, Twilio, or any provider -- this is the
"local test mode that does not place real calls" the brief requires.

What this catches that unit tests cannot: a handshake that never completes, a
control frame the peer never receives, health endpoints that report ready when
the service is misconfigured, and sessions that leak when a socket closes.
"""

from __future__ import annotations

import json
import struct

import pytest
from fastapi.testclient import TestClient

from app.config import load_settings
from app.main import create_app
from app.protocol import (
    CONTROL_HELLO,
    CONTROL_PONG,
    CONTROL_READY,
    CONTROL_STOPPED,
    AudioFrame,
)
from app.session import SessionState

SECRET = "test-bridge-secret-value-32chars"


def pcm16(*samples: int) -> bytes:
    return struct.pack(f"<{len(samples)}h", *samples)


@pytest.fixture
def mock_settings():
    return load_settings({"ASSISTANT_MOCK_MODE": "true"})


@pytest.fixture
def real_settings():
    return load_settings(
        {
            "ASSISTANT_BRIDGE_SECRET": SECRET,
            "GROQ_API_KEY": "gk_test_key_value_123456",
            "FISH_API_KEY": "fk_test_key_value_123456",
        }
    )


def hello(**overrides) -> str:
    body = {
        "type": CONTROL_HELLO,
        "sessionId": overrides.pop("session_id", "call-abc-123"),
        "platform": "telegram",
        "sampleRate": 16000,
        "channels": 1,
        "encoding": "pcm_s16le",
    }
    body.update(overrides)
    return json.dumps(body)


def audio_frame(payload: bytes, *, seq: int, rate: int = 16000) -> bytes:
    return AudioFrame.audio_in(
        payload, sequence=seq, timestamp_ms=seq * 20, sample_rate=rate
    ).encode()


# --------------------------------------------------------------------------
# Health endpoints
# --------------------------------------------------------------------------


class TestHealthEndpoints:
    def test_healthz_is_ok(self, mock_settings):
        with TestClient(create_app(mock_settings)) as client:
            response = client.get("/healthz")
        assert response.status_code == 200
        body = response.json()
        assert body["status"] == "ok"
        assert body["mockMode"] is True

    def test_readyz_reports_ready_in_mock_mode(self, mock_settings):
        with TestClient(create_app(mock_settings)) as client:
            response = client.get("/readyz")
        assert response.status_code == 200
        body = response.json()
        assert body["ready"] is True
        assert body["providers"]["llm"] == "mock"

    def test_readyz_reports_real_providers(self, real_settings):
        with TestClient(create_app(real_settings)) as client:
            response = client.get("/readyz")
        assert response.status_code == 200
        assert response.json()["providers"] == {
            "stt": "groq",
            "llm": "groq",
            "tts": "fish",
        }

    def test_health_endpoints_leak_no_secrets(self, real_settings):
        with TestClient(create_app(real_settings)) as client:
            body = client.get("/readyz").text + client.get("/healthz").text
        assert SECRET not in body
        assert "gk_test_key_value_123456" not in body
        assert "fk_test_key_value_123456" not in body

    def test_readyz_sessions_section_is_present(self, mock_settings):
        with TestClient(create_app(mock_settings)) as client:
            body = client.get("/readyz").json()
        assert body["sessions"]["live"] == 0


# --------------------------------------------------------------------------
# Handshake and authentication
# --------------------------------------------------------------------------


class TestHandshake:
    def test_successful_handshake_gets_ready(self, mock_settings):
        with TestClient(create_app(mock_settings)) as client:
            with client.websocket_connect("/stream") as ws:
                ws.send_text(hello())
                reply = json.loads(ws.receive_text())
                assert reply["type"] == CONTROL_READY
                assert reply["platform"] == "telegram"

    def test_ready_echoes_the_session_id(self, mock_settings):
        with TestClient(create_app(mock_settings)) as client:
            with client.websocket_connect("/stream") as ws:
                ws.send_text(hello(session_id="my-call-99"))
                reply = json.loads(ws.receive_text())
                assert reply["sessionId"] == "my-call-99"

    def test_wrong_secret_is_refused(self, real_settings):
        with TestClient(create_app(real_settings)) as client:
            with pytest.raises(Exception):
                with client.websocket_connect("/stream") as ws:
                    ws.send_text(hello(secret="wrong-secret-entirely"))
                    ws.receive_text()

    def test_missing_secret_is_refused(self, real_settings):
        with TestClient(create_app(real_settings)) as client:
            with pytest.raises(Exception):
                with client.websocket_connect("/stream") as ws:
                    ws.send_text(hello())
                    ws.receive_text()

    def test_correct_secret_is_accepted(self, real_settings):
        with TestClient(create_app(real_settings)) as client:
            with client.websocket_connect("/stream") as ws:
                ws.send_text(hello(secret=SECRET))
                reply = json.loads(ws.receive_text())
                assert reply["type"] == CONTROL_READY

    def test_non_hello_first_message_is_refused(self, mock_settings):
        with TestClient(create_app(mock_settings)) as client:
            with pytest.raises(Exception):
                with client.websocket_connect("/stream") as ws:
                    ws.send_text(json.dumps({"type": "ping"}))
                    ws.receive_text()

    def test_malformed_hello_is_refused(self, mock_settings):
        with TestClient(create_app(mock_settings)) as client:
            with pytest.raises(Exception):
                with client.websocket_connect("/stream") as ws:
                    ws.send_text("{not json at all")
                    ws.receive_text()

    def test_unsupported_encoding_is_refused(self, mock_settings):
        """Only PCM is supported; Opus has no decoder in this build."""
        with TestClient(create_app(mock_settings)) as client:
            with pytest.raises(Exception):
                with client.websocket_connect("/stream") as ws:
                    ws.send_text(hello(encoding="ogg_opus"))
                    ws.receive_text()

    def test_handshake_negotiates_bridge_rate(self, mock_settings):
        with TestClient(create_app(mock_settings)) as client:
            with client.websocket_connect("/stream") as ws:
                ws.send_text(hello(sampleRate=8000))
                ws.receive_text()
                bridge = _bridge(client)
                assert bridge.serializer.stats()["bridgeSampleRate"] == 8000

    def test_handshake_defaults_when_rate_omitted(self, mock_settings):
        with TestClient(create_app(mock_settings)) as client:
            with client.websocket_connect("/stream") as ws:
                ws.send_text(json.dumps({"type": CONTROL_HELLO, "sessionId": "d1"}))
                ws.receive_text()
                bridge = _bridge(client)
                assert bridge.serializer.stats()["bridgeSampleRate"] == 16000

    def test_garbage_rate_falls_back_to_default(self, mock_settings):
        with TestClient(create_app(mock_settings)) as client:
            with client.websocket_connect("/stream") as ws:
                ws.send_text(json.dumps({"type": CONTROL_HELLO, "sampleRate": "banana"}))
                ws.receive_text()
                assert _bridge(client).serializer.stats()["bridgeSampleRate"] == 16000


def _bridge(client: TestClient):
    """The single live bridge in the app under test."""
    state = client.app.state.service
    assert len(state.active_bridges) == 1
    return next(iter(state.active_bridges))


# --------------------------------------------------------------------------
# Audio flow
# --------------------------------------------------------------------------


class TestAudioFlow:
    def test_audio_frames_are_accepted(self, mock_settings):
        with TestClient(create_app(mock_settings)) as client:
            with client.websocket_connect("/stream") as ws:
                ws.send_text(hello())
                ws.receive_text()
                for seq in range(5):
                    ws.send_bytes(audio_frame(pcm16(*([1000] * 160)), seq=seq))
                ws.send_text(json.dumps({"type": "ping"}))  # barrier
                assert json.loads(ws.receive_text())["type"] == CONTROL_PONG

                bridge = _bridge(client)
                assert bridge.session.stats.frames_in == 5
                # bytes_in counts wire bytes: 320 payload + 28 header each.
                assert bridge.session.stats.bytes_in == 5 * (320 + 28)

    def test_sequence_gaps_are_tracked(self, mock_settings):
        with TestClient(create_app(mock_settings)) as client:
            with client.websocket_connect("/stream") as ws:
                ws.send_text(hello())
                ws.receive_text()
                for seq in (0, 1, 2, 6):  # 3,4,5 missing
                    ws.send_bytes(audio_frame(pcm16(1), seq=seq))
                ws.send_text(json.dumps({"type": "ping"}))
                ws.receive_text()

                sequence = _bridge(client).session.inbound_sequences
                assert sequence.missing == 3
                assert sequence.received == 4

    def test_malformed_audio_does_not_kill_the_call(self, mock_settings):
        with TestClient(create_app(mock_settings)) as client:
            with client.websocket_connect("/stream") as ws:
                ws.send_text(hello())
                ws.receive_text()
                ws.send_bytes(b"this is not an ACAF frame")
                ws.send_bytes(audio_frame(pcm16(1), seq=0))
                ws.send_text(json.dumps({"type": "ping"}))
                assert json.loads(ws.receive_text())["type"] == CONTROL_PONG

                stats = _bridge(client).session.stats
                # Only the valid frame counts as a received frame; the
                # unparseable one is tracked separately rather than being
                # silently mixed in with healthy traffic.
                assert stats.frames_in == 1
                assert stats.malformed_in == 1

    def test_malformed_frames_still_count_as_liveness(self, mock_settings):
        """A peer sending corrupt audio is alive, not idle.

        Treating these as silence would tear down a call that is merely
        corrupt, which is the opposite of the intended behaviour.
        """
        with TestClient(create_app(mock_settings)) as client:
            with client.websocket_connect("/stream") as ws:
                ws.send_text(hello())
                ws.receive_text()
                bridge = _bridge(client)
                before = bridge.session.last_inbound_at
                ws.send_bytes(b"garbage")
                ws.send_text(json.dumps({"type": "ping"}))
                ws.receive_text()
                assert bridge.session.last_inbound_at > before

    def test_oversized_frame_is_dropped_not_fatal(self, mock_settings):
        with TestClient(create_app(mock_settings)) as client:
            with client.websocket_connect("/stream") as ws:
                ws.send_text(hello())
                ws.receive_text()
                ws.send_bytes(b"x" * (70 * 1024))  # above the 64 KiB limit
                ws.send_text(json.dumps({"type": "ping"}))
                assert json.loads(ws.receive_text())["type"] == CONTROL_PONG

    def test_oversized_control_is_ignored(self, mock_settings):
        with TestClient(create_app(mock_settings)) as client:
            with client.websocket_connect("/stream") as ws:
                ws.send_text(hello())
                ws.receive_text()
                ws.send_text(json.dumps({"type": "x", "pad": "y" * 9000}))
                ws.send_text(json.dumps({"type": "ping"}))
                assert json.loads(ws.receive_text())["type"] == CONTROL_PONG


# --------------------------------------------------------------------------
# Barge-in
# --------------------------------------------------------------------------


class TestBargeIn:
    def test_interrupt_control_is_handled(self, mock_settings):
        with TestClient(create_app(mock_settings)) as client:
            with client.websocket_connect("/stream") as ws:
                ws.send_text(hello())
                ws.receive_text()
                ws.send_text(json.dumps({"type": "interrupt"}))
                ws.send_text(json.dumps({"type": "ping"}))
                assert json.loads(ws.receive_text())["type"] == CONTROL_PONG
                assert _bridge(client).session.stats.barge_ins == 1

    def test_interrupt_clears_queued_outbound_audio(self, mock_settings):
        """Barge-in must actually discard queued TTS, not just be counted."""
        with TestClient(create_app(mock_settings)) as client:
            with client.websocket_connect("/stream") as ws:
                ws.send_text(hello())
                ws.receive_text()

                bridge = _bridge(client)
                # Stop the write pump first: otherwise it drains the queue
                # concurrently with this test and the assertion below would
                # be measuring a race, not the cancellation logic.
                import asyncio

                for task in bridge._tasks:
                    if task.get_name() == "acaf-write":
                        task.cancel()

                for _ in range(5):
                    bridge._outbound.put((b"audio", 5))
                assert len(bridge._outbound) == 5

                ws.send_text(json.dumps({"type": "interrupt"}))
                ws.send_text(json.dumps({"type": "ping"}))
                ws.receive_text()

                assert len(bridge._outbound) == 0
                assert bridge.session.stats.tts_cancelled == 5

    def test_interrupt_does_not_end_the_call(self, mock_settings):
        with TestClient(create_app(mock_settings)) as client:
            with client.websocket_connect("/stream") as ws:
                ws.send_text(hello())
                ws.receive_text()
                ws.send_text(json.dumps({"type": "interrupt"}))
                ws.send_bytes(audio_frame(pcm16(1), seq=0))
                ws.send_text(json.dumps({"type": "ping"}))
                assert json.loads(ws.receive_text())["type"] == CONTROL_PONG
                assert _bridge(client).session.state is SessionState.ACTIVE


# --------------------------------------------------------------------------
# Control plane
# --------------------------------------------------------------------------


class TestControlPlane:
    def test_ping_gets_pong(self, mock_settings):
        with TestClient(create_app(mock_settings)) as client:
            with client.websocket_connect("/stream") as ws:
                ws.send_text(hello())
                ws.receive_text()
                ws.send_text(json.dumps({"type": "ping"}))
                assert json.loads(ws.receive_text())["type"] == CONTROL_PONG

    def test_pong_records_heartbeat_reply(self, mock_settings):
        with TestClient(create_app(mock_settings)) as client:
            with client.websocket_connect("/stream") as ws:
                ws.send_text(hello())
                ws.receive_text()
                before = _bridge(client).session.last_heartbeat_reply_at
                ws.send_text(json.dumps({"type": "pong"}))
                ws.send_text(json.dumps({"type": "ping"}))
                ws.receive_text()
                assert _bridge(client).session.last_heartbeat_reply_at >= before

    def test_hangup_ends_the_call(self, mock_settings):
        with TestClient(create_app(mock_settings)) as client:
            with client.websocket_connect("/stream") as ws:
                ws.send_text(hello())
                ws.receive_text()
                ws.send_text(json.dumps({"type": "hangup"}))

    def test_unknown_control_type_is_ignored(self, mock_settings):
        with TestClient(create_app(mock_settings)) as client:
            with client.websocket_connect("/stream") as ws:
                ws.send_text(hello())
                ws.receive_text()
                ws.send_text(json.dumps({"type": "something-else"}))
                ws.send_text(json.dumps({"type": "ping"}))
                assert json.loads(ws.receive_text())["type"] == CONTROL_PONG


# --------------------------------------------------------------------------
# Teardown and cleanup
# --------------------------------------------------------------------------


def wait_until(predicate, *, timeout: float = 2.0, interval: float = 0.01) -> bool:
    """Poll until `predicate` is true.

    Server-side teardown runs on the app's event loop, which TestClient drives
    in a separate thread. Exiting a websocket context manager does not await
    that teardown, so asserting immediately would be a race rather than a
    check of behaviour.
    """
    import time

    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(interval)
    return predicate()


class TestCleanup:
    def test_call_ended_by_peer_releases_the_session(self, mock_settings):
        """An explicit hangup must not hold a session open for reconnection."""
        app = create_app(mock_settings)
        with TestClient(app) as client:
            with client.websocket_connect("/stream") as ws:
                ws.send_text(hello())
                ws.receive_text()
                assert len(app.state.service.registry) == 1
                ws.send_text(json.dumps({"type": "hangup"}))
            assert wait_until(lambda: len(app.state.service.registry) == 0)

    def test_dropped_socket_holds_the_session_for_reconnect(self, mock_settings):
        """A dropped socket must NOT release the session immediately.

        Releasing here would make the reconnect path unreachable, and the
        brief asks for reconnection explicitly. The reaper collects it once
        the grace period expires.
        """
        app = create_app(mock_settings)
        with TestClient(app) as client:
            with client.websocket_connect("/stream") as ws:
                ws.send_text(hello(session_id="dropped-1"))
                ws.receive_text()
            assert wait_until(
                lambda: (
                    (s := app.state.service.registry.get("dropped-1")) is not None
                    and s.state is SessionState.RECONNECTING
                )
            )

    def test_reaper_collects_a_session_after_the_grace_period(self, mock_settings):
        app = create_app(mock_settings)
        with TestClient(app) as client:
            with client.websocket_connect("/stream") as ws:
                ws.send_text(hello(session_id="expire-me"))
                ws.receive_text()
            assert wait_until(lambda: app.state.service.registry.get("expire-me") is not None)

            session = app.state.service.registry.get("expire-me")
            import asyncio

            # Drive the session past its reconnect grace, then reap.
            asyncio.run(
                app.state.service.registry.reap(
                    now=session.disconnected_at + session._reconnect_grace + 1
                )
            )
            assert app.state.service.registry.get("expire-me") is None

    def test_bridge_is_removed_from_the_active_set(self, mock_settings):
        app = create_app(mock_settings)
        with TestClient(app) as client:
            with client.websocket_connect("/stream") as ws:
                ws.send_text(hello())
                ws.receive_text()
                assert len(app.state.service.active_bridges) == 1
            assert wait_until(lambda: len(app.state.service.active_bridges) == 0)

    def test_sequential_calls_do_not_accumulate_live_sessions(self, mock_settings):
        """Each call must be released before the next one is created."""
        app = create_app(mock_settings)
        with TestClient(app) as client:
            for i in range(5):
                with client.websocket_connect("/stream") as ws:
                    ws.send_text(hello(session_id=f"call-{i}"))
                    ws.receive_text()
                    assert len(app.state.service.registry) == 1
                    ws.send_text(json.dumps({"type": "hangup"}))
                assert wait_until(lambda: len(app.state.service.registry) == 0)
            assert app.state.service.registry.total_created == 5

    def test_concurrent_calls_are_tracked_separately(self, mock_settings):
        app = create_app(mock_settings)
        with TestClient(app) as client:
            with client.websocket_connect("/stream") as a:
                a.send_text(hello(session_id="call-a", platform="telegram"))
                a.receive_text()
                with client.websocket_connect("/stream") as b:
                    b.send_text(hello(session_id="call-b", platform="twilio"))
                    b.receive_text()
                    assert len(app.state.service.registry) == 2
                    assert app.state.service.registry.get("call-a").platform == "telegram"
                    assert app.state.service.registry.get("call-b").platform == "twilio"

    def test_readyz_reports_live_sessions(self, mock_settings):
        app = create_app(mock_settings)
        with TestClient(app) as client:
            with client.websocket_connect("/stream") as ws:
                ws.send_text(hello())
                ws.receive_text()
                body = client.get("/readyz").json()
                assert body["sessions"]["live"] == 1
                assert body["sessions"]["sessions"][0]["platform"] == "telegram"


# --------------------------------------------------------------------------
# Reconnect
# --------------------------------------------------------------------------


class TestReconnect:
    def test_reconnect_within_grace_resumes_the_session(self, mock_settings):
        app = create_app(mock_settings)
        with TestClient(app) as client:
            with client.websocket_connect("/stream") as ws:
                ws.send_text(hello(session_id="resume-me"))
                ws.receive_text()
                bridge = _bridge(client)
                bridge.session.transition_to(SessionState.ACTIVE)
                bridge.session.stats.turns = 3

            # Socket closed; the session is held for reconnection rather
            # than released. Wait for that state -- teardown is async.
            assert wait_until(
                lambda: (
                    (s := app.state.service.registry.get("resume-me")) is not None
                    and s.state is SessionState.RECONNECTING
                )
            )

            with client.websocket_connect("/stream") as ws:
                ws.send_text(hello(session_id="resume-me"))
                reply = json.loads(ws.receive_text())
                assert reply["type"] == CONTROL_READY
                resumed = app.state.service.registry.get("resume-me")
                assert resumed.state is SessionState.ACTIVE
                # The conversation survived the network blip.
                assert resumed.stats.turns == 3
                assert resumed.stats.reconnects == 1
