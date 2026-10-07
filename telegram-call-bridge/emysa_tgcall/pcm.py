"""Raw PCM helpers.

The Telegram side of the bridge is **48 kHz, mono, signed 16-bit little-endian**,
delivered/accepted in **10 ms frames (480 samples = 960 bytes)**. This is the
format NTgCalls' EXTERNAL audio source/sink uses (verified in tests against
the real ntgcalls wheel: every received frame is exactly 960 bytes).

Everything here is pure Python (no numpy) so the bridge has no heavy deps.
"""
from __future__ import annotations

import math
import sys
import threading
from array import array
from typing import Iterable, Sequence

SAMPLE_RATE = 48_000
CHANNELS = 1
SAMPLE_WIDTH = 2                       # bytes, s16le
FRAME_MS = 10
FRAME_SAMPLES = SAMPLE_RATE * FRAME_MS // 1000        # 480
FRAME_BYTES = FRAME_SAMPLES * SAMPLE_WIDTH * CHANNELS  # 960
BYTES_PER_SECOND = SAMPLE_RATE * SAMPLE_WIDTH * CHANNELS

# Deterministic signals used by the loopback/echo tests.
KNOWN_SEQUENCE_HZ: tuple[int, ...] = (500, 700, 900)   # what the "agent" plays back
PROBE_HZ = 300                                          # what the "caller" sends


def _samples(pcm: bytes) -> array:
    a = array("h")
    a.frombytes(pcm[: len(pcm) // 2 * 2])
    if sys.byteorder == "big":  # pragma: no cover - PCM is little-endian
        a.byteswap()
    return a


def _to_bytes(a: array) -> bytes:
    if sys.byteorder == "big":  # pragma: no cover
        a = array("h", a)
        a.byteswap()
    return a.tobytes()


def ms_to_bytes(ms: float) -> int:
    """Duration -> byte count, rounded down to a whole sample."""
    return int(SAMPLE_RATE * ms / 1000) * SAMPLE_WIDTH


def bytes_to_ms(n: int) -> float:
    return n * 1000.0 / BYTES_PER_SECOND


SILENCE_FRAME = bytes(FRAME_BYTES)


def silence(ms: float) -> bytes:
    return bytes(ms_to_bytes(ms))


def tone(freq_hz: float, ms: float, amplitude: float = 0.4, start_sample: int = 0) -> bytes:
    """Sine tone. ``amplitude`` is 0..1 of full scale."""
    n = ms_to_bytes(ms) // 2
    peak = int(32767 * max(0.0, min(1.0, amplitude)))
    w = 2.0 * math.pi * freq_hz / SAMPLE_RATE
    return _to_bytes(array("h", (int(peak * math.sin(w * (start_sample + i))) for i in range(n))))


def known_test_signal(tone_ms: int = 400, gap_ms: int = 100) -> bytes:
    """The fixed 'agent reply' used in tests: 500 Hz, 700 Hz, 900 Hz bursts,
    each separated by a short silence. Always the same bytes."""
    parts: list[bytes] = []
    for hz in KNOWN_SEQUENCE_HZ:
        parts.append(tone(hz, tone_ms))
        parts.append(silence(gap_ms))
    return b"".join(parts)


def rms(pcm: bytes) -> float:
    a = _samples(pcm)
    if not a:
        return 0.0
    return math.sqrt(sum(s * s for s in a) / len(a))


def goertzel_power(pcm: bytes, freq_hz: float) -> float:
    """Normalised signal power at ``freq_hz`` (amplitude^2 scale, 0..~1)."""
    a = _samples(pcm)
    n = len(a)
    if n == 0:
        return 0.0
    w = 2.0 * math.pi * freq_hz / SAMPLE_RATE
    coeff = 2.0 * math.cos(w)
    s_prev = s_prev2 = 0.0
    for x in a:
        s = x + coeff * s_prev - s_prev2
        s_prev2, s_prev = s_prev, s
    power = s_prev2 * s_prev2 + s_prev * s_prev - coeff * s_prev * s_prev2
    # scale so a full-scale sine at freq gives ~0.25..1 independent of length
    return power / (n * n * 32768.0 * 32768.0) * 4.0


def dominant_frequency(pcm: bytes, candidates: Iterable[float], min_power: float = 1e-3) -> float | None:
    """Which candidate frequency dominates ``pcm``? None if all are below
    ``min_power`` (i.e. silence / noise)."""
    best, best_p = None, min_power
    for f in candidates:
        p = goertzel_power(pcm, f)
        if p > best_p:
            best, best_p = f, p
    return best


def detect_sequence(pcm: bytes, candidates: Sequence[float], window_ms: int = 50,
                    min_power: float = 1e-3) -> list[float]:
    """Return the de-duplicated order in which candidate tones appear."""
    step = ms_to_bytes(window_ms)
    seen: list[float] = []
    for off in range(0, len(pcm) - step + 1, step):
        f = dominant_frequency(pcm[off: off + step], candidates, min_power)
        if f is not None and (not seen or seen[-1] != f):
            seen.append(f)
    return seen


class FrameChunker:
    """Re-slices an arbitrary byte stream into fixed 960-byte frames."""

    def __init__(self, frame_bytes: int = FRAME_BYTES):
        self._n = frame_bytes
        self._buf = bytearray()

    def push(self, data: bytes) -> list[bytes]:
        self._buf.extend(data)
        out: list[bytes] = []
        while len(self._buf) >= self._n:
            out.append(bytes(self._buf[: self._n]))
            del self._buf[: self._n]
        return out

    @property
    def pending(self) -> int:
        return len(self._buf)

    def flush(self, pad: bool = True) -> list[bytes]:
        if not self._buf:
            return []
        rest = bytes(self._buf)
        self._buf.clear()
        return [rest + bytes(self._n - len(rest))] if pad else []


class JitterBuffer:
    """Bounded byte FIFO, safe for one producer + one consumer on different
    threads. Caps latency by dropping the *oldest* audio on overflow and pads
    with silence on underrun."""

    def __init__(self, max_bytes: int):
        self._buf = bytearray()
        self._lock = threading.Lock()
        self._max = max(0, max_bytes)
        self.pushed = self.pulled = self.underruns = self.dropped = 0

    def __len__(self) -> int:
        with self._lock:
            return len(self._buf)

    def push(self, data: bytes) -> None:
        if not data:
            return
        with self._lock:
            self._buf.extend(data)
            self.pushed += len(data)
            over = len(self._buf) - self._max
            if self._max and over > 0:
                del self._buf[:over]
                self.dropped += over

    def pull(self, n: int) -> bytes:
        with self._lock:
            have = len(self._buf)
            if have >= n:
                out = bytes(self._buf[:n])
                del self._buf[:n]
                self.pulled += n
                return out
            out = bytes(self._buf) + bytes(n - have)
            self._buf.clear()
            self.underruns += 1
            self.pulled += have
            return out

    def pull_available(self, n: int) -> bytes | None:
        """Exactly ``n`` bytes, or None when fewer are buffered (no padding)."""
        with self._lock:
            if len(self._buf) < n:
                return None
            out = bytes(self._buf[:n])
            del self._buf[:n]
            self.pulled += n
            return out

    def clear(self) -> int:
        with self._lock:
            n = len(self._buf)
            self._buf.clear()
            return n
