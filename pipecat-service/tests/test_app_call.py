"""In-app Emysa call: browser websocket reusing the ACAF conversation."""

import json
import struct
import time

import pytest
from fastapi.testclient import TestClient

from app.app_call import (
    AppCallTokenError,
    sign_app_call_token,
    verify_app_call_token,
)
from app.config import Settings
from app.main import create_app

SECRET = "app-call-secret-test"


class TestAppCallToken:
    def test_round_trip(self):
        t = sign_app_call_token(SECRET, session_id="call-1", user_id="user-1")
        assert verify_app_call_token(SECRET, t, session_id="call-1") == "user-1"

    def test_other_session_refused(self):
        t = sign_app_call_token(SECRET, session_id="call-1", user_id="user-1")
        with pytest.raises(AppCallTokenError):
            verify_app_call_token(SECRET, t, session_id="call-2")

    def test_monitor_token_cannot_open_an_app_call(self):
        from app.monitor import sign_monitor_token

        t = sign_monitor_token(SECRET, session_id="call-1", user_id="user-1")
        with pytest.raises(AppCallTokenError):
            verify_app_call_token(SECRET, t, session_id="call-1")

    def test_expired_and_forged_refused(self):
        old = sign_app_call_token(SECRET, session_id="c", user_id="u", expires_at=int(time.time()) - 600)
        with pytest.raises(AppCallTokenError):
            verify_app_call_token(SECRET, old, session_id="c")
        with pytest.raises(AppCallTokenError):
            verify_app_call_token("other-secret", sign_app_call_token(SECRET, session_id="c", user_id="u"), session_id="c")


def _client():
    return TestClient(create_app(Settings(bridge_secret=SECRET)))


class TestAppCallRoute:
    def test_bad_token_is_explained_not_silent(self):
        with _client().websocket_connect("/app-call/call-1?token=bad.token.here") as ws:
            msg = ws.receive_json()
            assert msg["type"] == "error"
            assert msg["reason"] == "auth-refused"

    def test_valid_token_gets_ready_and_can_hang_up(self):
        token = sign_app_call_token(SECRET, session_id="call-77", user_id="user-1")
        with _client().websocket_connect(f"/app-call/call-77?token={token}") as ws:
            seen = []
            for _ in range(5):
                m = ws.receive()
                if m.get("text"):
                    seen.append(json.loads(m["text"])["type"])
                if "ready" in seen:
                    break
            assert "ready" in seen
            ws.send_bytes(struct.pack("<320h", *([1000] * 320)))
            ws.send_text(json.dumps({"type": "hangup"}))
