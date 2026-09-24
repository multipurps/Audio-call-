"""Unit tests for the ACAF wire protocol.

Covers the brief's explicit requirements: frame ordering, missing frames,
and the frame header's self-describing fields.
"""

from __future__ import annotations

import struct

import pytest

from app.protocol import (
    HEADER_SIZE,
    MAGIC,
    MAX_PAYLOAD_BYTES,
    VERSION,
    AudioFrame,
    ControlMessage,
    Encoding,
    FrameType,
    ProtocolError,
    SequenceTracker,
)


class TestFrameRoundTrip:
    def test_encode_decode_preserves_every_field(self):
        original = AudioFrame(
            type=FrameType.AUDIO_IN,
            encoding=Encoding.PCM_S16LE,
            channels=1,
            sample_rate=16000,
            sequence=42,
            timestamp_ms=1_700_000_000_000,
            payload=b"\x01\x02\x03\x04",
        )
        decoded = AudioFrame.decode(original.encode())

        assert decoded.type is FrameType.AUDIO_IN
        assert decoded.encoding is Encoding.PCM_S16LE
        assert decoded.channels == 1
        assert decoded.sample_rate == 16000
        assert decoded.sequence == 42
        assert decoded.timestamp_ms == 1_700_000_000_000
        assert decoded.payload == b"\x01\x02\x03\x04"
        assert decoded.version == VERSION

    def test_header_is_exactly_28_bytes(self):
        frame = AudioFrame.audio_in(
            b"", sequence=0, timestamp_ms=0, sample_rate=16000
        )
        assert len(frame.encode()) == HEADER_SIZE == 28

    def test_magic_is_stable(self):
        # The magic is the resync anchor for the PHP side; changing it is a
        # breaking protocol change and this test exists to make that obvious.
        assert MAGIC == b"ACAF"
        assert AudioFrame.decode(
            AudioFrame.audio_in(b"", sequence=0, timestamp_ms=0, sample_rate=8000).encode()
        )

    def test_timestamp_uses_full_uint64_range(self):
        # Millisecond epoch timestamps exceed uint32 (which caps at ~1970+49
        # days); the field must be 64-bit or every real call timestamp wraps.
        big = 2**40
        frame = AudioFrame.audio_in(
            b"", sequence=0, timestamp_ms=big, sample_rate=16000
        )
        assert AudioFrame.decode(frame.encode()).timestamp_ms == big

    def test_sequence_wraps_at_uint32(self):
        frame = AudioFrame.audio_in(
            b"", sequence=0xFFFFFFFF, timestamp_ms=0, sample_rate=16000
        )
        assert AudioFrame.decode(frame.encode()).sequence == 0xFFFFFFFF

    def test_all_encodings_round_trip(self):
        for enc in Encoding:
            frame = AudioFrame(
                type=FrameType.AUDIO_IN,
                encoding=enc,
                channels=1,
                sample_rate=16000,
                sequence=1,
                timestamp_ms=1,
                payload=b"payload",
            )
            assert AudioFrame.decode(frame.encode()).encoding is enc

    def test_all_frame_types_round_trip(self):
        for ftype in FrameType:
            frame = AudioFrame(
                type=ftype,
                encoding=Encoding.PCM_S16LE,
                channels=1,
                sample_rate=16000,
                sequence=1,
                timestamp_ms=1,
            )
            assert AudioFrame.decode(frame.encode()).type is ftype

    def test_max_payload_round_trips(self):
        payload = b"\x00" * MAX_PAYLOAD_BYTES
        frame = AudioFrame.audio_in(
            payload, sequence=1, timestamp_ms=1, sample_rate=16000
        )
        assert AudioFrame.decode(frame.encode()).payload == payload


class TestFrameValidation:
    def test_rejects_short_datagram(self):
        with pytest.raises(ProtocolError, match="shorter than header"):
            AudioFrame.decode(b"ACAF\x01")

    def test_rejects_bad_magic(self):
        good = AudioFrame.audio_in(b"", sequence=0, timestamp_ms=0, sample_rate=8000).encode()
        bad = b"XXXX" + good[4:]
        with pytest.raises(ProtocolError, match="bad magic"):
            AudioFrame.decode(bad)

    def test_rejects_wrong_version(self):
        good = bytearray(
            AudioFrame.audio_in(b"", sequence=0, timestamp_ms=0, sample_rate=8000).encode()
        )
        good[4] = 99
        with pytest.raises(ProtocolError, match="unsupported protocol version"):
            AudioFrame.decode(bytes(good))

    def test_rejects_unknown_frame_type(self):
        good = bytearray(
            AudioFrame.audio_in(b"", sequence=0, timestamp_ms=0, sample_rate=8000).encode()
        )
        good[5] = 200
        with pytest.raises(ProtocolError, match="unknown frame type"):
            AudioFrame.decode(bytes(good))

    def test_rejects_unknown_encoding(self):
        good = bytearray(
            AudioFrame.audio_in(b"", sequence=0, timestamp_ms=0, sample_rate=8000).encode()
        )
        good[6] = 200
        with pytest.raises(ProtocolError, match="unknown encoding"):
            AudioFrame.decode(bytes(good))

    def test_rejects_truncated_payload(self):
        # Header declares 100 payload bytes but only 4 are present. This is the
        # single most important validation: without it, a partial TCP read
        # would be handed to the pipeline as if it were complete audio.
        header = struct.pack(
            "<4sBBBBIIQI", MAGIC, VERSION, 1, 1, 1, 16000, 1, 1, 100
        )
        with pytest.raises(ProtocolError, match="truncated frame"):
            AudioFrame.decode(header + b"\x00\x00\x00\x00")

    def test_rejects_oversized_declared_payload(self):
        header = struct.pack(
            "<4sBBBBIIQI", MAGIC, VERSION, 1, 1, 1, 16000, 1, 1, MAX_PAYLOAD_BYTES + 1
        )
        with pytest.raises(ProtocolError, match="exceeds MAX_PAYLOAD_BYTES"):
            AudioFrame.decode(header + b"\x00" * 10)

    def test_rejects_zero_channels(self):
        with pytest.raises(ProtocolError, match="channels"):
            AudioFrame(
                type=FrameType.AUDIO_IN,
                encoding=Encoding.PCM_S16LE,
                channels=0,
                sample_rate=16000,
                sequence=0,
                timestamp_ms=0,
            )

    def test_rejects_zero_sample_rate(self):
        with pytest.raises(ProtocolError, match="sample_rate"):
            AudioFrame(
                type=FrameType.AUDIO_IN,
                encoding=Encoding.PCM_S16LE,
                channels=1,
                sample_rate=0,
                sequence=0,
                timestamp_ms=0,
            )

    def test_zero_channel_frame_on_wire_is_rejected(self):
        # The dataclass guards construction, but a hostile peer bypasses it by
        # writing the header directly. Decode must validate independently.
        header = struct.pack("<4sBBBBIIQI", MAGIC, VERSION, 1, 1, 0, 16000, 1, 1, 0)
        with pytest.raises(ProtocolError, match="channels must be >= 1"):
            AudioFrame.decode(header)

    def test_trailing_bytes_are_ignored(self):
        # A frame followed by padding must still parse: the reader may hand us
        # a buffer with more than one frame in it.
        frame = AudioFrame.audio_in(b"abcd", sequence=1, timestamp_ms=1, sample_rate=8000)
        decoded = AudioFrame.decode(frame.encode() + b"trailing junk")
        assert decoded.payload == b"abcd"


class TestFrameDerivedProperties:
    def test_frame_duration_for_20ms_telephony_frame(self):
        frame = AudioFrame.audio_in(
            b"\x00" * 320, sequence=0, timestamp_ms=0, sample_rate=8000
        )
        assert frame.frame_duration_ms == pytest.approx(20.0)

    def test_frame_duration_for_20ms_telegram_frame(self):
        frame = AudioFrame.audio_in(
            b"\x00" * 1920, sequence=0, timestamp_ms=0, sample_rate=48000
        )
        assert frame.frame_duration_ms == pytest.approx(20.0)

    def test_stereo_frame_duration_accounts_for_channels(self):
        frame = AudioFrame.audio_in(
            b"\x00" * 640, sequence=0, timestamp_ms=0, sample_rate=8000,
            channels=2,
        )
        assert frame.frame_duration_ms == pytest.approx(20.0)

    def test_opus_frame_duration_is_undefined(self):
        # OGG Opus is a container; frame duration is not derivable from a
        # byte count. Claiming a number here would be a fabrication.
        frame = AudioFrame(
            type=FrameType.AUDIO_IN,
            encoding=Encoding.OGG_OPUS,
            channels=1,
            sample_rate=48000,
            sequence=0,
            timestamp_ms=0,
            payload=b"\x00" * 100,
        )
        assert frame.frame_duration_ms is None


# --------------------------------------------------------------------------
# Frame ordering and missing frames
# --------------------------------------------------------------------------


class TestSequenceTracker:
    def test_in_order_stream_reports_no_loss(self):
        tracker = SequenceTracker()
        for seq in range(100):
            assert tracker.observe(seq) == 0
        assert tracker.missing == 0
        assert tracker.loss_ratio == 0.0
        assert tracker.received == 100

    def test_first_frame_establishes_baseline(self):
        tracker = SequenceTracker()
        # Starting mid-stream must not report every prior frame as missing.
        assert tracker.observe(5000) == 0
        assert tracker.missing == 0

    def test_detects_single_missing_frame(self):
        tracker = SequenceTracker()
        tracker.observe(1)
        assert tracker.observe(3) == 1
        assert tracker.missing == 1

    def test_detects_run_of_missing_frames(self):
        tracker = SequenceTracker()
        tracker.observe(10)
        assert tracker.observe(20) == 9
        assert tracker.missing == 9

    def test_counts_duplicates_separately(self):
        # A duplicate is not packet loss and must not inflate loss_ratio.
        tracker = SequenceTracker()
        tracker.observe(1)
        assert tracker.observe(1) == 0
        assert tracker.duplicates == 1
        assert tracker.missing == 0

    def test_counts_reordering_separately(self):
        tracker = SequenceTracker()
        tracker.observe(1)
        tracker.observe(2)
        assert tracker.observe(1) == 0
        assert tracker.reordered == 1
        assert tracker.missing == 0

    def test_loss_ratio(self):
        tracker = SequenceTracker()
        for seq in [0, 1, 2, 4]:  # one missing (3)
            tracker.observe(seq)
        assert tracker.missing == 1
        assert tracker.received == 4
        assert tracker.loss_ratio == pytest.approx(0.2)

    def test_loss_ratio_with_no_frames(self):
        assert SequenceTracker().loss_ratio == 0.0

    def test_handles_uint32_wraparound(self):
        # A call long enough to exhaust a uint32 counter (about 2.7 years at
        # 50 fps, but exactly what a frame counter must not break on) must
        # continue cleanly from 0xFFFFFFFF to 0.
        tracker = SequenceTracker()
        tracker.observe(0xFFFFFFFE)
        assert tracker.observe(0xFFFFFFFF) == 0
        assert tracker.observe(0) == 0
        assert tracker.observe(1) == 0
        assert tracker.missing == 0
        assert tracker.reordered == 0

    def test_wraparound_with_gap(self):
        tracker = SequenceTracker()
        tracker.observe(0xFFFFFFFD)
        # ...FF, 0, 1 skipped: 0xFFFFFFFD -> 0xFFFFFFFE is the next frame, but
        # we jump straight to 1, so FE, FF, 0 are missing: 3 frames.
        assert tracker.observe(1) == 3
        assert tracker.missing == 3

    def test_reset_clears_everything(self):
        tracker = SequenceTracker()
        tracker.observe(1)
        tracker.observe(5)
        tracker.reset()
        assert tracker.last_sequence is None
        assert tracker.missing == 0
        assert tracker.received == 0
        assert tracker.reordered == 0
        assert tracker.duplicates == 0

    def test_metrics_shape_is_json_safe(self):
        import json

        tracker = SequenceTracker()
        for seq in [0, 1, 3]:
            tracker.observe(seq)
        metrics = tracker.as_metrics()
        # Must survive json.dumps -- these go straight into a control message.
        assert json.loads(json.dumps(metrics)) == metrics
        assert set(metrics) == {
            "received",
            "missing",
            "reordered",
            "duplicates",
            "lossRatio",
        }


# --------------------------------------------------------------------------
# Control plane
# --------------------------------------------------------------------------


class TestControlMessage:
    def test_round_trip(self):
        original = ControlMessage(
            type="hello", session_id="abc-123", extra={"platform": "telegram"}
        )
        restored = ControlMessage.from_dict(original.to_dict())
        assert restored.type == "hello"
        assert restored.session_id == "abc-123"
        assert restored.extra == {"platform": "telegram"}

    def test_to_dict_uses_camel_case_session_id(self):
        assert ControlMessage("ping", "s1").to_dict() == {"type": "ping", "sessionId": "s1"}

    def test_omits_session_id_when_absent(self):
        assert ControlMessage("ping").to_dict() == {"type": "ping"}

    def test_rejects_non_dict(self):
        with pytest.raises(ProtocolError, match="JSON object"):
            ControlMessage.from_dict(["not", "a", "dict"])  # type: ignore[arg-type]

    def test_rejects_missing_type(self):
        with pytest.raises(ProtocolError, match="missing string 'type'"):
            ControlMessage.from_dict({})

    def test_rejects_non_string_type(self):
        with pytest.raises(ProtocolError, match="missing string 'type'"):
            ControlMessage.from_dict({"type": 42})

    def test_non_string_session_id_becomes_none(self):
        message = ControlMessage.from_dict({"type": "ping", "sessionId": 12345})
        assert message.session_id is None

    def test_extra_fields_are_preserved(self):
        message = ControlMessage.from_dict(
            {"type": "metrics", "jitterMs": 12, "nested": {"a": 1}}
        )
        assert message.extra["jitterMs"] == 12
        assert message.extra["nested"] == {"a": 1}
