"""The app ending a call stops the assistant side of the bridge, once, deliberately."""

import json
import types

import pytest

from app.transport import AcafBridge


class FakeSocket:
    def __init__(self) -> None:
        self.sent: list[str] = []

    async def send_text(self, text: str) -> None:
        self.sent.append(text)


class FakeSession:
    def __init__(self, session_id: str, queued: int = 3) -> None:
        self.session_id = session_id
        self._queued = queued

    def cancel_outbound(self) -> int:
        dropped, self._queued = self._queued, 0
        return dropped


def make_bridge(session: FakeSession | None) -> tuple[AcafBridge, FakeSocket]:
    ws = FakeSocket()
    bridge = AcafBridge(websocket=ws, settings=types.SimpleNamespace(), registry=None)  # type: ignore[arg-type]
    bridge.session = session  # type: ignore[assignment]
    return bridge, ws


@pytest.mark.asyncio
async def test_request_hangup_tells_the_peer_then_closes_and_drops_queued_audio():
    bridge, ws = make_bridge(FakeSession("call-WA-1", queued=5))

    assert await bridge.request_hangup("app-hangup") is True

    hangups = [json.loads(t) for t in ws.sent if json.loads(t).get("type") == "hangup"]
    assert len(hangups) == 1
    assert hangups[0]["reason"] == "app-hangup"
    assert bridge._closed.is_set()
    assert bridge._peer_ended is True, "must count as a deliberate end, not a dropped socket"
    assert bridge._frames_dropped == 5


@pytest.mark.asyncio
async def test_request_hangup_is_idempotent():
    bridge, ws = make_bridge(FakeSession("call-WA-2"))
    assert await bridge.request_hangup() is True
    assert await bridge.request_hangup() is True
    hangups = [t for t in ws.sent if json.loads(t).get("type") == "hangup"]
    assert len(hangups) == 1


@pytest.mark.asyncio
async def test_request_hangup_with_nothing_live_returns_false():
    bridge, ws = make_bridge(None)
    bridge._closed.set()
    assert await bridge.request_hangup() is False
    assert ws.sent == []
