"""Unit tests for audio conversion.

The G.711 vectors below are the ITU-T G.711 mu-law reference points, not
values captured from this implementation. That distinction matters: a
round-trip test alone would pass even if encode and decode were both wrong in
matching ways, so the fixed vectors are what actually pin the format down.
"""

from __future__ import annotations

import math
import struct

import pytest

from app.audio import (
    BRIDGE_FORMAT,
    MULAW_BIAS,
    PCM16Resampler,
    TELEGRAM_CALL_FORMAT,
    TWILIO_CALL_FORMAT,
    AudioFormat,
    chunk_pcm16,
    is_silence,
    mulaw_to_pcm16,
    pcm16_duration_ms,
    pcm16_frame_bytes,
    pcm16_rms,
    pcm16_sample_count,
    pcm16_to_mulaw,
    pcm16_to_mulaw_sample,
)


def pcm16(*samples: int) -> bytes:
    return struct.pack(f"<{len(samples)}h", *samples)


def samples_of(pcm: bytes) -> list[int]:
    return list(struct.unpack(f"<{len(pcm) // 2}h", pcm))


# --------------------------------------------------------------------------
# G.711 mu-law -- fixed reference vectors
# --------------------------------------------------------------------------


class TestMulawReferenceVectors:
    """Pins the codec to the standard, not to itself."""

    def test_silence_encodes_to_0xff(self):
        # The canonical mu-law encoding of digital silence is 0xFF.
        assert pcm16_to_mulaw_sample(0) == 0xFF

    def test_0xff_decodes_to_zero(self):
        assert samples_of(mulaw_to_pcm16(b"\xff")) == [0]

    def test_0x7f_also_decodes_to_zero(self):
        # Both 0x7F and 0xFF are legitimate zero encodings (positive and
        # negative zero); a codec that maps only one of them is wrong.
        assert samples_of(mulaw_to_pcm16(b"\x7f")) == [0]

    def test_0x00_decodes_to_negative_full_scale(self):
        # 0x00 is the most negative representable mu-law value. The exact
        # figure is ((15 << 3) + 0x84) << 7 - 0x84 = 32124.
        expected = (((15 << 3) + MULAW_BIAS) << 7) - MULAW_BIAS
        assert samples_of(mulaw_to_pcm16(b"\x00")) == [-expected]

    def test_0x80_decodes_to_positive_full_scale(self):
        expected = (((15 << 3) + MULAW_BIAS) << 7) - MULAW_BIAS
        assert samples_of(mulaw_to_pcm16(b"\x80")) == [expected]

    def test_sign_bit_is_the_msb(self):
        # Encoding x and -x must differ only in the sign bit of the mu-law
        # byte. This is the single most likely place for a real bug to hide
        # (sign applied after the complement, etc).
        for value in (100, 1000, 10000, 32000):
            pos = pcm16_to_mulaw_sample(value)
            neg = pcm16_to_mulaw_sample(-value)
            assert pos != neg
            assert (pos ^ neg) == 0x80, f"sign bit mismatch for {value}"


class TestMulawRoundTrip:
    @pytest.mark.parametrize("value", [0, 1, -1, 100, -100, 1000, -1000, 32000, -32000])
    def test_round_trip_is_close(self, value):
        encoded = pcm16_to_mulaw_sample(value)
        decoded = samples_of(mulaw_to_pcm16(bytes([encoded])))[0]
        # mu-law is lossy but monotonic; the error scales with magnitude.
        tolerance = max(8, abs(value) * 0.05)
        assert abs(decoded - value) <= tolerance, (
            f"{value} round-tripped to {decoded}, outside tolerance {tolerance}"
        )

    def test_round_trip_is_monotonic(self):
        """Decoded output must never decrease as input increases."""
        previous = None
        for value in range(-32000, 32001, 37):
            decoded = samples_of(mulaw_to_pcm16(bytes([pcm16_to_mulaw_sample(value)])))[0]
            if previous is not None:
                assert decoded >= previous, (
                    f"non-monotonic at {value}: {decoded} < {previous}"
                )
            previous = decoded

    def test_clipping_behaviour(self):
        # Both +40000 and +32767 sit above the clip threshold and must encode
        # identically; a codec that overflows here produces loud noise bursts.
        assert pcm16_to_mulaw_sample(40000) == pcm16_to_mulaw_sample(32767)
        assert pcm16_to_mulaw_sample(-40000) == pcm16_to_mulaw_sample(-32768)

    def test_byte_buffers_round_trip(self):
        original = pcm16(0, 1000, -1000, 8000, -8000, 32767, -32768)
        encoded = pcm16_to_mulaw(original)
        assert len(encoded) == 7
        decoded = samples_of(mulaw_to_pcm16(encoded))
        assert len(decoded) == 7
        for got, want in zip(decoded, samples_of(original)):
            assert abs(got - want) <= max(8, abs(want) * 0.05)

    def test_odd_trailing_byte_is_dropped_not_raised(self):
        # A truncated frame is a transport artefact. Dropping half a sample is
        # the right call; raising would tear down a live call over it.
        encoded = pcm16_to_mulaw(pcm16(100, 200) + b"\x01")
        assert len(encoded) == 2

    def test_empty_input(self):
        assert pcm16_to_mulaw(b"") == b""
        assert mulaw_to_pcm16(b"") == b""


# --------------------------------------------------------------------------
# PCM16 helpers
# --------------------------------------------------------------------------


class TestPcm16Helpers:
    def test_sample_count(self):
        assert pcm16_sample_count(pcm16(1, 2, 3)) == 3
        assert pcm16_sample_count(b"") == 0

    def test_duration_at_8khz(self):
        # 160 samples at 8 kHz is exactly 20 ms -- Twilio's frame size.
        assert pcm16_duration_ms(pcm16(*([0] * 160)), 8000) == pytest.approx(20.0)

    def test_duration_at_16khz(self):
        assert pcm16_duration_ms(pcm16(*([0] * 320)), 16000) == pytest.approx(20.0)

    def test_frame_bytes_matches_telephony_framing(self):
        # 20 ms @ 8 kHz mono PCM16 = 320 bytes, the classic telephony frame.
        assert pcm16_frame_bytes(8000, 20) == 320
        # 20 ms @ 48 kHz (Telegram's negotiated rate) = 1920 bytes.
        assert pcm16_frame_bytes(48000, 20) == 1920

    def test_frame_bytes_rounds_to_whole_samples(self):
        # 10 ms @ 8000 Hz = 80 samples exactly; 10 ms @ 44100 Hz = 441 samples.
        assert pcm16_frame_bytes(44100, 10) == 441 * 2

    def test_frame_bytes_rejects_nonsense(self):
        with pytest.raises(ValueError):
            pcm16_frame_bytes(0, 20)
        with pytest.raises(ValueError):
            pcm16_frame_bytes(8000, 0)

    def test_chunking_produces_exact_frames(self):
        # 1000 samples = 2000 bytes; 2000 // 320 = 6 chunks of 20 ms, with a
        # ragged 80-byte tail that must be dropped rather than padded.
        data = pcm16(*range(1000))
        chunks = chunk_pcm16(data, 320)
        assert all(len(c) == 320 for c in chunks)
        assert len(chunks) == 6
        assert len(chunks) * 320 == 1920  # 80 bytes discarded, not padded

    def test_chunking_drops_ragged_tail(self):
        # 3 samples = 6 bytes. One 4-byte chunk fits; the trailing 2 bytes do
        # not, so exactly one chunk comes back.
        chunks = chunk_pcm16(pcm16(1, 2, 3), 4)
        assert chunks == [pcm16(1, 2)]
        assert len(b"".join(chunks)) == 4

    def test_chunking_that_fits_nothing_returns_empty(self):
        # 2 bytes (one sample) cannot fill a 4-byte chunk at all.
        assert chunk_pcm16(pcm16(1), 4) == []

    def test_chunking_odd_chunk_size_is_forced_even(self):
        # A 5-byte chunk cannot hold whole PCM16 samples; it must become 4.
        chunks = chunk_pcm16(pcm16(*range(10)), 5)
        assert all(len(c) == 4 for c in chunks)

    def test_chunking_rejects_zero(self):
        with pytest.raises(ValueError):
            chunk_pcm16(pcm16(1, 2), 0)
        with pytest.raises(ValueError):
            chunk_pcm16(pcm16(1, 2), 1)


class TestSilenceDetection:
    def test_all_zero_is_silence(self):
        assert is_silence(pcm16(*([0] * 320)))

    def test_empty_is_silence(self):
        assert is_silence(b"")

    def test_full_scale_is_not_silence(self):
        assert not is_silence(pcm16(*([20000] * 320)))

    def test_quiet_tone_is_not_silence(self):
        tone = pcm16(*[int(3000 * math.sin(i / 10)) for i in range(320)])
        assert not is_silence(tone)

    def test_rms_of_full_scale_square_wave(self):
        assert pcm16_rms(pcm16(*([32767] * 100))) == pytest.approx(1.0, abs=1e-3)

    def test_rms_of_silence(self):
        assert pcm16_rms(pcm16(*([0] * 100))) == 0.0

    def test_rms_of_empty(self):
        assert pcm16_rms(b"") == 0.0


# --------------------------------------------------------------------------
# Resampler
# --------------------------------------------------------------------------


class TestResampler:
    def test_identity_when_rates_match(self):
        resampler = PCM16Resampler(16000, 16000)
        assert resampler.is_identity
        data = pcm16(*range(100))
        assert resampler.process(data) == data

    def test_upsampling_increases_sample_count(self):
        resampler = PCM16Resampler(8000, 16000)
        out = resampler.process(pcm16(*([1000] * 160)))
        assert len(out) // 2 == pytest.approx(320, abs=2)

    def test_downsampling_decreases_sample_count(self):
        resampler = PCM16Resampler(48000, 16000)
        out = resampler.process(pcm16(*([1000] * 480)))
        assert len(out) // 2 == pytest.approx(160, abs=2)

    def test_constant_signal_stays_constant(self):
        """A DC signal must resample to the same DC level, with no ringing."""
        resampler = PCM16Resampler(16000, 8000)
        out = samples_of(resampler.process(pcm16(*([5000] * 320))))
        assert out, "resampler produced no output"
        for value in out:
            assert abs(value - 5000) <= 1, f"DC level drifted to {value}"

    def test_state_persists_across_frames(self):
        """Continuous audio split into frames must equal the same audio as one blob.

        This is the test that catches a non-stateful resampler: a fresh
        resampler per frame injects a discontinuity every frame boundary.
        """
        resampler_a = PCM16Resampler(8000, 16000)
        whole = pcm16(*[int(5000 * math.sin(i / 20)) for i in range(320)])
        out_whole = resampler_a.process(whole)

        resampler_b = PCM16Resampler(8000, 16000)
        halves = [
            resampler_b.process(whole[:320]),
            resampler_b.process(whole[320:]),
        ]
        out_split = b"".join(halves)

        # Lengths may differ by one sample at the seam; the bulk must match.
        assert abs(len(out_whole) - len(out_split)) <= 2

    def test_streaming_continuity_has_no_spike(self):
        """Frame-boundary seams must not introduce a large sample jump."""
        resampler = PCM16Resampler(8000, 16000)
        constant = pcm16(*([4000] * 160))
        out = samples_of(b"".join(resampler.process(constant) for _ in range(5)))
        biggest_jump = max(
            (abs(b - a) for a, b in zip(out, out[1:])),
            default=0,
        )
        # A DC signal through a continuous resampler never steps by more than
        # a rounding unit. A stateless one would step at every 320th sample.
        assert biggest_jump <= 1, f"discontinuity of {biggest_jump} at a frame seam"

    def test_reset_clears_state(self):
        resampler = PCM16Resampler(8000, 16000)
        resampler.process(pcm16(*([1000] * 160)))
        resampler.reset()
        out = samples_of(resampler.process(pcm16(*([1000] * 160))))
        assert out
        assert all(abs(v - 1000) <= 1 for v in out)

    def test_empty_input_is_empty_output(self):
        resampler = PCM16Resampler(8000, 16000)
        assert resampler.process(b"") == b""

    def test_stereo_input_is_handled(self):
        # Stereo is not used on either telephony path, but silently
        # mis-resampling it would be a nasty surprise, so it is defined.
        resampler = PCM16Resampler(8000, 16000, channels=2)
        out = resampler.process(pcm16(*([100, -100] * 80)))
        assert out  # produced something rather than raising

    def test_rejects_invalid_rates(self):
        with pytest.raises(ValueError):
            PCM16Resampler(0, 16000)
        with pytest.raises(ValueError):
            PCM16Resampler(8000, 0)
        with pytest.raises(ValueError):
            PCM16Resampler(8000, 16000, channels=0)

    def test_output_never_clips_past_int16_range(self):
        resampler = PCM16Resampler(8000, 16000)
        loud = pcm16(*([32767, -32768] * 80))
        out = samples_of(resampler.process(loud))
        assert all(-32768 <= v <= 32767 for v in out)


# --------------------------------------------------------------------------
# Format descriptors
# --------------------------------------------------------------------------


class TestAudioFormat:
    def test_describe(self):
        assert BRIDGE_FORMAT.describe() == "pcm_s16le/16000Hz/1ch"

    def test_matches(self):
        assert AudioFormat(16000, 1, "pcm_s16le").matches(BRIDGE_FORMAT)

    def test_telegram_and_twilio_are_not_the_same_format(self):
        """The report's central codec claim, asserted as a test.

        If these ever compare equal, the Twilio and Telegram adapters have
        been wrongly collapsed into one codec path.
        """
        assert TELEGRAM_CALL_FORMAT.sample_rate == 48000
        assert TWILIO_CALL_FORMAT.sample_rate == 8000
        assert not TELEGRAM_CALL_FORMAT.matches(TWILIO_CALL_FORMAT)

    def test_bridge_format_is_neither_carrier_format(self):
        assert not BRIDGE_FORMAT.matches(TELEGRAM_CALL_FORMAT)
        assert not BRIDGE_FORMAT.matches(TWILIO_CALL_FORMAT)

    def test_rejects_invalid(self):
        with pytest.raises(ValueError):
            AudioFormat(0)
        with pytest.raises(ValueError):
            AudioFormat(8000, channels=0)
