"""The active WhatsApp voice path: LLM text -> Pipecat -> native Fish streaming TTS.

Everything here uses the REAL ``FishAudioTTSService`` built by ``build_tts``;
only the network socket is faked, so the bytes asserted are the bytes the
production process would put on the wire / hand to the transport.
"""

from __future__ import annotations

import asyncio
import re
import warnings
from pathlib import Path

import ormsgpack
import pytest
from websockets.protocol import State

from pipecat.frames.frames import (
    InterruptionFrame,
    LLMFullResponseEndFrame,
    LLMFullResponseStartFrame,
    LLMTextFrame,
    OutputAudioRawFrame,
)
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.runner import PipelineRunner
from pipecat.pipeline.task import PipelineParams, PipelineTask
from pipecat.processors.frame_processor import FrameProcessor
from pipecat.services.fish.tts import FishAudioTTSService

from app.config import load_settings
from app.providers import build_tts

ROOT = Path(__file__).resolve().parents[1]
PCM = b"\x01\x00" * 4000  # 8000 bytes: 250 ms at 16 kHz / 16-bit mono


def make_settings(**env):
    base = {
        "ASSISTANT_BRIDGE_SECRET": "x" * 32,
        "OPENAI_API_KEY": "ok_test_key_value_123456",
        "FISH_API_KEY": "fk_test_key_value_123456",
    }
    base.update(env)
    return load_settings(base)


class FakeWS:
    """Stands in for Fish's /v1/tts/live socket and records what it is sent."""

    state = State.OPEN

    def __init__(self, *, answer: bool = True):
        self.sent: list[dict] = []
        self.answer = answer
        self.closed = False
        self._pending_text = False
        self._q: asyncio.Queue = asyncio.Queue()

    async def send(self, data):
        msg = ormsgpack.unpackb(data)
        self.sent.append(msg)
        if msg.get("event") == "text":
            self._pending_text = True
        elif msg.get("event") == "flush" and self._pending_text:
            # Like the real service: audio only for text it was actually given.
            self._pending_text = False
            if self.answer:
                await self.push_audio(PCM)

    async def push_audio(self, audio: bytes):
        await self._q.put(ormsgpack.packb({"event": "audio", "audio": audio}))

    async def close(self):
        self.closed = True

    def __aiter__(self):
        return self

    async def __anext__(self):
        return await self._q.get()

    def text(self) -> list[str]:
        return [m["text"] for m in self.sent if m.get("event") == "text"]

    def start(self) -> dict:
        return next(m["request"] for m in self.sent if m.get("event") == "start")


class Sink(FrameProcessor):
    def __init__(self):
        super().__init__(name="Sink")
        self.audio = bytearray()
        self.rates: set[int] = set()

    async def process_frame(self, frame, direction):
        await super().process_frame(frame, direction)
        if isinstance(frame, OutputAudioRawFrame):
            self.audio += frame.audio
            self.rates.add(frame.sample_rate)
            return
        await self.push_frame(frame, direction)


@pytest.fixture
def sockets(monkeypatch):
    """Every Fish connection made during the test, in order, per service."""
    made: dict[int, list[FakeWS]] = {}
    options = {"answer": True}

    async def fake_connect(self, url, **kwargs):
        ws = FakeWS(answer=options["answer"])
        made.setdefault(id(self), []).append(ws)
        ws.url, ws.headers = url, kwargs.get("additional_headers", {})
        return ws

    monkeypatch.setattr(FishAudioTTSService, "_websocket_connect", fake_connect)
    made["options"] = options  # type: ignore[assignment]
    return made


async def run(service, script, *, settle=0.4):
    """Run [service, sink]; `script(task)` queues frames. Returns the sink."""
    sink = Sink()
    task = PipelineTask(
        Pipeline([service, sink]),
        params=PipelineParams(audio_in_sample_rate=16000, audio_out_sample_rate=16000),
        enable_rtvi=False,
        idle_timeout_secs=None,
    )
    runner = PipelineRunner(handle_sigint=False)
    running = asyncio.create_task(runner.run(task))
    await asyncio.sleep(0.2)
    await script(task)
    await asyncio.sleep(settle)
    await task.cancel()
    try:
        await asyncio.wait_for(running, 3)
    except Exception:  # noqa: BLE001 - cancellation noise
        pass
    return sink


def reply(task, *chunks):
    async def go():
        await task.queue_frame(LLMFullResponseStartFrame())
        for chunk in chunks:
            await task.queue_frame(LLMTextFrame(chunk))
        await task.queue_frame(LLMFullResponseEndFrame())

    return go()


class TestNativeFishService:
    def test_build_tts_is_the_native_streaming_service_with_voice_and_model_in_settings(self):
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            tts = build_tts(make_settings(ASSISTANT_TTS_VOICE_ID="voice_abc", ASSISTANT_TTS_MODEL="s2-pro"))
        assert isinstance(tts, FishAudioTTSService)
        assert tts._settings.voice == "voice_abc" and tts._settings.model == "s2-pro"
        # the deprecated constructor kwargs are no longer used
        assert not [w for w in caught if re.search(r"reference_id|model_id", str(w.message))]

    async def test_wire_payload_is_realtime_pcm_at_the_bridge_rate_for_the_selected_voice(self, sockets):
        tts = build_tts(make_settings(ASSISTANT_TTS_VOICE_ID="voice_abc"))

        async def script(task):
            await reply(task, "Hey, ", "how are you?")

        await run(tts, script)
        ws = sockets[id(tts)][0]
        assert ws.url == "wss://api.fish.audio/v1/tts/live"  # realtime WebSocket, not HTTP /v1/tts
        assert ws.headers["model"] == "s2.1-pro"
        start = ws.start()
        assert start["format"] == "pcm" and start["sample_rate"] == 16000  # never mulaw / 8 kHz
        assert start["reference_id"] == "voice_abc"
        assert start["latency"] in ("normal", "balanced")
        assert ws.text() == ["Hey, how are you?"]

    async def test_audio_reaches_the_transport_unaltered_at_16khz(self, sockets):
        tts = build_tts(make_settings())

        async def script(task):
            await reply(task, "Hello there.")

        sink = await run(tts, script)
        # Byte-for-byte: no resampling, no mu-law round trip, no gain inside the core path.
        assert bytes(sink.audio) == PCM
        assert sink.rates == {16000}


class TestCallIsolation:
    async def test_two_simultaneous_calls_keep_their_own_voice_and_audio(self, sockets):
        a = build_tts(make_settings(ASSISTANT_TTS_VOICE_ID="voice_AAA"))
        b = build_tts(make_settings(ASSISTANT_TTS_VOICE_ID="voice_BBB"))

        async def script_a(task):
            await reply(task, "I am call A.")

        async def script_b(task):
            await reply(task, "And I am call B.")

        sink_a, sink_b = await asyncio.gather(run(a, script_a), run(b, script_b))
        wa, wb = sockets[id(a)][0], sockets[id(b)][0]
        assert wa is not wb
        assert wa.start()["reference_id"] == "voice_AAA" and wb.start()["reference_id"] == "voice_BBB"
        assert wa.text() == ["I am call A."] and wb.text() == ["And I am call B."]
        assert bytes(sink_a.audio) == PCM and bytes(sink_b.audio) == PCM

    def test_no_module_level_voice_state_is_shared(self):
        a = build_tts(make_settings(ASSISTANT_TTS_VOICE_ID="voice_AAA"))
        b = build_tts(make_settings(ASSISTANT_TTS_VOICE_ID="voice_BBB"))
        assert a is not b and a._settings is not b._settings
        assert a._settings.voice == "voice_AAA" and b._settings.voice == "voice_BBB"


class TestInterruption:
    async def test_barge_in_drops_stale_speech_and_the_next_reply_plays_normally(self, sockets):
        sockets["options"]["answer"] = False  # hold Fish's audio so we can interrupt mid-generation
        tts = build_tts(make_settings(ASSISTANT_TTS_VOICE_ID="voice_abc"))
        stale = b"\x7f\x00" * 4000

        async def script(task):
            await reply(task, "A long sentence that is still being generated.")
            await asyncio.sleep(0.3)
            old_ws = sockets[id(tts)][0]
            sockets["options"]["answer"] = True  # the NEW connection will answer normally
            await task.queue_frame(InterruptionFrame())  # the callee starts talking
            await asyncio.sleep(0.4)
            await old_ws.push_audio(stale)  # late audio from the cancelled generation
            await asyncio.sleep(0.1)
            await reply(task, "Sure, go ahead.")

        sink = await run(tts, script, settle=0.8)
        wss = sockets[id(tts)]
        assert len(wss) >= 2, "interruption should cancel the old generation by reconnecting"
        assert wss[0].closed
        assert stale not in bytes(sink.audio), "stale speech leaked after the interruption"
        assert bytes(sink.audio) == PCM  # only the new reply was played
        assert wss[-1].text() == ["Sure, go ahead."]
        assert wss[-1].start()["reference_id"] == "voice_abc"  # same voice after reconnect


class TestTurnTakingIsNative:
    def test_pipecats_default_stop_strategy_is_smart_turn_v3(self):
        from pipecat.audio.turn.smart_turn.local_smart_turn_v3 import LocalSmartTurnAnalyzerV3
        from pipecat.turns.user_stop import TurnAnalyzerUserTurnStopStrategy
        from pipecat.turns.user_turn_strategies import default_user_turn_stop_strategies

        stop = default_user_turn_stop_strategies()
        assert len(stop) == 1 and isinstance(stop[0], TurnAnalyzerUserTurnStopStrategy)
        assert isinstance(stop[0]._turn_analyzer, LocalSmartTurnAnalyzerV3)

    def test_the_pipeline_does_not_override_it_with_a_custom_turn_system(self):
        src = (ROOT / "app" / "pipeline.py").read_text()
        assert "user_turn_strategies" not in src and "UserTurnStrategies(" not in src


class TestVersionPin:
    def test_requirements_pin_matches_the_installed_pipecat(self):
        from importlib.metadata import version

        pinned = re.search(r"pipecat-ai\[[^\]]*\]==([\d.]+)", (ROOT / "requirements.txt").read_text())
        assert pinned and pinned.group(1) == version("pipecat-ai")
