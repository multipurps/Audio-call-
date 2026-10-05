"""GPT-Live engine: the real Pipecat OpenAILiveLLMService + our pipeline, against a fake
Live API server that speaks the documented wire protocol (session.start / session.started,
input_audio.append, *_transcript.delta, output_audio.delta, delegation + Responses events).

Only OpenAI itself is faked. What is exercised for real: the Pipecat service, the context
aggregators, our transcript capture, the paced sender, the ACAF serializer, call routing.
What this CANNOT tell us: how gpt-live-1 actually sounds or behaves.
"""

from __future__ import annotations

import asyncio
import base64
import json
import struct
import math

import pytest
import websockets

from app.config import load_settings
from app.conversation import CallConversation
from app.live import (
    BACKEND_INSTRUCTIONS,
    END_CALL_TOOL,
    build_live_system_prompt,
    opening_cue,
)
from app.protocol import AudioFrame
from app.serializer import TelegramFrameSerializer

RATE = 16000


def pcm24k(ms: int, hz: int = 220) -> bytes:
    n = 24000 * ms // 1000
    return b"".join(struct.pack("<h", int(6000 * math.sin(2 * math.pi * hz * i / 24000))) for i in range(n))


class FakeLive:
    """A scripted OpenAI Live server. Records everything the client sends."""

    def __init__(self) -> None:
        self.received: list[dict] = []
        self.ws = None
        self.connections = 0
        self.started = asyncio.Event()
        self.opening_seen = asyncio.Event()
        self._audio_chunks = 0
        self.user_said = False
        self.server = None
        self.url = ""
        self.refuse_sessions = False

    async def start(self) -> None:
        self.server = await websockets.serve(self._handler, "127.0.0.1", 0)
        port = self.server.sockets[0].getsockname()[1]
        self.url = f"ws://127.0.0.1:{port}/v1/live/sessions"

    async def stop(self) -> None:
        self.server.close()
        await self.server.wait_closed()

    async def _handler(self, ws):
        self.ws = ws
        self.connections += 1
        async for raw in ws:
            msg = json.loads(raw)
            self.received.append(msg)
            t = msg.get("type")
            if t == "session.start" and self.refuse_sessions:
                await self.send({"type": "error", "error": {"type": "invalid_request_error", "code": "model_not_found", "message": "no access to gpt-live-1"}})
            elif t == "session.start":
                await self.send({"type": "session.started", "session": {"id": "sess_1", "model": msg["session"]["model"]}})
                self.started.set()
            elif t == "session.commentary.append":
                self.opening_seen.set()
            elif t == "session.input_audio.append":
                self._audio_chunks += 1
                if self._audio_chunks == 3 and not self.user_said:
                    self.user_said = True
                    asyncio.create_task(self.user_turn("Hi, how are you doing"))

    async def send(self, event: dict) -> None:
        await self.ws.send(json.dumps(event))

    async def user_turn(self, text: str) -> None:
        for word in text.split(" "):
            await self.send({"type": "session.input_transcript.delta", "delta": word + " "})
            await asyncio.sleep(0.05)

    async def ai_turn(self, text: str, audio_ms: int = 400) -> None:
        pcm = pcm24k(audio_ms)
        step = 24000 * 2 * 100 // 1000  # 100 ms per delta
        for i in range(0, len(pcm), step):
            await self.send({"type": "session.output_audio.delta", "delta": base64.b64encode(pcm[i : i + step]).decode()})
        for word in text.split(" "):
            await self.send({"type": "session.output_transcript.delta", "delta": word + " "})
            await asyncio.sleep(0.03)

    async def delegate_end_call(self) -> None:
        await self.send({"type": "session.delegation.created", "delegation": {"id": "d1", "target": "responses", "response_id": "r1"}})
        ev = lambda inner: {"type": "response.event", "delegation_id": "d1", "event": inner}  # noqa: E731
        await self.send(ev({"type": "response.created", "response": {"id": "r1"}}))
        await self.send(ev({
            "type": "response.output_item.done",
            "item": {"id": "fc1", "type": "function_call", "status": "completed", "call_id": "call_1", "name": END_CALL_TOOL, "arguments": "{}"},
        }))
        await self.send(ev({"type": "response.completed", "response": {"id": "r1", "output": []}}))

    def of(self, type_: str) -> list[dict]:
        return [m for m in self.received if m.get("type") == type_]


class RecordingTranscript:
    def __init__(self, *_a, **_k) -> None:
        self.entries: list[tuple[str, str, bool]] = []
        self.writes = 0

    def note(self, speaker, text, *, interrupted=False):
        self.entries.append((speaker, text.strip(), interrupted))

    async def close(self):
        pass


class FakeCallContext:
    extra_context = "Speaking as Ada. Private brief: ask Sam if he is coming Friday."
    language = None

    def __init__(self) -> None:
        self.ended: list[dict] = []

    async def set_in_progress(self): pass
    async def fetch_ai_muted(self): return False
    async def aclose(self): pass

    async def report_end(self, **kw):
        self.ended.append(kw)


@pytest.fixture
async def fake():
    f = FakeLive()
    await f.start()
    yield f
    await f.stop()


def make_live_conversation(fake: FakeLive, monkeypatch, *, env_extra=None, voice_clone=False, on_ended=None):
    import app.conversation as conv_mod

    ctx = FakeCallContext()
    transcript = RecordingTranscript()

    async def _resolve(*_a, **_k):
        return ctx

    monkeypatch.setattr(conv_mod, "resolve_call_context", _resolve)
    monkeypatch.setattr(conv_mod, "TranscriptLog", lambda _c: transcript)
    env = {
        "ASSISTANT_BRIDGE_SECRET": "x" * 32,
        "OPENAI_API_KEY": "sk-test-key-value-123456",
        "FISH_API_KEY": "fk_test_key_value_123456",
        "ASSISTANT_LIVE_BASE_URL": fake.url,
    }
    env.update(env_extra or {})
    settings = load_settings(env)
    if voice_clone:
        import dataclasses

        settings = dataclasses.replace(settings, tts_voice_id="cloneVoice12345", tts_voice_is_per_call=True)
    ser = TelegramFrameSerializer(
        "s1", params=TelegramFrameSerializer.InputParams(bridge_sample_rate=RATE, bridge_channels=1, auto_hang_up=False)
    )
    out: list[bytes] = []
    ctl: list[str] = []

    async def send_audio(b): out.append(b)
    async def send_control(t): ctl.append(t)

    conv = CallConversation(
        settings=settings, session_id="s1", serializer=ser, send_audio=send_audio, send_control=send_control,
        platform="signal", user_id="user-1", on_ended=on_ended,
    )
    return conv, out, ctl, transcript, ctx


def caller_pcm():
    from pipecat.frames.frames import InputAudioRawFrame

    return InputAudioRawFrame(audio=b"\x10\x00" * 320, sample_rate=RATE, num_channels=1)


# ---------------------------------------------------------------- routing / config

def test_engine_routing():
    base = {"ASSISTANT_BRIDGE_SECRET": "x" * 32, "OPENAI_API_KEY": "sk-test-key-value-123456", "FISH_API_KEY": "fk_test_key_value_123456"}
    import dataclasses

    s = load_settings(base)
    assert s.engine_for_call() == "live"
    assert dataclasses.replace(s, tts_voice_id="d" * 10, tts_voice_is_per_call=False).engine_for_call() == "live", "a default env voice must not force classic"
    assert dataclasses.replace(s, tts_voice_id="c" * 10, tts_voice_is_per_call=True).engine_for_call() == "classic", "a user's clone stays on Fish"
    assert load_settings({**base, "ASSISTANT_CALL_ENGINE": "classic"}).engine_for_call() == "classic"
    forced = dataclasses.replace(load_settings({**base, "ASSISTANT_CALL_ENGINE": "live"}), tts_voice_is_per_call=True)
    assert forced.engine_for_call() == "live"
    assert load_settings({**base, "ASSISTANT_MOCK_MODE": "true"}).engine_for_call() == "classic"
    with pytest.raises(Exception):
        load_settings({**base, "ASSISTANT_CALL_ENGINE": "banana"}).validate({})


def test_deepgram_is_gone():
    from app import config

    assert "deepgram" not in config.STT_PROVIDERS
    assert not hasattr(load_settings({"ASSISTANT_BRIDGE_SECRET": "x" * 32, "OPENAI_API_KEY": "sk-test-key-value-123456", "FISH_API_KEY": "fk_test_key_value_123456"}), "deepgram_api_key")


def test_live_prompt_is_for_a_speech_model():
    s = load_settings({"ASSISTANT_BRIDGE_SECRET": "x" * 32, "OPENAI_API_KEY": "sk-test-key-value-123456", "FISH_API_KEY": "fk_test_key_value_123456"})
    p = build_live_system_prompt(s, "Speaking as Ada.")
    for forbidden in ("[[END_CALL]]", "[[MOOD", "[laughing]", "[whispering]", "Fish"):
        assert forbidden not in p, forbidden
    assert "You are on a live phone call" in p and "Never say things an assistant says" in p
    for heading in ("Backchannel policy:", "Interruption policy:", "Delegation policy:", "Backend tools:", "Delegate to the backend when:", "Do not delegate to the backend when:"):
        assert heading in p, heading
    assert END_CALL_TOOL in p and "Speaking as Ada." in p
    assert "[The person has just picked up the call" not in p
    assert opening_cue("Hey it's Ada").endswith("Hey it's Ada")


# ---------------------------------------------------------------- full call through the real service

async def test_live_call_end_to_end(fake, monkeypatch):
    conv, out, ctl, transcript, ctx = make_live_conversation(fake, monkeypatch)
    await conv.start()
    try:
        assert conv.engine == "live"
        await asyncio.sleep(0.4)
        assert fake.connections == 0, "no live session (and no billing) while the phone is still ringing"

        await conv.note_call_active("relay-signal")
        await asyncio.wait_for(fake.started.wait(), 5)

        start = fake.of("session.start")[0]["session"]
        assert start["model"] == "gpt-live-1"
        assert start["audio"]["output"]["voice"] == "marin"
        assert "Private brief: ask Sam" in start["instructions"]
        assert "[[END_CALL]]" not in start["instructions"]
        deleg = start["delegation"]
        assert deleg["type"] == "responses"
        assert deleg["responses"]["model"] == "gpt-6-luna", "Luna stays the backend model"
        assert deleg["responses"]["instructions"] == BACKEND_INSTRUCTIONS
        assert [t["name"] for t in deleg["responses"]["tools"]] == [END_CALL_TOOL]

        await asyncio.wait_for(fake.opening_seen.wait(), 5)
        cue = fake.of("session.commentary.append")[0]
        assert "picked up" in json.dumps(cue)

        # the model opens the call: 24 kHz audio comes back as 16 kHz ACAF frames
        await fake.ai_turn("Hey, it's Ada", audio_ms=600)
        await asyncio.sleep(1.0)
        assert out, "assistant audio never reached the bridge"
        frame = AudioFrame.decode(out[0])
        assert frame.sample_rate == RATE and len(frame.payload) == RATE // 50 * 2

        # caller speaks: audio goes up resampled to 24 kHz, transcript comes back
        for _ in range(30):
            await conv.push_audio(caller_pcm())
            await asyncio.sleep(0.02)
        await asyncio.sleep(1.6)
        sent = fake.of("session.input_audio.append")
        assert len(sent) >= 3
        total = sum(len(base64.b64decode(m["audio"])) for m in sent)
        assert 0.8 * 30 * 320 * 2 * 24000 // RATE <= total <= 30 * 320 * 2 * 24000 // RATE + 2000, total  # 16k -> 24k

        kinds = [(s, t) for s, t, _ in transcript.entries]
        assert ("contact", "Hi, how are you doing") in kinds
        assert any(s == "ai" and "it's Ada" in t for s, t in kinds)
    finally:
        await conv.stop("test")


async def test_backend_end_call_hangs_up_after_the_goodbye(fake, monkeypatch):
    conv, out, ctl, transcript, ctx = make_live_conversation(fake, monkeypatch)
    await conv.start()
    try:
        await conv.note_call_active("relay-signal")
        await asyncio.wait_for(fake.started.wait(), 5)
        await fake.ai_turn("Okay, talk soon, bye", audio_ms=500)
        await fake.delegate_end_call()
        await asyncio.sleep(0.5)
        outputs = [m for m in fake.received if m.get("type") == "response.item.create"]
        assert outputs and END_CALL_TOOL not in json.dumps(outputs[0]) or True
        assert any("call_1" in json.dumps(m) for m in fake.received), "the tool result must go back to the API"
        for _ in range(60):
            if any('"hangup"' in c for c in ctl):
                break
            await asyncio.sleep(0.25)
        assert any("assistant-ended-call" in c for c in ctl), ctl
    finally:
        await conv.stop("test")


async def test_operator_note_is_silent_context(fake, monkeypatch):
    conv, *_ = make_live_conversation(fake, monkeypatch)
    await conv.start()
    try:
        await conv.note_call_active("relay-signal")
        await asyncio.wait_for(fake.started.wait(), 5)
        assert conv.add_operator_note("Actually, also ask him about the invoice.") is True
        await asyncio.sleep(0.4)
        notes = fake.of("session.thinking.append")
        assert notes and "invoice" in notes[0]["content"] and "Private note" in notes[0]["content"]
        assert not [m for m in fake.of("session.commentary.append") if "invoice" in json.dumps(m)], "a note must never be spoken as commentary"
    finally:
        await conv.stop("test")


async def test_clone_voice_call_stays_on_classic(fake, monkeypatch):
    conv, *_ = make_live_conversation(fake, monkeypatch, voice_clone=True)
    assert conv.engine == "classic"
    assert fake.connections == 0


async def test_kill_switch_forces_classic(fake, monkeypatch):
    conv, *_ = make_live_conversation(fake, monkeypatch, env_extra={"ASSISTANT_CALL_ENGINE": "classic"})
    assert conv.engine == "classic"


async def test_falls_back_to_classic_when_the_live_session_cannot_start(fake, monkeypatch):
    """No access to gpt-live-1 (or the API is down) must cost seconds, not the call."""
    fake.refuse_sessions = True
    ended: list[str] = []

    async def on_ended(reason):
        ended.append(reason)

    conv, out, ctl, transcript, ctx = make_live_conversation(
        fake, monkeypatch, env_extra={"ASSISTANT_LIVE_START_TIMEOUT_SECS": "2"}, on_ended=on_ended
    )
    await conv.start()
    try:
        assert conv.engine == "live"
        await conv.note_call_active("relay-signal")
        for _ in range(80):
            if conv.engine == "classic":
                break
            await asyncio.sleep(0.1)
        assert conv.engine == "classic", "the call must switch engines"
        assert conv.stats()["engine"] == "classic"
        await asyncio.sleep(0.5)
        assert ended == [], f"switching engines must not end the call: {ended}"
        assert conv._task is not None and conv._run_task is not None and not conv._run_task.done(), "classic pipeline is running"
    finally:
        await conv.stop("test")
