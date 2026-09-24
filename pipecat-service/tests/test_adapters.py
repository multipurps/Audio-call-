"""Adapter tests: the interface contract, the mock call, and Telegram framing.

These pin the shape the brief specifies -- `receiveAudio()`, `sendAudio(frame)`,
`stop()` -- and prove the mock call mode genuinely exercises audio rather than
emitting silence.
"""

from __future__ import annotations

import asyncio
import struct

import pytest

from app.adapters.base import (
    AdapterClosed,
    NormalizedAudioFrame,
    TransportAdapter,
)
from app.adapters.mock import MockCallAdapter, MockCallScript
from app.adapters.telegram import TelegramBridgeAdapter, decode_acaf_payload
from app.audio import pcm16_rms, pcm16_frame_bytes
from app.protocol import Encoding


def pcm16(*samples: int) -> bytes:
    return struct.pack(f"<{len(samples)}h", *samples)


# --------------------------------------------------------------------------
# Interface contract
# --------------------------------------------------------------------------


class TestAdapterInterface:
    def test_mock_adapter_implements_the_interface(self):
        assert isinstance(MockCallAdapter(), TransportAdapter)

    def test_telegram_adapter_implements_the_interface(self):
        assert isinstance(TelegramBridgeAdapter(object()), TransportAdapter)

    def test_both_adapters_declare_a_carrier(self):
        assert MockCallAdapter().carrier == "mock"
        assert TelegramBridgeAdapter(object()).carrier == "telegram"

    def test_abstract_methods_cannot_be_skipped(self):
        with pytest.raises(TypeError):
            TransportAdapter()  # type: ignore[abstract]

    @pytest.mark.asyncio
    async def test_mock_adapter_works_as_an_async_context_manager(self):
        async with MockCallAdapter(
            script=MockCallScript(utterances=(), total_ms=0), realtime=False
        ) as adapter:
            assert adapter.state.stopped is False
        assert adapter.state.stopped is True

    @pytest.mark.asyncio
    async def test_stop_is_idempotent_on_both_adapters(self):
        mock = MockCallAdapter(realtime=False)
        await mock.stop()
        await mock.stop()
        telegram = TelegramBridgeAdapter(object())
        await telegram.stop()
        await telegram.stop()


class TestNormalizedAudioFrame:
    def test_rejects_bad_sample_rate(self):
        with pytest.raises(ValueError, match="sample_rate"):
            NormalizedAudioFrame(pcm=b"", sample_rate=0)

    def test_rejects_bad_channels(self):
        with pytest.raises(ValueError, match="channels"):
            NormalizedAudioFrame(pcm=b"", sample_rate=16000, channels=0)

    def test_byte_count(self):
        frame = NormalizedAudioFrame(pcm=b"1234", sample_rate=16000)
        assert frame.byte_count == 4

    def test_defaults(self):
        frame = NormalizedAudioFrame(pcm=b"", sample_rate=16000)
        assert frame.channels == 1
        assert frame.encoding == "pcm_s16le"


# --------------------------------------------------------------------------
# Mock call
# --------------------------------------------------------------------------


class TestMockCall:
    @pytest.mark.asyncio
    async def test_emits_audio_rather_than_silence(self):
        """A silent mock would let a broken audio path pass every test."""
        adapter = MockCallAdapter(
            script=MockCallScript(utterances=("hello",), utterance_ms=200, gap_ms=100),
            realtime=False,
        )
        await adapter.start()

        speech_frames = []
        async for frame in adapter.receiveAudio():
            if pcm16_rms(frame.pcm) > 0.01:
                speech_frames.append(frame)
            if len(speech_frames) >= 3:
                break

        assert speech_frames, "mock call produced no audible frames"
        for frame in speech_frames:
            assert pcm16_rms(frame.pcm) > 0.01

    @pytest.mark.asyncio
    async def test_frames_are_the_declared_size(self):
        adapter = MockCallAdapter(sample_rate=16000, realtime=False)
        await adapter.start()
        async for frame in adapter.receiveAudio():
            assert len(frame.pcm) == pcm16_frame_bytes(16000, 20)
            break

    @pytest.mark.asyncio
    async def test_sequence_numbers_are_monotonic(self):
        adapter = MockCallAdapter(realtime=False)
        await adapter.start()
        sequences = []
        async for frame in adapter.receiveAudio():
            sequences.append(frame.sequence)
            if len(sequences) >= 20:
                break
        assert sequences == sorted(sequences)
        assert len(set(sequences)) == len(sequences)

    @pytest.mark.asyncio
    async def test_script_walks_all_utterances(self):
        adapter = MockCallAdapter(
            script=MockCallScript(
                utterances=("one", "two", "three"),
                utterance_ms=100,
                gap_ms=40,
            ),
            realtime=False,
        )
        await adapter.start()
        count = 0
        async for _ in adapter.receiveAudio():
            count += 1
            if count >= 1000:
                break
        assert adapter.state.utterance_count == 3

    @pytest.mark.asyncio
    async def test_stop_ends_the_script(self):
        adapter = MockCallAdapter(realtime=False)
        await adapter.start()
        stream = adapter.receiveAudio()
        await stream.__anext__()
        await adapter.stop()

        # The generator must terminate rather than run forever.
        remaining = 0
        async for _ in stream:
            remaining += 1
            if remaining > 500:
                pytest.fail("receiveAudio did not stop after stop()")
        assert adapter.state.stopped

    @pytest.mark.asyncio
    async def test_assistant_output_is_recorded(self):
        adapter = MockCallAdapter(
            script=MockCallScript(barge_in_after_ms=0), realtime=False
        )
        await adapter.start()
        await adapter.sendAudio(
            NormalizedAudioFrame(pcm=pcm16(*([1000] * 320)), sample_rate=16000)
        )
        assert adapter.state.frames_sent_to_caller == 1
        assert adapter.assistant_bytes == 640

    @pytest.mark.asyncio
    async def test_send_after_stop_is_refused(self):
        adapter = MockCallAdapter(realtime=False)
        await adapter.stop()
        with pytest.raises(AdapterClosed):
            await adapter.sendAudio(NormalizedAudioFrame(pcm=b"", sample_rate=16000))

    @pytest.mark.asyncio
    async def test_non_pcm_frame_is_rejected(self):
        adapter = MockCallAdapter(realtime=False)
        await adapter.start()
        with pytest.raises(ValueError, match="pcm_s16le"):
            await adapter.sendAudio(
                NormalizedAudioFrame(pcm=b"", sample_rate=16000, encoding="mulaw")
            )

    @pytest.mark.asyncio
    async def test_barge_in_cancels_further_output(self):
        """The core TTS-cancellation behaviour, at the adapter layer."""
        adapter = MockCallAdapter(
            script=MockCallScript(barge_in_after_ms=0), realtime=False
        )
        await adapter.start()
        await adapter.sendAudio(
            NormalizedAudioFrame(pcm=pcm16(*([1000] * 320)), sample_rate=16000)
        )
        # Let the scheduled barge-in task run.
        await asyncio.sleep(0.05)
        adapter.trigger_barge_in()

        delivered_before = adapter.state.frames_sent_to_caller
        for _ in range(5):
            await adapter.sendAudio(
                NormalizedAudioFrame(pcm=pcm16(*([1000] * 320)), sample_rate=16000)
            )
        assert adapter.state.frames_sent_to_caller == delivered_before
        assert adapter.state.frames_cancelled == 5

    @pytest.mark.asyncio
    async def test_barge_in_state_clears_for_the_next_turn(self):
        adapter = MockCallAdapter(realtime=False)
        await adapter.start()
        adapter.trigger_barge_in()
        await adapter.sendAudio(NormalizedAudioFrame(pcm=b"", sample_rate=16000))
        assert adapter.state.frames_cancelled == 1

        adapter.note_assistant_idle()
        await adapter.sendAudio(
            NormalizedAudioFrame(pcm=pcm16(1), sample_rate=16000)
        )
        assert adapter.state.frames_sent_to_caller == 1

    def test_stats_are_json_safe(self):
        import json

        stats = MockCallAdapter().stats()
        assert json.loads(json.dumps(stats)) == stats


# --------------------------------------------------------------------------
# Telegram adapter
# --------------------------------------------------------------------------


class FakeBridge:
    """Stands in for an AcafBridge, recording what the adapter sends."""

    def __init__(self) -> None:
        self.sent: list[bytes] = []
        self.closed_with: str | None = None
        self.session = type("S", (), {"session_id": "fake-1"})()

    async def send_audio(self, payload: bytes) -> None:
        self.sent.append(payload)

    async def close(self, reason: str = "closed") -> None:
        self.closed_with = reason


class TestTelegramAdapter:
    @pytest.mark.asyncio
    async def test_inbound_frames_can_be_pushed_and_read(self):
        adapter = TelegramBridgeAdapter(FakeBridge())
        await adapter.start()
        frame = NormalizedAudioFrame(pcm=b"abc", sample_rate=16000)
        await adapter.push_inbound(frame)

        stream = adapter.receiveAudio()
        received = await stream.__anext__()
        assert received is frame

    @pytest.mark.asyncio
    async def test_inbound_queue_is_bounded_and_drops_oldest(self):
        adapter = TelegramBridgeAdapter(FakeBridge(), inbound_queue_size=3)
        await adapter.start()
        for i in range(6):
            await adapter.push_inbound(
                NormalizedAudioFrame(pcm=bytes([i]), sample_rate=16000)
            )

        # Oldest dropped, newest kept.
        stream = adapter.receiveAudio()
        first = await stream.__anext__()
        assert first.pcm == bytes([3])
        assert adapter.stats()["droppedInbound"] == 3

    @pytest.mark.asyncio
    async def test_send_audio_forwards_to_the_bridge(self):
        bridge = FakeBridge()
        adapter = TelegramBridgeAdapter(bridge)
        await adapter.start()
        await adapter.sendAudio(
            NormalizedAudioFrame(pcm=b"payload", sample_rate=16000)
        )
        assert bridge.sent == [b"payload"]

    @pytest.mark.asyncio
    async def test_non_pcm_is_rejected_rather_than_forwarded(self):
        """Forwarding the wrong encoding produces untraceable noise."""
        bridge = FakeBridge()
        adapter = TelegramBridgeAdapter(bridge)
        await adapter.start()
        with pytest.raises(ValueError, match="pcm_s16le"):
            await adapter.sendAudio(
                NormalizedAudioFrame(pcm=b"x", sample_rate=8000, encoding="mulaw")
            )
        assert bridge.sent == []

    @pytest.mark.asyncio
    async def test_stop_closes_the_bridge(self):
        bridge = FakeBridge()
        adapter = TelegramBridgeAdapter(bridge)
        await adapter.start()
        await adapter.stop()
        assert bridge.closed_with == "hung-up"

    @pytest.mark.asyncio
    async def test_send_after_stop_raises(self):
        adapter = TelegramBridgeAdapter(FakeBridge())
        await adapter.start()
        await adapter.stop()
        with pytest.raises(AdapterClosed):
            await adapter.sendAudio(
                NormalizedAudioFrame(pcm=b"x", sample_rate=16000)
            )

    @pytest.mark.asyncio
    async def test_stop_wakes_a_waiting_reader(self):
        """Otherwise a reader would hang until the call timed out."""
        adapter = TelegramBridgeAdapter(FakeBridge())
        await adapter.start()
        stream = adapter.receiveAudio()
        task = asyncio.create_task(stream.__anext__())
        await asyncio.sleep(0.01)
        await adapter.stop()
        with pytest.raises(StopAsyncIteration):
            await asyncio.wait_for(task, timeout=1.0)

    @pytest.mark.asyncio
    async def test_stop_survives_a_failing_bridge(self):
        class BadBridge(FakeBridge):
            async def close(self, reason: str = "closed") -> None:
                raise RuntimeError("bridge exploded")

        adapter = TelegramBridgeAdapter(BadBridge())
        await adapter.start()
        await adapter.stop()  # must not raise

    def test_decode_helper_accepts_pcm(self):
        frame = decode_acaf_payload(
            b"audio", encoding=Encoding.PCM_S16LE, sample_rate=16000, channels=1
        )
        assert frame.pcm == b"audio"
        assert frame.encoding == "pcm_s16le"

    def test_decode_helper_refuses_opus(self):
        """Opus is decoded in PHP; accepting it here would need a codec."""
        with pytest.raises(ValueError, match="pcm_s16le only"):
            decode_acaf_payload(
                b"opus", encoding=Encoding.OGG_OPUS, sample_rate=48000, channels=1
            )
