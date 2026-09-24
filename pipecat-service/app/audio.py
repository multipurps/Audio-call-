"""Audio conversion primitives for the ACAF bridge.

Deliberately dependency-free: no numpy, no scipy, no Pipecat import. Three
reasons this matters here rather than being a stylistic preference:

  1. The codecs are the part of the system most likely to be silently wrong
     (a swapped byte order or an off-by-one in a G.711 table still "works",
     it just sounds bad), so they have to be testable with nothing installed.
  2. The PHP side of the bridge implements the mirror image of these; keeping
     them spelled out in plain arithmetic gives the PHP author an unambiguous
     reference instead of "match whatever Pipecat does".
  3. Pipecat's own transport resamples between the bridge's declared rate and
     the pipeline rate using Pipecat's resampler. Re-resampling here as well
     would stack two resamplers on the same signal, which is worse than
     either one alone.

Normalization rules enforced by this module, matching the report's codec table:

  * PCM16 is signed 16-bit little-endian (CTYPES of the protocol header's
    PCM_S16LE encoding). Nothing here ever emits big-endian.
  * Channel counts are 1 except where a caller explicitly asks otherwise;
    Telegram 1:1 calls and Twilio Media Streams are both mono.
  * G.711 is the standard ITU-T mu-law, not A-law. Twilio's Media Streams
    use mu-law; A-law is only relevant to European PSTN trunks, which this
    application does not touch.
"""

from __future__ import annotations

import math
import struct
from dataclasses import dataclass, field

# --------------------------------------------------------------------------
# G.711 mu-law (ITU-T standard -- used by Twilio Media Streams)
# --------------------------------------------------------------------------

MULAW_BIAS = 0x84
MULAW_CLIP = 32635

def _mulaw_decode_sample(u: int) -> int:
    """Decode one mu-law byte to a signed 16-bit sample."""
    u = ~u & 0xFF
    sign = u & 0x80
    exponent = (u >> 4) & 0x07
    mantissa = u & 0x0F
    sample = ((mantissa << 3) + MULAW_BIAS) << exponent
    sample -= MULAW_BIAS
    return -sample if sign else sample


#: Precomputed 256-entry decode table (512 bytes, little-endian int16 pairs).
#: Decode runs once per sample on every inbound Twilio frame, so the table
#: earns its keep on a 20 ms hot path.
_MULAW_DECODE_TABLE: bytes = b"".join(
    struct.pack("<h", _mulaw_decode_sample(u)) for u in range(256)
)


def pcm16_to_mulaw_sample(sample: int) -> int:
    """Encode one signed 16-bit sample to a mu-law byte."""
    sign = 0x80 if sample < 0 else 0
    if sample < 0:
        sample = -sample
    if sample > MULAW_CLIP:
        sample = MULAW_CLIP
    sample += MULAW_BIAS

    exponent = 7
    mask = 0x4000
    while exponent > 0 and not (sample & mask):
        exponent -= 1
        mask >>= 1

    mantissa = (sample >> (exponent + 3)) & 0x0F
    return ~(sign | (exponent << 4) | mantissa) & 0xFF


def pcm16_to_mulaw(pcm: bytes) -> bytes:
    """Encode little-endian PCM16 bytes to mu-law bytes.

    An odd trailing byte is dropped rather than raising: a truncated frame is
    a transport artefact, and dropping 1/160th of a 20 ms frame is preferable
    to tearing down a live call over it.
    """
    usable = len(pcm) - (len(pcm) % 2)
    out = bytearray(usable // 2)
    for i in range(usable // 2):
        out[i] = pcm16_to_mulaw_sample(struct.unpack_from("<h", pcm, i * 2)[0])
    return bytes(out)


def mulaw_to_pcm16(ulaw: bytes) -> bytes:
    """Decode mu-law bytes to little-endian PCM16 bytes."""
    out = bytearray(len(ulaw) * 2)
    for i, u in enumerate(ulaw):
        out[i * 2 : i * 2 + 2] = _MULAW_DECODE_TABLE[u * 2 : u * 2 + 2]
    return bytes(out)


# --------------------------------------------------------------------------
# PCM16 helpers
# --------------------------------------------------------------------------


def pcm16_sample_count(pcm: bytes, channels: int = 1) -> int:
    """Frames (not samples) in a PCM16 buffer."""
    if channels < 1:
        raise ValueError(f"channels must be >= 1, got {channels}")
    return len(pcm) // (2 * channels)


def pcm16_duration_ms(pcm: bytes, sample_rate: int, channels: int = 1) -> float:
    """Duration of a PCM16 buffer in milliseconds."""
    if sample_rate < 1:
        raise ValueError(f"sample_rate must be >= 1, got {sample_rate}")
    return (pcm16_sample_count(pcm, channels) / sample_rate) * 1000.0


def pcm16_frame_bytes(
    sample_rate: int, duration_ms: float, channels: int = 1
) -> int:
    """Bytes needed for `duration_ms` of PCM16 at `sample_rate`.

    Rounded down to a whole frame boundary so the result is always an exact
    number of samples -- a non-integer sample count is not representable and
    silently truncating it is how audio ends up with periodic clicks.
    """
    if sample_rate < 1:
        raise ValueError(f"sample_rate must be >= 1, got {sample_rate}")
    if duration_ms <= 0:
        raise ValueError(f"duration_ms must be > 0, got {duration_ms}")
    frames = int(sample_rate * (duration_ms / 1000.0))
    return frames * 2 * channels


def chunk_pcm16(pcm: bytes, chunk_bytes: int) -> list[bytes]:
    """Split PCM16 into fixed-size chunks, dropping a ragged tail.

    Used to pace outbound audio to Telegram/Twilio, both of which expect a
    steady frame cadence. A short trailing chunk is dropped rather than padded
    with silence, because padding inserts an audible gap.
    """
    if chunk_bytes <= 0:
        raise ValueError(f"chunk_bytes must be > 0, got {chunk_bytes}")
    chunk_bytes -= chunk_bytes % 2  # must be a whole number of samples
    if chunk_bytes == 0:
        raise ValueError("chunk_bytes too small to hold one PCM16 sample")
    return [pcm[i : i + chunk_bytes] for i in range(0, len(pcm) - chunk_bytes + 1, chunk_bytes)]


def pcm16_rms(pcm: bytes) -> float:
    """Root-mean-square amplitude, normalised to 0.0-1.0.

    Used for the "is this frame silence" checks and for logging audio *levels*
    without logging audio. Logging a level is how you debug a call without ever
    putting call content in the logs.
    """
    count = len(pcm) // 2
    if count == 0:
        return 0.0
    total = 0.0
    for i in range(count):
        sample = struct.unpack_from("<h", pcm, i * 2)[0]
        total += float(sample) * float(sample)
    return math.sqrt(total / count) / 32768.0


def is_silence(pcm: bytes, threshold: float = 1e-4) -> bool:
    """True when a PCM16 buffer is effectively silent.

    Cheap magnitude check first so the common all-zero frame short-circuits
    before the full RMS loop.
    """
    if not pcm:
        return True
    if not any(pcm):
        return True
    return pcm16_rms(pcm) < threshold


# --------------------------------------------------------------------------
# Streaming resampler
# --------------------------------------------------------------------------


@dataclass
class _ResamplerState:
    """Carry-over state so consecutive frames resample without seams."""

    last_sample: float = 0.0
    position: float = 0.0
    primed: bool = False


class PCM16Resampler:
    """Stateful linear-interpolation resampler for streaming PCM16.

    Linear interpolation is the right tradeoff here specifically because this
    is used on telephony-band speech that is about to be fed to a recogniser
    or a codec that band-limits anyway. A windowed-sinc resampler would be
    measurably better on music and measurably slower on a 20 ms hot path.

    Statefulness is not optional: a fresh resampler per frame would discard
    the interpolant across the frame boundary and inject a discontinuity at
    every 20 ms, which is audible as a periodic buzz.
    """

    def __init__(self, in_rate: int, out_rate: int, channels: int = 1):
        if in_rate < 1 or out_rate < 1:
            raise ValueError(
                f"sample rates must be >= 1, got in_rate={in_rate}, out_rate={out_rate}"
            )
        if channels < 1:
            raise ValueError(f"channels must be >= 1, got {channels}")
        self.in_rate = in_rate
        self.out_rate = out_rate
        self.channels = channels
        self._ratio = in_rate / out_rate
        self._state = _ResamplerState()

    @property
    def is_identity(self) -> bool:
        return self.in_rate == self.out_rate

    def reset(self) -> None:
        self._state = _ResamplerState()

    def process(self, pcm: bytes) -> bytes:
        """Resample one buffer. Returns PCM16 at `out_rate`."""
        if self.is_identity:
            return pcm
        if not pcm:
            return b""

        channels = self.channels
        usable = len(pcm) - (len(pcm) % (2 * channels))
        if usable == 0:
            return b""

        frame_count = usable // (2 * channels)
        samples = struct.unpack_from(f"<{frame_count * channels}h", pcm, 0)

        # Collapse to mono for interpolation, then re-expand. Interpolating
        # each channel independently is equivalent for mono and avoids an
        # interleaving bug for stereo; stereo is not used on either telephony
        # path today, but silently mis-resampling it would be a nasty surprise.
        if channels > 1:
            mono = [
                sum(samples[i * channels : i * channels + channels]) / channels
                for i in range(frame_count)
            ]
        else:
            mono = list(samples)

        st = self._state
        if not st.primed:
            st.last_sample = float(mono[0])
            st.position = 0.0
            st.primed = True

        out: list[int] = []
        # Walk the input, emitting whenever the output grid advances past the
        # current interpolation segment.
        prev = st.last_sample
        position = st.position
        for sample in mono:
            cur = float(sample)
            while position < 1.0:
                interpolated = prev + (cur - prev) * position
                clamped = int(round(interpolated))
                if clamped > 32767:
                    clamped = 32767
                elif clamped < -32768:
                    clamped = -32768
                out.append(clamped)
                position += self._ratio
            position -= 1.0
            prev = cur

        st.last_sample = prev
        st.position = position
        if not out:
            return b""
        return struct.pack(f"<{len(out)}h", *out)


# --------------------------------------------------------------------------
# Format descriptor
# --------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class AudioFormat:
    """A declared audio format, so mismatches are caught rather than assumed.

    The report's codec table shows why this type exists: Telegram is 48 kHz
    Opus, Twilio is 8 kHz mu-law, Fish Audio defaults to 8 kHz mu-law in the
    existing code and Pipecat's pipeline runs at 16/24 kHz. Nothing may be
    assumed equal.
    """

    sample_rate: int
    channels: int = 1
    encoding: str = "pcm_s16le"

    def __post_init__(self) -> None:
        if self.sample_rate < 1:
            raise ValueError(f"sample_rate must be >= 1, got {self.sample_rate}")
        if self.channels < 1:
            raise ValueError(f"channels must be >= 1, got {self.channels}")

    def describe(self) -> str:
        return f"{self.encoding}/{self.sample_rate}Hz/{self.channels}ch"

    def matches(self, other: "AudioFormat") -> bool:
        return (
            self.sample_rate == other.sample_rate
            and self.channels == other.channels
            and self.encoding == other.encoding
        )


#: Telegram 1:1 calls negotiate 48 kHz mono Opus. Kept as a named constant so
#: the PHP side and the docs refer to the same number.
TELEGRAM_CALL_FORMAT = AudioFormat(sample_rate=48000, channels=1, encoding="ogg_opus")

#: Twilio Media Streams are 8 kHz mono mu-law. Not the same as Telegram above.
TWILIO_CALL_FORMAT = AudioFormat(sample_rate=8000, channels=1, encoding="mulaw")

#: What the ACAF bridge carries by default: Pipecat-native, so the Python side
#: needs no Opus codec at all.
BRIDGE_FORMAT = AudioFormat(sample_rate=16000, channels=1, encoding="pcm_s16le")
