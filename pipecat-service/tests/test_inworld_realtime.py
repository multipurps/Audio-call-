"""Inworld realtime client: the session the call uses, its auth, and the events it maps."""

import base64
import json

import pytest

from app.inworld_realtime import REALTIME_BASE, InworldRealtimeClient, build_inworld_session


class FakeSocket:
    def __init__(self, incoming):
        self._incoming = [json.dumps(m) for m in incoming]
        self.sent: list[dict] = []
        self.closed = False

    async def send(self, text):
        self.sent.append(json.loads(text))

    async def close(self):
        self.closed = True

    def __aiter__(self):
        return self._gen()

    async def _gen(self):
        for m in self._incoming:
            yield m


def make_client(incoming, voice="ws__my_clone", session_id="abc123"):
    sock = FakeSocket(incoming)
    seen = {}

    async def connect(url, headers):
        seen["url"], seen["headers"] = url, headers
        return sock

    update = build_inworld_session(instructions="APP BRAIN", voice_id=voice)
    client = InworldRealtimeClient(api_key="a2V5OnNlY3JldA==", session_update=update, connect=connect, session_id=session_id)
    return client, sock, seen


def test_session_uses_the_app_brain_the_chosen_clone_and_16k_pcm_both_ways():
    s = build_inworld_session(instructions="APP BRAIN", voice_id="ws__my_clone", rate=16000)
    assert s["type"] == "realtime"
    assert s["instructions"] == "APP BRAIN"
    assert s["audio"]["output"]["voice"] == "ws__my_clone"
    assert s["audio"]["output"]["model"] == "inworld-tts-2"
    assert s["audio"]["input"]["format"] == {"type": "audio/pcm", "rate": 16000}
    assert s["audio"]["output"]["format"] == {"type": "audio/pcm", "rate": 16000}
    assert s["audio"]["input"]["transcription"] == {"model": "inworld/inworld-stt-1"}


@pytest.mark.asyncio
async def test_connects_to_the_session_endpoint_with_basic_auth_then_sends_the_session():
    client, sock, seen = make_client([])
    await client.start()
    assert seen["url"] == f"{REALTIME_BASE}?key=abc123&protocol=realtime"
    assert seen["headers"] == {"Authorization": "Basic a2V5OnNlY3JldA=="}
    assert sock.sent[0]["type"] == "session.update"


@pytest.mark.asyncio
async def test_caller_audio_goes_up_as_base64_and_the_greeting_is_spoken_without_the_model():
    client, sock, _ = make_client([])
    await client.start()
    await client.send_caller_audio(b"\x01\x02")
    await client.send_caller_audio(b"")
    await client.send_greeting("Hi, Emysa here.")
    appends = [m for m in sock.sent if m["type"] == "input_audio_buffer.append"]
    assert [base64.b64decode(m["audio"]) for m in appends] == [b"\x01\x02"]
    assert sock.sent[-1] == {"type": "response.speak", "text": "Hi, Emysa here."}


@pytest.mark.asyncio
async def test_reply_events_map_to_audio_barge_in_transcripts_and_errors():
    pcm = b"\x10\x00" * 160
    client, _, _ = make_client([
        {"type": "response.output_audio.delta", "delta": base64.b64encode(pcm).decode()},
        {"type": "input_audio_buffer.speech_started"},
        {"type": "conversation.item.input_audio_transcription.completed", "transcript": "I need a ride"},
        {"type": "response.output_audio_transcript.done", "transcript": "Where to?"},
        {"type": "error", "error": {"message": "bad request"}},
        {"type": "session.updated"},
    ])
    await client.start()
    events = [e async for e in client.events()]
    assert [e.kind for e in events] == ["audio", "interrupted", "user_transcript", "agent_transcript", "error", "other"]
    assert events[0].audio == pcm
    assert events[2].text == "I need a ride"
    assert events[3].text == "Where to?"
    assert events[4].text == "bad request"


@pytest.mark.asyncio
async def test_close_closes_the_socket_and_sending_after_close_fails():
    client, sock, _ = make_client([])
    await client.start()
    await client.close()
    assert sock.closed is True
    with pytest.raises(RuntimeError):
        await client.send_caller_audio(b"\x00")
