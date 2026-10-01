"""Live notes: authenticated, reach only the right call, never run the model."""

import pytest
from fastapi.testclient import TestClient

from app import conversation as conv
from app.config import Settings
from app.main import create_app

SECRET = "x" * 32


class _Ctx:
    def __init__(self):
        self.messages = []

    def add_message(self, m):
        self.messages.append(m)


def _live(session_id="call-1"):
    c = conv.CallConversation.__new__(conv.CallConversation)
    c._session_id = session_id
    c._stopped = False
    c._context = _Ctx()
    conv._LIVE_CONVERSATIONS[session_id] = c
    return c


@pytest.fixture
def client():
    settings = Settings(mock_mode=True, bridge_secret=SECRET)
    with TestClient(create_app(settings)) as c:
        yield c
    conv._LIVE_CONVERSATIONS.clear()


def test_note_added_to_context_without_running_model(client):
    c = _live()
    r = client.post("/calls/call-1/note", json={"text": " tell   her we are late "},
                    headers={"Authorization": f"Bearer {SECRET}"})
    assert r.status_code == 200
    msg = c._context.messages[0]
    assert msg["role"] == "system"
    assert msg["content"].startswith(conv.OPERATOR_NOTE_PREFIX)
    assert msg["content"].endswith("tell her we are late")


def test_rejects_bad_secret_and_unknown_call(client):
    _live()
    assert client.post("/calls/call-1/note", json={"text": "hi"},
                       headers={"Authorization": "Bearer wrong"}).status_code == 401
    assert client.post("/calls/call-1/note", json={"text": "hi"}).status_code == 401
    assert client.post("/calls/other/note", json={"text": "hi"},
                       headers={"Authorization": f"Bearer {SECRET}"}).status_code == 409


def test_empty_note_and_stopped_call_refused(client):
    c = _live()
    h = {"Authorization": f"Bearer {SECRET}"}
    assert client.post("/calls/call-1/note", json={"text": "  "}, headers=h).status_code == 400
    c._stopped = True
    assert client.post("/calls/call-1/note", json={"text": "hi"}, headers=h).status_code == 409
