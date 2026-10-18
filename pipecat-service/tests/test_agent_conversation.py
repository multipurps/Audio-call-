"""The Agent voice call: the app's instructions and chosen voice go on the agent, audio runs both ways,
an interruption drops queued agent audio, and stopping closes everything."""

import asyncio
import types

import pytest

from app import elevenlabs_conversation as ec
from app.elevenlabs_agent import AgentEvent


class FakeClient:
    def __init__(self, *, signed_url, conversation_config_override=None, **_):
        self.signed_url = signed_url
        self.override = conversation_config_override
        self.started = False
        self.closed = False
        self.sent_audio: list[bytes] = []
        self.events_to_yield: list[AgentEvent] = []

    async def start(self):
        self.started = True

    async def send_caller_audio(self, pcm):
        self.sent_audio.append(pcm)

    async def events(self):
        for ev in self.events_to_yield:
            yield ev

    async def close(self):
        self.closed = True


class FakeSender:
    def __init__(self, **_):
        self.started = False
        self.stopped = False
        self.enqueued: list[tuple[bytes, int]] = []
        self.interrupts = 0

    def start(self):
        self.started = True

    async def enqueue(self, pcm, rate, channels=1):
        self.enqueued.append((pcm, rate))

    async def interrupt(self):
        self.interrupts += 1
        return 0

    async def stop(self):
        self.stopped = True

    def stats(self):
        return {"frames": len(self.enqueued)}


@pytest.fixture
def patched(monkeypatch):
    clients: list[FakeClient] = []
    senders: list[FakeSender] = []

    async def fake_agent_id(api_key, **_):
        assert api_key == "sk-test"
        return "agent_emysa"

    async def fake_signed(agent_id, api_key, **_):
        assert agent_id == "agent_emysa"
        return "wss://signed.example"

    def make_client(**kw):
        c = FakeClient(**kw)
        clients.append(c)
        return c

    def make_sender(**kw):
        s = FakeSender(**kw)
        senders.append(s)
        return s

    monkeypatch.setattr(ec, "resolve_agent_id", fake_agent_id)
    monkeypatch.setattr(ec, "fetch_signed_url", fake_signed)
    monkeypatch.setattr(ec, "ElevenLabsAgentClient", make_client)
    monkeypatch.setattr(ec, "PacedAudioSender", make_sender)
    return clients, senders


def make_conv(on_ended=None, voice_id="voice_mine", first_message="Hi, Emysa here."):
    settings = types.SimpleNamespace(
        elevenlabs_api_key="sk-test", elevenlabs_agent_id=None, bridge_sample_rate=16000, mock_mode=False
    )
    return ec.ElevenLabsAgentConversation(
        settings=settings, session_id="call-agent-1", serializer=None,
        send_audio=None, send_control=None, on_ended=on_ended,
        prompt="THE APP INSTRUCTIONS", first_message=first_message, voice_id=voice_id,
    )


def frame(rate, data=b"\x01\x00" * 320):
    return types.SimpleNamespace(sample_rate=rate, audio=data)


@pytest.mark.asyncio
async def test_the_app_instructions_and_chosen_voice_are_sent_on_connect(patched):
    clients, senders = patched
    conv = make_conv()
    await conv.start()
    assert clients[0].started and clients[0].signed_url == "wss://signed.example"
    assert senders[0].started
    override = clients[0].override
    assert override["agent"]["prompt"]["prompt"] == "THE APP INSTRUCTIONS"
    assert override["agent"]["first_message"] == "Hi, Emysa here."
    assert override["tts"]["voice_id"] == "voice_mine"


@pytest.mark.asyncio
async def test_no_voice_or_greeting_means_the_agent_defaults_are_kept(patched):
    clients, _ = patched
    conv = make_conv(voice_id=None, first_message=None)
    await conv.start()
    assert clients[0].override == {"agent": {"prompt": {"prompt": "THE APP INSTRUCTIONS"}}}


@pytest.mark.asyncio
async def test_caller_audio_goes_up_as_it_arrives_at_16k_only(patched):
    clients, _ = patched
    conv = make_conv()
    await conv.start()
    await conv.push_audio(frame(16000, b"AAAA"))
    await conv.push_audio(frame(8000, b"BBBB"))  # wrong rate: dropped, not sent
    await conv.push_audio(frame(16000, b"CCCC"))
    assert clients[0].sent_audio == [b"AAAA", b"CCCC"]


@pytest.mark.asyncio
async def test_agent_audio_is_paced_out_and_interruptions_drop_it(patched):
    clients, senders = patched
    conv = make_conv()
    await conv.start()
    clients[0].events_to_yield = [
        AgentEvent("audio", audio=b"pcm-1"),
        AgentEvent("user_transcript", text="hi"),
        AgentEvent("interruption"),
        AgentEvent("audio", audio=b"pcm-2"),
    ]
    await conv._task
    assert senders[0].enqueued == [(b"pcm-1", 16000), (b"pcm-2", 16000)]
    assert senders[0].interrupts == 1


@pytest.mark.asyncio
async def test_agent_side_closing_ends_the_call(patched):
    ended = []

    async def on_ended(reason):
        ended.append(reason)

    conv = make_conv(on_ended=on_ended)
    await conv.start()
    await conv._task
    assert ended == ["agent-ended"]


@pytest.mark.asyncio
async def test_stop_closes_the_socket_and_sender_and_sends_nothing_after(patched):
    clients, senders = patched
    conv = make_conv()
    await conv.start()
    await conv.stop("hangup")
    assert clients[0].closed is True
    assert senders[0].stopped is True
    await conv.push_audio(frame(16000, b"ZZZZ"))
    assert clients[0].sent_audio == []


@pytest.mark.asyncio
async def test_missing_key_fails_before_any_connection(patched):
    clients, _ = patched
    conv = make_conv()
    conv._settings.elevenlabs_api_key = None
    with pytest.raises(RuntimeError):
        await conv.start()
    assert clients == []
