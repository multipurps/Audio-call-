"""ElevenLabs agent protocol client: init, caller audio, agent audio, ping, interruption."""

import base64
import json

import pytest

from app.elevenlabs_agent import AGENT_WS_URL, ElevenLabsAgentClient


class FakeSocket:
    def __init__(self, incoming: list[dict]) -> None:
        self._incoming = [json.dumps(m) for m in incoming]
        self.sent: list[dict] = []
        self.closed = False

    async def send(self, text: str) -> None:
        self.sent.append(json.loads(text))

    async def recv(self):
        return self._incoming.pop(0)

    async def close(self) -> None:
        self.closed = True

    def __aiter__(self):
        return self._gen()

    async def _gen(self):
        for m in self._incoming:
            yield m


def make_client(incoming, override=None):
    sock = FakeSocket(incoming)

    async def connect(url):
        assert url == "wss://signed.example/agent"
        return sock

    client = ElevenLabsAgentClient(
        signed_url="wss://signed.example/agent", connect=connect, conversation_config_override=override
    )
    return client, sock


@pytest.mark.asyncio
async def test_start_sends_initiation_first():
    client, sock = make_client([])
    await client.start()
    assert sock.sent[0] == {"type": "conversation_initiation_client_data"}


@pytest.mark.asyncio
async def test_caller_audio_is_sent_as_base64_chunks_in_order():
    client, sock = make_client([])
    await client.start()
    await client.send_caller_audio(b"\x01\x02")
    await client.send_caller_audio(b"")  # empty input is not sent
    await client.send_caller_audio(b"\x03")
    chunks = [m["user_audio_chunk"] for m in sock.sent if "user_audio_chunk" in m]
    assert [base64.b64decode(c) for c in chunks] == [b"\x01\x02", b"\x03"]


@pytest.mark.asyncio
async def test_agent_audio_is_decoded_and_pings_are_answered():
    pcm = b"\x10\x00" * 160
    client, sock = make_client([
        {"type": "ping", "ping_event": {"event_id": 7}},
        {"type": "audio", "audio_event": {"audio_base_64": base64.b64encode(pcm).decode()}},
    ])
    await client.start()
    events = [e async for e in client.events()]
    assert [e.kind for e in events] == ["audio"]
    assert events[0].audio == pcm
    assert {"type": "pong", "event_id": 7} in sock.sent


@pytest.mark.asyncio
async def test_interruption_and_transcripts_are_reported():
    client, _ = make_client([
        {"type": "user_transcript", "user_transcription_event": {"user_transcript": "hello"}},
        {"type": "agent_response", "agent_response_event": {"agent_response": "hi there"}},
        {"type": "interruption", "interruption_event": {}},
        {"type": "vad_score", "vad_score_event": {}},
    ])
    await client.start()
    events = [e async for e in client.events()]
    assert [e.kind for e in events] == ["user_transcript", "agent_response", "interruption", "other"]
    assert events[0].text == "hello"
    assert events[1].text == "hi there"


@pytest.mark.asyncio
async def test_override_is_included_in_initiation():
    client, sock = make_client([], override={"agent": {"first_message": ""}})
    await client.start()
    assert sock.sent[0]["conversation_config_override"] == {"agent": {"first_message": ""}}


@pytest.mark.asyncio
async def test_close_closes_the_socket_and_sending_after_close_fails():
    client, sock = make_client([])
    await client.start()
    await client.close()
    assert sock.closed is True
    with pytest.raises(RuntimeError):
        await client.send_caller_audio(b"\x00")


def test_agent_url_is_the_documented_endpoint():
    assert AGENT_WS_URL == "wss://api.elevenlabs.io/v1/convai/conversation"
