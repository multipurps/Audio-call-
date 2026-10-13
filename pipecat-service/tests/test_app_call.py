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


class _ScriptedSocket:
    """A browser websocket whose incoming messages the test feeds in by hand."""

    def __init__(self) -> None:
        import asyncio

        self.incoming: "asyncio.Queue[dict]" = asyncio.Queue()
        self.sent: list = []

    async def receive(self) -> dict:
        return await self.incoming.get()

    async def send_text(self, text: str) -> None:
        self.sent.append(text)

    async def send_bytes(self, data: bytes) -> None:
        self.sent.append(data)

    async def close(self, code: int = 1000) -> None:
        pass


class TestStaleUplinkAudio:
    """Mic audio that piled up while the call was starting must not be replayed."""

    async def test_backlog_is_dropped_and_fresh_audio_is_delivered(self, monkeypatch):
        import asyncio

        from app import app_call
        from app.protocol import AudioFrame

        monkeypatch.setattr(app_call, "STALE_UPLINK_SECS", 0.1)
        ws = _ScriptedSocket()
        peer = app_call.BrowserAcafSocket(ws, secret="s", session_id="call-1", user_id="u1")
        await peer.receive_text()  # the bridge reads the hello first, which starts the reader

        for _ in range(5):  # the browser streams while the service is still starting
            ws.incoming.put_nowait({"type": "websocket.receive", "bytes": b"\x01\x00" * 320})
        await asyncio.sleep(0.25)  # longer than STALE_UPLINK_SECS: the bridge was not reading yet
        ws.incoming.put_nowait({"type": "websocket.receive", "bytes": b"\x02\x00" * 320})

        message = await asyncio.wait_for(peer.receive(), timeout=2)
        frame = AudioFrame.decode(message["bytes"])
        assert frame.payload == b"\x02\x00" * 320  # the fresh frame, not the first stale one
        assert frame.sequence == 1  # stale frames never consumed a sequence number
        await peer.close()

    async def test_control_messages_and_disconnect_survive_the_backlog(self, monkeypatch):
        import asyncio
        import json

        from app import app_call

        monkeypatch.setattr(app_call, "STALE_UPLINK_SECS", 0.1)
        ws = _ScriptedSocket()
        peer = app_call.BrowserAcafSocket(ws, secret="s", session_id="call-1", user_id="u1")
        await peer.receive_text()

        ws.incoming.put_nowait({"type": "websocket.receive", "bytes": b"\x01\x00" * 320})
        ws.incoming.put_nowait({"type": "websocket.receive", "text": json.dumps({"type": "hangup"})})
        ws.incoming.put_nowait({"type": "websocket.disconnect"})
        await asyncio.sleep(0.25)

        first = await asyncio.wait_for(peer.receive(), timeout=2)
        assert json.loads(first["text"])["type"] == "hangup"  # old, but never dropped
        second = await asyncio.wait_for(peer.receive(), timeout=2)
        assert second["type"] == "websocket.disconnect"
        await peer.close()

    async def test_fresh_audio_is_untouched(self):
        import asyncio

        from app import app_call
        from app.protocol import AudioFrame

        ws = _ScriptedSocket()
        peer = app_call.BrowserAcafSocket(ws, secret="s", session_id="call-1", user_id="u1")
        await peer.receive_text()
        for i in range(3):
            ws.incoming.put_nowait({"type": "websocket.receive", "bytes": bytes([i + 1, 0]) * 320})
        got = []
        for _ in range(3):
            message = await asyncio.wait_for(peer.receive(), timeout=2)
            got.append(AudioFrame.decode(message["bytes"]).sequence)
        assert got == [1, 2, 3]
        await peer.close()
