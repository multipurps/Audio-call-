"""The Grok agent call: caller audio up as it arrives, agent audio paced back, barge-in drops
queued audio, transcripts go to the call record, and stop closes everything."""

import types

import pytest

from app import grok_conversation as gc
from app.grok_realtime import RealtimeEvent


class FakeClient:
    def __init__(self, *, api_key, session_update, **_):
        self.api_key = api_key
        self.session_update = session_update
        self.started = False
        self.closed = False
        self.greeting = None
        self.sent_audio: list[bytes] = []
        self.events_to_yield: list[RealtimeEvent] = []

    async def start(self):
        self.started = True

    async def send_greeting(self, text):
        self.greeting = text

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


class FakeTranscript:
    def __init__(self):
        self.lines = []

    def note(self, speaker, text, *, interrupted=False):
        self.lines.append((speaker, text))


class _FakeRest:
    rows: list = []

    def __init__(self, *a, **k):
        pass

    async def select(self, *a, **k):
        return _FakeRest.rows

    async def aclose(self):
        pass


@pytest.fixture(autouse=True)
def _reset_key_cache(monkeypatch):
    gc._KEY_CACHE.update(value=None, at=0.0)
    monkeypatch.setattr(gc, "_Rest", _FakeRest)
    _FakeRest.rows = []
    yield
    gc._KEY_CACHE.update(value=None, at=0.0)


@pytest.fixture
def patched(monkeypatch):
    clients: list[FakeClient] = []
    senders: list[FakeSender] = []

    def make_client(**kw):
        c = FakeClient(**kw)
        clients.append(c)
        return c

    def make_sender(**kw):
        s = FakeSender(**kw)
        senders.append(s)
        return s

    monkeypatch.setattr(gc, "GrokRealtimeClient", make_client)
    monkeypatch.setattr(gc, "PacedAudioSender", make_sender)
    return clients, senders


def make_conv(on_ended=None, transcript=None, greeting="Hi, Emysa here.", voice_id="nlbqfwie", key="xai-test-key"):
    settings = types.SimpleNamespace(xai_api_key=key, bridge_sample_rate=16000, mock_mode=False,
                                     supabase_url=None, supabase_service_role_key=None)
    return gc.GrokAgentConversation(
        settings=settings, session_id="call-agent-1", serializer=None, send_audio=None,
        send_control=None, on_ended=on_ended, prompt="THE APP INSTRUCTIONS",
        greeting=greeting, voice_id=voice_id, transcript=transcript,
    )


def frame(rate, data=b"\x01\x00" * 320):
    return types.SimpleNamespace(sample_rate=rate, audio=data)


@pytest.mark.asyncio
async def test_connect_sends_the_app_instructions_chosen_voice_and_greeting(patched):
    clients, senders = patched
    conv = make_conv()
    await conv.start()
    assert clients[0].started and clients[0].api_key == "xai-test-key"
    assert clients[0].session_update["instructions"] == "THE APP INSTRUCTIONS"
    assert clients[0].session_update["voice"] == "nlbqfwie"
    assert clients[0].greeting == "Hi, Emysa here."
    assert senders[0].started


@pytest.mark.asyncio
async def test_no_chosen_voice_uses_the_built_in_default(patched):
    clients, _ = patched
    conv = make_conv(voice_id=None, greeting=None)
    await conv.start()
    assert clients[0].session_update["voice"] == "eve"
    assert clients[0].greeting is None


@pytest.mark.asyncio
async def test_caller_audio_goes_up_as_it_arrives_at_16k_only(patched):
    clients, _ = patched
    conv = make_conv()
    await conv.start()
    await conv.push_audio(frame(16000, b"AAAA"))
    await conv.push_audio(frame(8000, b"BBBB"))  # wrong rate: dropped
    await conv.push_audio(frame(16000, b"CCCC"))
    assert clients[0].sent_audio == [b"AAAA", b"CCCC"]


@pytest.mark.asyncio
async def test_agent_audio_is_paced_out_and_barge_in_drops_it(patched):
    clients, senders = patched
    conv = make_conv()
    await conv.start()
    clients[0].events_to_yield = [
        RealtimeEvent("audio", audio=b"pcm-1"),
        RealtimeEvent("interrupted"),
        RealtimeEvent("audio", audio=b"pcm-2"),
    ]
    await conv._task
    assert senders[0].enqueued == [(b"pcm-1", 16000), (b"pcm-2", 16000)]
    assert senders[0].interrupts == 1


@pytest.mark.asyncio
async def test_both_sides_of_the_conversation_go_to_the_call_transcript(patched):
    clients, _ = patched
    transcript = FakeTranscript()
    conv = make_conv(transcript=transcript)
    await conv.start()
    clients[0].events_to_yield = [
        RealtimeEvent("user_transcript", text="I need a ride"),
        RealtimeEvent("agent_transcript", text="Where to?"),
        RealtimeEvent("user_transcript", text=""),
    ]
    await conv._task
    assert transcript.lines == [("contact", "I need a ride"), ("ai", "Where to?")]


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
    conv = make_conv(key=None)
    with pytest.raises(RuntimeError):
        await conv.start()
    assert clients == []


@pytest.mark.asyncio
async def test_a_key_saved_in_admin_wins_over_the_server_setting(patched):
    clients, _ = patched
    _FakeRest.rows = [{"value": "xai-admin-key-1111"}]
    settings = types.SimpleNamespace(xai_api_key="xai-env-key-0000", bridge_sample_rate=16000, mock_mode=False,
                                     supabase_url="https://x.supabase.co", supabase_service_role_key="svc-test")
    assert await gc.resolve_xai_key(settings) == "xai-admin-key-1111"
    _FakeRest.rows = []
    assert await gc.resolve_xai_key(settings) == "xai-admin-key-1111"  # cached for a minute
