"""Grok realtime client: session settings, caller audio up, reply events mapped to what the call needs."""

import base64
import json

import pytest

from app.grok_realtime import DEFAULT_VOICE, GrokRealtimeClient, build_session_update


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


def make_client(incoming, **kw):
    sock = FakeSocket(incoming)

    async def connect(url):
        assert url.startswith("wss://api.x.ai/v1/realtime")
        return sock

    update = build_session_update(instructions="APP BRAIN", voice_id=kw.pop("voice_id", "nlbqfwie"))
    return GrokRealtimeClient(api_key="xai-test", session_update=update, connect=connect), sock


def test_session_uses_the_app_brain_the_chosen_voice_and_16k_pcm_with_transcription():
    s = build_session_update(instructions="APP BRAIN", voice_id="nlbqfwie")
    assert s["instructions"] == "APP BRAIN"
    assert s["voice"] == "nlbqfwie"
    assert s["turn_detection"] == {"type": "server_vad"}
    assert s["audio"]["input"]["format"] == {"type": "audio/pcm", "rate": 16000}
    assert s["audio"]["output"]["format"] == {"type": "audio/pcm", "rate": 16000}
    assert s["audio"]["input"]["transcription"] == {"model": "grok-transcribe"}


def test_no_chosen_voice_uses_the_built_in_default():
    assert build_session_update(instructions="x", voice_id=None)["voice"] == DEFAULT_VOICE


@pytest.mark.asyncio
async def test_start_sends_the_session_first_then_caller_audio_as_base64():
    client, sock = make_client([])
    await client.start()
    assert sock.sent[0]["type"] == "session.update"
    assert sock.sent[0]["session"]["voice"] == "nlbqfwie"
    await client.send_caller_audio(b"\x01\x02")
    await client.send_caller_audio(b"")  # empty is not sent
    appends = [m for m in sock.sent if m["type"] == "input_audio_buffer.append"]
    assert [base64.b64decode(m["audio"]) for m in appends] == [b"\x01\x02"]


@pytest.mark.asyncio
async def test_reply_events_are_mapped_for_audio_barge_in_transcripts_and_errors():
    pcm = b"\x10\x00" * 160
    client, _ = make_client([
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
async def test_greeting_is_sent_as_an_interruptible_force_message():
    client, sock = make_client([])
    await client.start()
    await client.send_greeting("Hi, Emysa here.")
    item = sock.sent[-1]["item"]
    assert item["type"] == "force_message"
    assert item["interruptible"] is True
    assert item["content"][0]["text"] == "Hi, Emysa here."


@pytest.mark.asyncio
async def test_close_closes_the_socket_and_sending_after_close_fails():
    client, sock = make_client([])
    await client.start()
    await client.close()
    assert sock.closed is True
    with pytest.raises(RuntimeError):
        await client.send_caller_audio(b"\x00")
