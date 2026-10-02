"""Audio pipeline tests: greeting on answer, two-way audio, pacing, errors.

The real Pipecat 1.11 pipeline runs here with offline stand-in STT/LLM/TTS
services, so the wiring (aggregators, TTS, bridge output, pacing, ACAF
serialization) is exercised without provider keys. The providers themselves
are not exercised; only a live call can do that.
"""

from __future__ import annotations

import asyncio
import json
import math
import struct
import time

import pytest
from fastapi.testclient import TestClient
from pipecat.frames.frames import (
    InputAudioRawFrame,
    LLMContextFrame,
    LLMFullResponseEndFrame,
    LLMFullResponseStartFrame,
    LLMTextFrame,
    TranscriptionFrame,
    TTSAudioRawFrame,
)
from pipecat.processors.frame_processor import FrameProcessor
from pipecat.services.tts_service import TTSService

from app.config import load_settings
from app.conversation import CallConversation, PacedAudioSender, clog
from app.main import create_app
from app.protocol import CONTROL_CALL_ACTIVE, AudioFrame
from app.serializer import TelegramFrameSerializer
from tests.test_integration_bridge import audio_frame, hello, receive_control

RATE = 16000


class FakeSTT(FrameProcessor):
    """Emits a transcript after `after` inbound audio frames."""

    def __init__(self, after: int = 10) -> None:
        super().__init__(name="FakeSTT")
        self._after = after
        self._n = 0

    async def process_frame(self, frame, direction):
        await super().process_frame(frame, direction)
        if isinstance(frame, InputAudioRawFrame):
            self._n += 1
            if self._n == self._after:
                await self.push_frame(
                    TranscriptionFrame(text="hello there", user_id="caller", timestamp=str(time.time()))
                )
            return
        await self.push_frame(frame, direction)


class FakeLLM(FrameProcessor):
    def __init__(self, fail: bool = False) -> None:
        super().__init__(name="FakeLLM")
        self.contexts: list[list[str]] = []
        self._fail = fail

    async def process_frame(self, frame, direction):
        await super().process_frame(frame, direction)
        if isinstance(frame, LLMContextFrame):
            self.contexts.append([m.get("content") for m in frame.context.get_messages()])
            await self.push_frame(LLMFullResponseStartFrame())
            await self.push_frame(LLMTextFrame("Sure, happy to help with that."))
            await self.push_frame(LLMFullResponseEndFrame())
            return
        await self.push_frame(frame, direction)


class FakeTTS(TTSService):
    def __init__(self) -> None:
        from pipecat.services.settings import TTSSettings

        super().__init__(
            sample_rate=RATE,
            push_stop_frames=True,
            settings=TTSSettings(model=None, voice=None, language=None),
        )

    def can_generate_metrics(self) -> bool:
        return True

    async def run_tts(self, text, context_id):
        pcm = b"".join(
            struct.pack("<h", int(8000 * math.sin(2 * math.pi * 200 * i / RATE)))
            for i in range(RATE // 2)
        )
        yield TTSAudioRawFrame(audio=pcm, sample_rate=RATE, num_channels=1, context_id=context_id)


def make_conversation(greeting="Hello from test", extra_env=None):
    env = {
        "ASSISTANT_BRIDGE_SECRET": "x" * 32,
        "OPENAI_API_KEY": "ok_test_key_value_123456",
        "FISH_API_KEY": "fk_test_key_value_123456",
        "ASSISTANT_GREETING": greeting,
    }
    if extra_env:
        env.update(extra_env)
    settings = load_settings(env)
    ser = TelegramFrameSerializer(
        "s1",
        params=TelegramFrameSerializer.InputParams(
            bridge_sample_rate=RATE, bridge_channels=1, auto_hang_up=False
        ),
    )
    out: list[bytes] = []
    ctl: list[str] = []

    async def send_audio(b: bytes) -> None:
        out.append(b)

    async def send_control(t: str) -> None:
        ctl.append(t)

    llm = FakeLLM()
    conv = CallConversation(
        settings=settings,
        session_id="s1",
        serializer=ser,
        send_audio=send_audio,
        send_control=send_control,
        services=(FakeSTT(), llm, FakeTTS(), None),
    )
    return conv, out, ctl, llm


def caller_frame() -> InputAudioRawFrame:
    return InputAudioRawFrame(audio=b"\x10\x00" * 320, sample_rate=RATE, num_channels=1)


class TestGreetingOnAnswer:
    async def test_no_audio_before_the_call_is_answered(self):
        conv, out, _, _ = make_conversation()
        await conv.start()
        try:
            await asyncio.sleep(0.4)
            assert out == [], "assistant must not speak while the phone is still ringing"
            assert not conv.call_active
        finally:
            await conv.stop("test")

    async def test_greeting_is_spoken_once_the_call_is_active(self):
        conv, out, _, _ = make_conversation()
        await conv.start()
        try:
            assert await conv.note_call_active("relay-signal") is True
            await asyncio.sleep(1.2)
            assert len(out) >= 20, "half a second of speech is 25 x 20 ms frames"
            frame = AudioFrame.decode(out[0])
            assert frame.sample_rate == RATE
            assert len(frame.payload) == RATE // 50 * 2  # 20 ms of pcm16
        finally:
            await conv.stop("test")

    async def test_greeting_is_not_repeated(self):
        conv, out, _, _ = make_conversation()
        await conv.start()
        try:
            assert await conv.note_call_active("relay-signal") is True
            assert await conv.note_call_active("first-inbound-audio") is False
            await asyncio.sleep(1.2)
            assert conv.stats()["framesEnqueued"] == 25
        finally:
            await conv.stop("test")

    async def test_first_inbound_audio_does_not_fabricate_an_answer(self):
        # The provider's answer event (ACAF call_active) is the source of
        # truth. Early audio must never mark the call answered — that is what
        # started the conversation timer while the phone was still ringing.
        conv, out, _, _ = make_conversation()
        await conv.start()
        try:
            await conv.push_audio(caller_frame())
            assert conv.call_active_source is None
            assert conv.talk_seconds() == 0
            await asyncio.sleep(0.6)
            assert out == [], "no greeting before the real answer event"
        finally:
            await conv.stop("test")

    async def test_first_inbound_audio_answers_only_when_opted_in(self):
        # Legacy relays that cannot send the answer event can opt back in.
        conv, out, _, _ = make_conversation(
            extra_env={"ASSISTANT_ANSWER_ON_FIRST_AUDIO": "true"}
        )
        await conv.start()
        try:
            await conv.push_audio(caller_frame())
            assert conv.call_active_source == "first-inbound-audio"
            await asyncio.sleep(1.2)
            assert out
        finally:
            await conv.stop("test")

    async def test_talk_duration_runs_from_the_answer_not_from_dial(self):
        conv, _, _, _ = make_conversation()
        await conv.start()
        try:
            assert conv.talk_seconds() == 0
            await conv.note_call_active("relay-signal")
            await asyncio.sleep(0.35)
            assert 0 <= conv.talk_seconds() <= 2
            assert conv.ring_seconds() >= 0
        finally:
            await conv.stop("test")

    async def test_greeting_is_in_the_llm_context(self):
        conv, _, _, llm = make_conversation("Hi, it is Emysa")
        await conv.start()
        try:
            await conv.note_call_active("relay-signal")
            for _ in range(20):
                await conv.push_audio(caller_frame())
                await asyncio.sleep(0.02)
            await asyncio.sleep(1.0)
            assert llm.contexts, "the caller's turn never reached the LLM"
            assert "Hi, it is Emysa" in llm.contexts[0]
        finally:
            await conv.stop("test")


class TestTwoWayAudio:
    async def test_caller_speech_produces_a_spoken_reply(self):
        conv, out, _, llm = make_conversation()
        await conv.start()
        try:
            await conv.note_call_active("relay-signal")
            await asyncio.sleep(1.2)
            before = len(out)
            for _ in range(30):
                await conv.push_audio(caller_frame())
                await asyncio.sleep(0.02)
            await asyncio.sleep(1.5)
            assert llm.contexts[-1][-1] == "hello there"
            assert len(out) - before >= 20, "no reply audio after the caller spoke"
            assert conv.stats()["inboundFrames"] == 30
        finally:
            await conv.stop("test")

    async def test_stop_is_prompt_and_idempotent(self):
        conv, _, _, _ = make_conversation()
        await conv.start()
        await conv.note_call_active("relay-signal")
        started = time.monotonic()
        await conv.stop("test")
        await conv.stop("test")
        assert time.monotonic() - started < 3.0


class TestPacedSender:
    def _sender(self, out, errors=None):
        ser = TelegramFrameSerializer(
            "s1",
            params=TelegramFrameSerializer.InputParams(
                bridge_sample_rate=RATE, bridge_channels=1, auto_hang_up=False
            ),
        )

        async def send_audio(b):
            if errors is not None and len(out) == 1 and not errors:
                errors.append(1)
                raise RuntimeError("socket write failed")
            out.append(b)

        async def send_control(t):
            pass

        return PacedAudioSender(
            session_id="s1", serializer=ser, send_audio=send_audio, send_control=send_control
        )

    async def test_audio_is_released_at_real_time_speed(self):
        out: list[bytes] = []
        sender = self._sender(out)
        sender.start()
        try:
            await sender.enqueue(b"\x01\x00" * (RATE // 2), RATE)  # 0.5 s
            await asyncio.sleep(0.25)
            assert 5 < len(out) < 22, f"expected roughly half released, got {len(out)}"
            await asyncio.sleep(0.5)
            assert len(out) == 25
        finally:
            await sender.stop()

    async def test_interrupt_drops_queued_audio(self):
        out: list[bytes] = []
        sender = self._sender(out)
        sender.start()
        try:
            await sender.enqueue(b"\x01\x00" * (RATE * 2), RATE)  # 2 s
            await asyncio.sleep(0.2)
            dropped = await sender.interrupt()
            assert dropped > 50
            sent = len(out)
            await asyncio.sleep(0.3)
            assert len(out) - sent <= 1
        finally:
            await sender.stop()

    async def test_a_failed_send_does_not_kill_the_stream(self):
        out: list[bytes] = []
        sender = self._sender(out, errors=[])
        sender.start()
        try:
            await sender.enqueue(b"\x01\x00" * (RATE // 5), RATE)  # 10 frames
            await asyncio.sleep(0.6)
            assert sender.send_errors == 1
            assert len(out) == 9
        finally:
            await sender.stop()


def test_clog_puts_fields_in_the_message_and_never_needs_extra(capfd):
    from loguru import logger

    lines: list[str] = []
    handle = logger.add(lambda m: lines.append(str(m)), level="INFO")
    try:
        clog("INFO", "sess-1", "stt transcript received", chars=12)
    finally:
        logger.remove(handle)
    assert "[call sess-1] stt transcript received chars=12" in lines[0]


class TestBridgeEndToEnd:
    """Through the real WebSocket bridge, in mock mode."""

    def test_relay_call_active_signal_makes_the_bridge_speak(self):
        app = create_app(load_settings({"ASSISTANT_MOCK_MODE": "true"}))
        with TestClient(app) as client:
            with client.websocket_connect("/stream") as ws:
                ws.send_text(hello(platform="whatsapp"))
                assert json.loads(ws.receive_text())["type"] == "ready"
                ws.send_text(json.dumps({"type": CONTROL_CALL_ACTIVE}))
                message = ws.receive()
                assert message.get("bytes"), "no greeting audio after call_active"
                assert AudioFrame.decode(message["bytes"]).sample_rate == 16000

    def test_bridge_stays_silent_until_answered(self):
        app = create_app(load_settings({"ASSISTANT_MOCK_MODE": "true"}))
        with TestClient(app) as client:
            with client.websocket_connect("/stream") as ws:
                ws.send_text(hello(platform="whatsapp"))
                ws.receive_text()
                ws.send_text(json.dumps({"type": "ping"}))
                # The first thing back is the pong, not audio.
                assert json.loads(ws.receive_text())["type"] == "pong"

    def test_caller_audio_alone_never_triggers_the_greeting(self):
        # Default: only the provider's answer event counts as an answer.
        app = create_app(load_settings({"ASSISTANT_MOCK_MODE": "true"}))
        with TestClient(app) as client:
            with client.websocket_connect("/stream") as ws:
                ws.send_text(hello(platform="whatsapp"))
                ws.receive_text()
                ws.send_bytes(audio_frame(b"\x10\x00" * 320, seq=0))
                ws.send_text(json.dumps({"type": "ping"}))
                # The next thing back is the pong — no greeting audio.
                message = ws.receive()
                if message.get("bytes"):
                    pytest.fail("greeting fired on first audio without an answer event")
                assert json.loads(message["text"])["type"] == "pong"

    def test_caller_audio_triggers_greeting_for_relays_without_the_signal(self):
        app = create_app(
            load_settings(
                {
                    "ASSISTANT_MOCK_MODE": "true",
                    "ASSISTANT_ANSWER_ON_FIRST_AUDIO": "true",
                }
            )
        )
        with TestClient(app) as client:
            with client.websocket_connect("/stream") as ws:
                ws.send_text(hello(platform="whatsapp"))
                ws.receive_text()
                ws.send_bytes(audio_frame(b"\x00\x00" * 320, seq=0))
                assert ws.receive().get("bytes")

    def test_peer_hangup_releases_the_session(self):
        app = create_app(load_settings({"ASSISTANT_MOCK_MODE": "true"}))
        with TestClient(app) as client:
            with client.websocket_connect("/stream") as ws:
                ws.send_text(hello(platform="whatsapp"))
                ws.receive_text()
                ws.send_text(json.dumps({"type": "hangup"}))
            deadline = time.monotonic() + 3
            while time.monotonic() < deadline and len(app.state.service.registry):
                time.sleep(0.05)
            assert len(app.state.service.registry) == 0


class ChunkedLLM(FakeLLM):
    """Streams the reply as OpenAI does: word tokens with their leading space."""

    async def process_frame(self, frame, direction):
        if isinstance(frame, LLMContextFrame):
            await FrameProcessor.process_frame(self, frame, direction)
            self.contexts.append([m.get("content") for m in frame.context.get_messages()])
            await self.push_frame(LLMFullResponseStartFrame())
            for chunk in ["Sure,", " happy", " to", " help", " you", " out."]:
                await self.push_frame(LLMTextFrame(chunk))
            await self.push_frame(LLMFullResponseEndFrame())
            return
        await super().process_frame(frame, direction)


class RecordingTTS(FakeTTS):
    def __init__(self) -> None:
        super().__init__()
        self.spoken: list[str] = []

    async def run_tts(self, text, context_id):
        self.spoken.append(text)
        async for frame in super().run_tts(text, context_id):
            yield frame


class TestStreamedReplyKeepsItsSpaces:
    async def test_tts_and_transcript_text_keep_word_spacing(self):
        conv, out, _, _ = make_conversation(greeting="")
        tts = RecordingTTS()
        conv._services = (FakeSTT(), ChunkedLLM(), tts, None)
        await conv.start()
        try:
            await conv.note_call_active("relay-signal")
            await asyncio.sleep(1.5)
            spoken = "".join(tts.spoken)
            assert "happy to help you out" in spoken, spoken
        finally:
            await conv.stop("test")
