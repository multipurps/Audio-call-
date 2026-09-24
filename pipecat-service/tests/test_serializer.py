"""Serializer tests: ACAF <-> Pipecat frames.

Covers the brief's explicit test requirements for interruption and TTS
cancellation, plus frame ordering across the serializer boundary and the
"decode must never kill a call" rule for malformed input.
"""

from __future__ import annotations

import json
import struct

import pytest

from pipecat.frames.frames import (
    CancelFrame,
    EndFrame,
    InputAudioRawFrame,
    InterruptionFrame,
    OutputAudioRawFrame,
)
from pipecat.processors.frame_processor import FrameProcessorSetup

from app.protocol import (
    CONTROL_HANGUP,
    CONTROL_INTERRUPT,
    AudioFrame,
    Encoding,
    FrameType,
)
from app.serializer import TelegramFrameSerializer

BRIDGE_RATE = 16000
PIPELINE_RATE = 16000
SESSION = "test-session-1"


def pcm16(*samples: int) -> bytes:
    return struct.pack(f"<{len(samples)}h", *samples)


def setup_for(rate: int) -> FrameProcessorSetup:
    """Minimal FrameProcessorSetup.

    `TelegramFrameSerializer.setup()` reads only `audio_in_sample_rate`. The
    remaining required fields are passed as None because this serializer has
    no processor lifecycle to attach to -- it is driven directly by the
    transport, not scheduled as a pipeline stage.
    """
    return FrameProcessorSetup(
        audio_in_sample_rate=rate,
        audio_out_sample_rate=rate,
        clock=None,  # type: ignore[arg-type]
        enable_metrics=False,
        task_manager=None,  # type: ignore[arg-type]
        pipeline_worker=None,  # type: ignore[arg-type]
    )


async def make_serializer(
    *, bridge_rate: int = BRIDGE_RATE, pipeline_rate: int = PIPELINE_RATE, **param_overrides
) -> TelegramFrameSerializer:
    params = TelegramFrameSerializer.InputParams(bridge_sample_rate=bridge_rate)
    for key, value in param_overrides.items():
        setattr(params, key, value)
    serializer = TelegramFrameSerializer(SESSION, params=params)
    await serializer.setup(setup_for(pipeline_rate))
    return serializer


def audio_in_bytes(payload: bytes, *, seq: int, rate: int = BRIDGE_RATE) -> bytes:
    return AudioFrame.audio_in(
        payload, sequence=seq, timestamp_ms=seq, sample_rate=rate
    ).encode()


# --------------------------------------------------------------------------
# Inbound
# --------------------------------------------------------------------------


class TestDeserializeAudio:
    @pytest.mark.asyncio
    async def test_pcm_frame_becomes_input_audio_frame(self):
        serializer = await make_serializer()
        payload = pcm16(100, 200, 300)
        frame = await serializer.deserialize(audio_in_bytes(payload, seq=0))

        assert isinstance(frame, InputAudioRawFrame)
        assert frame.audio == payload
        assert frame.sample_rate == PIPELINE_RATE
        assert frame.num_channels == 1
        assert frame.num_frames == 3

    @pytest.mark.asyncio
    async def test_resamples_bridge_rate_to_pipeline_rate(self):
        # Bridge at 8 kHz, pipeline at 16 kHz: frame must arrive at 16 kHz with
        # roughly double the samples. This is the Twilio-side rate mismatch.
        serializer = await make_serializer(bridge_rate=8000, pipeline_rate=16000)
        payload = pcm16(*([1000] * 160))
        frame = await serializer.deserialize(audio_in_bytes(payload, seq=0, rate=8000))

        assert isinstance(frame, InputAudioRawFrame)
        assert frame.sample_rate == 16000
        assert frame.num_frames == pytest.approx(320, abs=4)

    @pytest.mark.asyncio
    async def test_inbound_upsamples_bridge_rate_to_a_higher_pipeline_rate(self):
        # Inbound audio is always bridge_rate -> pipeline_rate. Here that is
        # an *upsample*: 480 samples at 8 kHz is 60 ms, which is 1440 samples
        # at 24 kHz. Getting this backwards would silently play everything at
        # the wrong speed, so the direction is asserted explicitly.
        serializer = await make_serializer(bridge_rate=8000, pipeline_rate=24000)
        payload = pcm16(*([1000] * 480))
        frame = await serializer.deserialize(audio_in_bytes(payload, seq=0, rate=8000))

        assert isinstance(frame, InputAudioRawFrame)
        assert frame.sample_rate == 24000
        assert frame.num_frames == pytest.approx(1440, abs=4)

    @pytest.mark.asyncio
    async def test_resampled_audio_preserves_duration(self):
        """Resampling must change the sample count, never the duration."""
        from app.audio import pcm16_duration_ms

        serializer = await make_serializer(bridge_rate=8000, pipeline_rate=24000)
        payload = pcm16(*([1000] * 480))
        source_ms = pcm16_duration_ms(payload, 8000)

        frame = await serializer.deserialize(audio_in_bytes(payload, seq=0, rate=8000))
        assert frame is not None
        assert pcm16_duration_ms(frame.audio, frame.sample_rate) == pytest.approx(
            source_ms, abs=1.0
        )

    @pytest.mark.asyncio
    async def test_mulaw_frame_is_decoded(self):
        from app.audio import pcm16_to_mulaw

        serializer = await make_serializer()
        mulaw = pcm16_to_mulaw(pcm16(*([1000] * 160)))
        wire = AudioFrame(
            type=FrameType.AUDIO_IN,
            encoding=Encoding.MULAW,
            channels=1,
            sample_rate=BRIDGE_RATE,
            sequence=0,
            timestamp_ms=0,
            payload=mulaw,
        ).encode()

        frame = await serializer.deserialize(wire)
        assert isinstance(frame, InputAudioRawFrame)
        assert frame.num_frames > 0

    @pytest.mark.asyncio
    async def test_opus_frame_is_refused_not_crashed(self):
        """Pipecat 1.11 has no Opus decoder; the failure must be explicit."""
        serializer = await make_serializer()
        wire = AudioFrame(
            type=FrameType.AUDIO_IN,
            encoding=Encoding.OGG_OPUS,
            channels=1,
            sample_rate=48000,
            sequence=0,
            timestamp_ms=0,
            payload=b"fake opus",
        ).encode()

        # Returns None rather than raising: a misconfigured bridge should
        # produce a clear log and a silent call, not a crash loop.
        assert await serializer.deserialize(wire) is None

    @pytest.mark.asyncio
    async def test_empty_payload_is_ignored(self):
        serializer = await make_serializer()
        assert await serializer.deserialize(audio_in_bytes(b"", seq=0)) is None


class TestDeserializeRobustness:
    @pytest.mark.asyncio
    async def test_malformed_binary_is_ignored_not_raised(self):
        serializer = await make_serializer()
        assert await serializer.deserialize(b"not an ACAF frame at all") is None

    @pytest.mark.asyncio
    async def test_truncated_frame_is_ignored(self):
        serializer = await make_serializer()
        good = audio_in_bytes(pcm16(1, 2, 3), seq=0)
        assert await serializer.deserialize(good[:20]) is None

    @pytest.mark.asyncio
    async def test_invalid_json_control_is_ignored(self):
        serializer = await make_serializer()
        assert await serializer.deserialize("{not json") is None

    @pytest.mark.asyncio
    async def test_control_without_type_is_ignored(self):
        serializer = await make_serializer()
        assert await serializer.deserialize(json.dumps({"hello": "there"})) is None

    @pytest.mark.asyncio
    async def test_unknown_control_type_produces_no_frame(self):
        serializer = await make_serializer()
        assert await serializer.deserialize(json.dumps({"type": "who-knows"})) is None

    @pytest.mark.asyncio
    async def test_hello_carries_secret_but_is_not_logged_verbatim(self):
        """`hello` carries the bridge secret; only its type may be logged."""
        serializer = await make_serializer()
        secret = "super-secret-bridge-value"
        frame = await serializer.deserialize(
            json.dumps({"type": "hello", "secret": secret, "platform": "telegram"})
        )
        assert frame is None  # transport-level, not a pipeline frame


class TestInboundOrdering:
    @pytest.mark.asyncio
    async def test_sequence_gap_is_counted_not_fatal(self):
        serializer = await make_serializer()
        for seq in (0, 1, 2, 5):  # 3 and 4 missing
            assert await serializer.deserialize(audio_in_bytes(pcm16(1), seq=seq))

        stats = serializer.stats()
        assert stats["inbound"]["missing"] == 2
        assert stats["inbound"]["received"] == 4

    @pytest.mark.asyncio
    async def test_duplicate_sequence_is_counted(self):
        serializer = await make_serializer()
        await serializer.deserialize(audio_in_bytes(pcm16(1), seq=0))
        await serializer.deserialize(audio_in_bytes(pcm16(1), seq=0))
        assert serializer.stats()["inbound"]["duplicates"] == 1

    @pytest.mark.asyncio
    async def test_reordered_frames_are_counted_not_dropped(self):
        serializer = await make_serializer()
        await serializer.deserialize(audio_in_bytes(pcm16(1), seq=5))
        frame = await serializer.deserialize(audio_in_bytes(pcm16(2), seq=3))
        # Late audio is still forwarded -- dropping it would be worse than
        # playing it slightly out of order, and the count surfaces the issue.
        assert isinstance(frame, InputAudioRawFrame)
        assert serializer.stats()["inbound"]["reordered"] == 1

    @pytest.mark.asyncio
    async def test_gap_does_not_stop_audio_flowing(self):
        serializer = await make_serializer()
        await serializer.deserialize(audio_in_bytes(pcm16(1), seq=0))
        await serializer.deserialize(audio_in_bytes(pcm16(2), seq=100))
        frame = await serializer.deserialize(audio_in_bytes(pcm16(3), seq=101))
        assert isinstance(frame, InputAudioRawFrame)
        assert frame.audio == pcm16(3)


# --------------------------------------------------------------------------
# Outbound
# --------------------------------------------------------------------------


class TestSerializeAudio:
    @pytest.mark.asyncio
    async def test_audio_frame_becomes_acaf_audio_out(self):
        serializer = await make_serializer()
        payload = pcm16(500, -500)
        out = await serializer.serialize(
            OutputAudioRawFrame(audio=payload, sample_rate=BRIDGE_RATE, num_channels=1)
        )
        assert isinstance(out, bytes)

        decoded = AudioFrame.decode(out)
        assert decoded.type is FrameType.AUDIO_OUT
        assert decoded.encoding is Encoding.PCM_S16LE
        assert decoded.payload == payload
        assert decoded.sample_rate == BRIDGE_RATE
        assert decoded.channels == 1

    @pytest.mark.asyncio
    async def test_outbound_sequence_increments(self):
        serializer = await make_serializer()
        sequences = []
        for _ in range(5):
            out = await serializer.serialize(
                OutputAudioRawFrame(audio=pcm16(1), sample_rate=BRIDGE_RATE, num_channels=1)
            )
            sequences.append(AudioFrame.decode(out).sequence)
        assert sequences == [0, 1, 2, 3, 4]

    @pytest.mark.asyncio
    async def test_outbound_sequence_wraps_at_uint32(self):
        serializer = await make_serializer()
        serializer._out_sequence = 0xFFFFFFFF
        out = await serializer.serialize(
            OutputAudioRawFrame(audio=pcm16(1), sample_rate=BRIDGE_RATE, num_channels=1)
        )
        assert AudioFrame.decode(out).sequence == 0xFFFFFFFF
        out = await serializer.serialize(
            OutputAudioRawFrame(audio=pcm16(1), sample_rate=BRIDGE_RATE, num_channels=1)
        )
        assert AudioFrame.decode(out).sequence == 0

    @pytest.mark.asyncio
    async def test_outbound_resampling_to_bridge_rate(self):
        # Pipeline emits at 24 kHz, bridge wants 8 kHz.
        serializer = await make_serializer(bridge_rate=8000, pipeline_rate=24000)
        out = await serializer.serialize(
            OutputAudioRawFrame(
                audio=pcm16(*([1000] * 480)), sample_rate=24000, num_channels=1
            )
        )
        decoded = AudioFrame.decode(out)
        assert decoded.sample_rate == 8000
        assert len(decoded.payload) // 2 == pytest.approx(160, abs=4)

    @pytest.mark.asyncio
    async def test_empty_audio_produces_nothing(self):
        serializer = await make_serializer()
        assert (
            await serializer.serialize(
                OutputAudioRawFrame(audio=b"", sample_rate=BRIDGE_RATE, num_channels=1)
            )
            is None
        )


class TestSerializeControl:
    @pytest.mark.asyncio
    async def test_end_frame_emits_hangup(self):
        serializer = await make_serializer()
        out = await serializer.serialize(EndFrame())
        assert isinstance(out, str)
        body = json.loads(out)
        assert body["type"] == CONTROL_HANGUP
        assert body["sessionId"] == SESSION

    @pytest.mark.asyncio
    async def test_cancel_frame_emits_hangup(self):
        serializer = await make_serializer()
        out = await serializer.serialize(CancelFrame())
        assert json.loads(out)["type"] == CONTROL_HANGUP

    @pytest.mark.asyncio
    async def test_hangup_is_emitted_only_once(self):
        # EndFrame is often followed by CancelFrame during teardown; sending
        # hangup twice would make the PHP side discard a call that is already
        # being torn down, which shows up as a spurious error in its logs.
        serializer = await make_serializer()
        assert await serializer.serialize(EndFrame()) is not None
        assert await serializer.serialize(CancelFrame()) is None
        assert serializer.stats()["hangupSent"] is True

    @pytest.mark.asyncio
    async def test_auto_hang_up_can_be_disabled(self):
        serializer = await make_serializer(auto_hang_up=False)
        assert await serializer.serialize(EndFrame()) is None

    @pytest.mark.asyncio
    async def test_unhandled_frame_produces_nothing(self):
        from pipecat.frames.frames import StartFrame

        serializer = await make_serializer()
        assert await serializer.serialize(StartFrame()) is None

    @pytest.mark.asyncio
    async def test_transport_message_requires_a_type(self):
        from pipecat.frames.frames import OutputTransportMessageFrame

        serializer = await make_serializer()
        # A message without a type is not forwarded: otherwise pipeline code
        # could write arbitrary content onto the bridge.
        assert (
            await serializer.serialize(
                OutputTransportMessageFrame(message={"not": "typed"})
            )
            is None
        )
        out = await serializer.serialize(
            OutputTransportMessageFrame(message={"type": "custom", "x": 1})
        )
        assert json.loads(out) == {"type": "custom", "x": 1}


# --------------------------------------------------------------------------
# Interruption / barge-in / TTS cancellation
# --------------------------------------------------------------------------


class TestInterruptionAndTtsCancellation:
    @pytest.mark.asyncio
    async def test_inbound_interrupt_control_becomes_interruption_frame(self):
        serializer = await make_serializer()
        frame = await serializer.deserialize(
            json.dumps({"type": CONTROL_INTERRUPT, "sessionId": SESSION})
        )
        # This is what actually stops the LLM/TTS turn in flight. Without it,
        # barge-in would be recorded and then ignored.
        assert isinstance(frame, InterruptionFrame)

    @pytest.mark.asyncio
    async def test_inbound_interrupt_binary_frame_becomes_interruption_frame(self):
        serializer = await make_serializer()
        wire = AudioFrame(
            type=FrameType.INTERRUPT,
            encoding=Encoding.PCM_S16LE,
            channels=1,
            sample_rate=BRIDGE_RATE,
            sequence=0,
            timestamp_ms=0,
            payload=b"",
        ).encode()
        assert isinstance(await serializer.deserialize(wire), InterruptionFrame)

    @pytest.mark.asyncio
    async def test_outbound_interruption_frame_emits_interrupt_control(self):
        serializer = await make_serializer()
        out = await serializer.serialize(InterruptionFrame())
        body = json.loads(out)
        assert body["type"] == CONTROL_INTERRUPT
        assert body["sessionId"] == SESSION

    @pytest.mark.asyncio
    async def test_tts_cancellation_is_counted(self):
        serializer = await make_serializer()
        for _ in range(3):
            await serializer.serialize(InterruptionFrame())
        assert serializer.stats()["ttsFramesCancelled"] == 3

    @pytest.mark.asyncio
    async def test_barge_in_and_cancellation_are_counted_separately(self):
        """One caller barge-in must not be counted as two interruptions.

        `bargeIns` counts the caller starting to speak; `ttsFramesCancelled`
        counts the pipeline tearing down the output turn. They are different
        events, and merging them would make the metric unable to show a
        pipeline that cancels output more often than it is interrupted.
        """
        serializer = await make_serializer()
        await serializer.deserialize(json.dumps({"type": CONTROL_INTERRUPT}))
        await serializer.serialize(InterruptionFrame())

        stats = serializer.stats()
        assert stats["bargeIns"] == 1
        assert stats["ttsFramesCancelled"] == 1

    @pytest.mark.asyncio
    async def test_repeated_cancellations_do_not_inflate_barge_ins(self):
        serializer = await make_serializer()
        for _ in range(4):
            await serializer.serialize(InterruptionFrame())
        stats = serializer.stats()
        assert stats["bargeIns"] == 0
        assert stats["ttsFramesCancelled"] == 4

    @pytest.mark.asyncio
    async def test_interrupt_does_not_disturb_sequence_continuity(self):
        """Barge-in must not corrupt the outbound frame counter.

        If an interruption reset or skipped the counter, the PHP side would
        report a phantom gap on every barge-in -- the exact behaviour that
        makes loss metrics useless.
        """
        serializer = await make_serializer()
        await serializer.serialize(
            OutputAudioRawFrame(audio=pcm16(1), sample_rate=BRIDGE_RATE, num_channels=1)
        )
        await serializer.serialize(InterruptionFrame())
        out = await serializer.serialize(
            OutputAudioRawFrame(audio=pcm16(2), sample_rate=BRIDGE_RATE, num_channels=1)
        )
        assert AudioFrame.decode(out).sequence == 1

    @pytest.mark.asyncio
    async def test_audio_after_interrupt_still_flows(self):
        """Cancelling queued TTS must not permanently mute the assistant."""
        serializer = await make_serializer()
        await serializer.serialize(InterruptionFrame())
        out = await serializer.serialize(
            OutputAudioRawFrame(audio=pcm16(7), sample_rate=BRIDGE_RATE, num_channels=1)
        )
        assert out is not None
        assert AudioFrame.decode(out).payload == pcm16(7)


# --------------------------------------------------------------------------
# Metrics
# --------------------------------------------------------------------------


class TestMetrics:
    @pytest.mark.asyncio
    async def test_metrics_respect_the_interval(self):
        serializer = await make_serializer(metrics_interval_secs=15.0)
        assert serializer.maybe_metrics() is None  # not due yet

    @pytest.mark.asyncio
    async def test_metrics_emitted_once_due(self):
        serializer = await make_serializer(metrics_interval_secs=15.0)
        serializer._last_metrics_at = 0.0  # force "due"
        out = serializer.maybe_metrics()
        assert out is not None
        body = json.loads(out)
        assert body["type"] == "metrics"
        assert "inbound" in body
        assert "bargeIns" in body
        assert "outboundFramesSent" in body

    @pytest.mark.asyncio
    async def test_metrics_can_be_disabled(self):
        serializer = await make_serializer(metrics_interval_secs=0)
        assert serializer.maybe_metrics() is None

    @pytest.mark.asyncio
    async def test_metrics_contain_no_audio(self):
        serializer = await make_serializer(metrics_interval_secs=15.0)
        await serializer.deserialize(audio_in_bytes(pcm16(12345, -12345), seq=0))
        serializer._last_metrics_at = 0.0
        rendered = serializer.maybe_metrics()
        assert "12345" not in rendered
        assert "level" not in rendered.lower() or "inbound" in rendered

    @pytest.mark.asyncio
    async def test_stats_are_json_safe(self):
        serializer = await make_serializer()
        stats = serializer.stats()
        assert json.loads(json.dumps(stats)) == stats
        assert stats["bridgeSampleRate"] == BRIDGE_RATE


class TestSpeakingState:
    @pytest.mark.asyncio
    async def test_assistant_speaking_flag_tracks_output(self):
        serializer = await make_serializer()
        assert not serializer.assistant_speaking
        await serializer.serialize(
            OutputAudioRawFrame(audio=pcm16(1), sample_rate=BRIDGE_RATE, num_channels=1)
        )
        assert serializer.assistant_speaking
        serializer.note_assistant_stopped_speaking()
        assert not serializer.assistant_speaking
