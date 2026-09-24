"""Audio Call Assistant Frame protocol (ACAF v1).

The wire format used between the Telegram/MadelineProto side (PHP, in
`multipurps/mp-relay`) and this Pipecat service. Deliberately Pipecat-agnostic
and Telegram-agnostic: it carries normalized audio frames plus a small set of
JSON control messages, and nothing else.

Why a custom binary frame instead of, say, protobuf or just JSON+base64:
  * base64 costs 33% bandwidth on a link that runs for the whole call;
  * Pipecat's own serializer interface is `bytes | str`, so a binary frame
    drops straight into `FrameSerializer.serialize` with no extra hop;
  * the header is fixed-width and self-describing, so a receiver can resync
    on the magic bytes after a corrupt frame instead of losing the stream.

Everything here is pure Python + the standard library, so the protocol can be
unit-tested without Pipecat, FastAPI, or any provider key installed.

Interface contract (see docs/AI-VOICE-ASSISTANT-REPORT.md section 6):

    offset  size  field
    0       4     magic 'ACAF'
    4       1     version (=1)
    5       1     type        (1=audio.in 2=audio.out 3=partial 4=interrupt ...)
    6       1     encoding    (1=pcm_s16le 2=mulaw 3=ogg_opus)
    7       1     channels
    8       4     sample_rate  uint32 LE
    12      4     sequence     uint32 LE
    16      8     timestamp_ms uint64 LE
    24      4     payload_len  uint32 LE
    28      N     payload

`sessionId` is carried once in the JSON `hello` handshake rather than in every
audio frame, which is what keeps per-frame overhead at 28 bytes.
"""

from __future__ import annotations

import struct
from dataclasses import dataclass, field
from enum import IntEnum
from typing import Any

MAGIC = b"ACAF"
VERSION = 1
HEADER_SIZE = 28
# Header struct: 4s B B B B I I Q I  -> 4+1+1+1+1+4+4+8+4 = 28
_HEADER = struct.Struct("<4sBBBBIIQI")

#: Refuse absurd payloads rather than allocating them. 64 KiB is far above the
#: largest frame anything here produces (a 20 ms 48 kHz stereo PCM16 frame is
#: 3.8 KiB); it exists to bound a hostile or desynced peer.
MAX_PAYLOAD_BYTES = 64 * 1024


class FrameType(IntEnum):
    """Binary frame types."""

    AUDIO_IN = 1  # peer -> assistant (caller speech)
    AUDIO_OUT = 2  # assistant -> peer (assistant speech)
    PARTIAL_TRANSCRIPT = 3  # STT partial result, for UI/barge-in feedback
    INTERRUPT = 4  # peer detected speech: stop TTS and drop queued audio
    HEARTBEAT = 5  # liveness ping on the audio plane


class Encoding(IntEnum):
    """Audio encodings that may appear in a frame's `encoding` byte.

    The bridge default is PCM_S16LE: it is Pipecat's native format, so the
    Python side never needs an Opus codec, and it is trivial to produce in PHP.
    OGG_OPUS exists for the case where the Telegram side would rather hand over
    already-encoded Telegram-native audio and swallow the decode cost itself.
    """

    PCM_S16LE = 1
    MULAW = 2
    OGG_OPUS = 3


ENCODING_BYTES_PER_SAMPLE: dict[Encoding, int] = {
    Encoding.PCM_S16LE: 2,
    Encoding.MULAW: 1,
    # OGG Opus is a container, not raw samples -- frame size is not derivable.
    Encoding.OGG_OPUS: 0,
}


class ProtocolError(ValueError):
    """Raised when a datagram cannot be parsed as an ACAF frame."""


@dataclass(slots=True)
class AudioFrame:
    """One binary ACAF frame: a header plus its payload."""

    type: FrameType
    encoding: Encoding
    channels: int
    sample_rate: int
    sequence: int
    timestamp_ms: int
    payload: bytes = b""
    version: int = VERSION

    def __post_init__(self) -> None:
        if self.channels < 1:
            raise ProtocolError(f"channels must be >= 1, got {self.channels}")
        if self.sample_rate < 1:
            raise ProtocolError(f"sample_rate must be >= 1, got {self.sample_rate}")
        if self.sequence < 0 or self.sequence > 0xFFFFFFFF:
            raise ProtocolError(f"sequence out of uint32 range: {self.sequence}")
        if len(self.payload) > MAX_PAYLOAD_BYTES:
            raise ProtocolError(
                f"payload {len(self.payload)} exceeds MAX_PAYLOAD_BYTES {MAX_PAYLOAD_BYTES}"
            )

    @property
    def bytes_per_sample(self) -> int:
        return ENCODING_BYTES_PER_SAMPLE[self.encoding]

    @property
    def frame_duration_ms(self) -> float | None:
        """Duration of this frame in ms, or None for container formats."""
        bps = self.bytes_per_sample
        if bps == 0:
            return None
        total_samples = len(self.payload) // (bps * self.channels)
        return (total_samples / self.sample_rate) * 1000.0

    def encode(self) -> bytes:
        """Serialize to bytes ready for the wire."""
        payload_len = len(self.payload)
        if payload_len > MAX_PAYLOAD_BYTES:
            raise ProtocolError(
                f"payload {payload_len} exceeds MAX_PAYLOAD_BYTES {MAX_PAYLOAD_BYTES}"
            )
        header = _HEADER.pack(
            MAGIC,
            self.version,
            int(self.type),
            int(self.encoding),
            self.channels,
            self.sample_rate,
            self.sequence,
            self.timestamp_ms,
            payload_len,
        )
        return header + self.payload

    @classmethod
    def decode(cls, data: bytes) -> "AudioFrame":
        """Parse one complete ACAF frame.

        Raises ProtocolError on anything that is not a well-formed frame, so
        the caller can log-and-drop rather than propagating a malformed packet
        into the Pipecat pipeline.
        """
        if len(data) < HEADER_SIZE:
            raise ProtocolError(
                f"datagram shorter than header: {len(data)} < {HEADER_SIZE}"
            )
        magic, version, ftype, encoding, channels, rate, seq, ts, payload_len = (
            _HEADER.unpack_from(data, 0)
        )
        if magic != MAGIC:
            raise ProtocolError(f"bad magic {magic!r}, expected {MAGIC!r}")
        if version != VERSION:
            raise ProtocolError(f"unsupported protocol version {version}")
        if payload_len > MAX_PAYLOAD_BYTES:
            raise ProtocolError(
                f"declared payload {payload_len} exceeds MAX_PAYLOAD_BYTES {MAX_PAYLOAD_BYTES}"
            )
        if len(data) < HEADER_SIZE + payload_len:
            raise ProtocolError(
                f"truncated frame: have {len(data) - HEADER_SIZE} payload bytes, "
                f"header declares {payload_len}"
            )
        try:
            frame_type = FrameType(ftype)
        except ValueError as exc:
            raise ProtocolError(f"unknown frame type {ftype}") from exc
        try:
            enc = Encoding(encoding)
        except ValueError as exc:
            raise ProtocolError(f"unknown encoding {encoding}") from exc
        if channels < 1:
            raise ProtocolError(f"channels must be >= 1, got {channels}")

        payload = bytes(data[HEADER_SIZE : HEADER_SIZE + payload_len])
        return cls(
            type=frame_type,
            encoding=enc,
            channels=channels,
            sample_rate=rate,
            sequence=seq,
            timestamp_ms=ts,
            payload=payload,
            version=version,
        )

    @classmethod
    def audio_in(
        cls,
        payload: bytes,
        *,
        sequence: int,
        timestamp_ms: int,
        sample_rate: int,
        channels: int = 1,
        encoding: Encoding = Encoding.PCM_S16LE,
    ) -> "AudioFrame":
        return cls(
            type=FrameType.AUDIO_IN,
            encoding=encoding,
            channels=channels,
            sample_rate=sample_rate,
            sequence=sequence,
            timestamp_ms=timestamp_ms,
            payload=payload,
        )

    @classmethod
    def audio_out(
        cls,
        payload: bytes,
        *,
        sequence: int,
        timestamp_ms: int,
        sample_rate: int,
        channels: int = 1,
        encoding: Encoding = Encoding.PCM_S16LE,
    ) -> "AudioFrame":
        return cls(
            type=FrameType.AUDIO_OUT,
            encoding=encoding,
            channels=channels,
            sample_rate=sample_rate,
            sequence=sequence,
            timestamp_ms=timestamp_ms,
            payload=payload,
        )


# --------------------------------------------------------------------------
# Control plane (JSON text frames)
# --------------------------------------------------------------------------

#: Control message types. Kept as plain strings so the PHP side needs no enum
#: mapping and so an unknown type is a log line, not a parse failure.
CONTROL_HELLO = "hello"
CONTROL_READY = "ready"
CONTROL_INTERRUPT = "interrupt"
CONTROL_HANGUP = "hangup"
CONTROL_PING = "ping"
CONTROL_PONG = "pong"
CONTROL_ERROR = "error"
CONTROL_STOPPED = "stopped"
CONTROL_METRICS = "metrics"

#: Control messages that carry no secrets and are safe to log verbatim.
#: `hello` and `error` are excluded from automatic logging because `hello`
#: carries the peer's session token and `error` may embed upstream detail.
LOGGABLE_CONTROL_TYPES = frozenset(
    {CONTROL_READY, CONTROL_INTERRUPT, CONTROL_HANGUP, CONTROL_PING, CONTROL_PONG, CONTROL_STOPPED}
)


@dataclass(slots=True)
class ControlMessage:
    """A JSON control-plane message."""

    type: str
    session_id: str | None = None
    extra: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        body: dict[str, Any] = {"type": self.type}
        if self.session_id is not None:
            body["sessionId"] = self.session_id
        body.update(self.extra)
        return body

    def to_json(self) -> str:
        """Serialize for the wire.

        `separators` is compacted because these are sent on a live audio
        socket where whitespace is pure overhead, and `default=str` stops an
        exotic value from raising at the exact moment something is already
        going wrong.
        """
        import json

        return json.dumps(self.to_dict(), separators=(",", ":"), default=str)

    @classmethod
    def from_dict(cls, body: dict[str, Any]) -> "ControlMessage":
        if not isinstance(body, dict):
            raise ProtocolError("control message must be a JSON object")
        msg_type = body.get("type")
        if not isinstance(msg_type, str) or not msg_type:
            raise ProtocolError("control message missing string 'type'")
        extra = {
            k: v
            for k, v in body.items()
            if k not in ("type", "sessionId")
        }
        session_id = body.get("sessionId")
        return cls(
            type=msg_type,
            session_id=session_id if isinstance(session_id, str) else None,
            extra=extra,
        )


# --------------------------------------------------------------------------
# Sequence tracking
# --------------------------------------------------------------------------


@dataclass(slots=True)
class SequenceTracker:
    """Detects gaps and reordering in one direction's frame stream.

    The brief requires explicit handling of "frame ordering and missing
    frames". Audio frames cannot be usefully retransmitted -- by the time a
    gap is noticed the audio is stale -- so the contract is: count it, expose
    it for metrics, and keep going. A gap is never fatal.
    """

    last_sequence: int | None = None
    received: int = 0
    missing: int = 0
    reordered: int = 0
    duplicates: int = 0

    def observe(self, sequence: int) -> int:
        """Record a sequence number; return how many frames were skipped.

        Returns 0 for in-order, duplicate, and reordered arrivals. A duplicate
        or a backwards step is counted separately from a forward gap because
        the two mean different things: a gap is packet loss, a backwards step
        is a stalled/duplicating sender.
        """
        self.received += 1

        if self.last_sequence is None:
            self.last_sequence = sequence
            return 0

        delta = (sequence - self.last_sequence) & 0xFFFFFFFF
        if delta == 0:
            self.duplicates += 1
            return 0
        if delta >= 0x80000000:
            # Sequence went backwards inside the uint32 window: reordered or
            # replayed, not a forward gap.
            self.reordered += 1
            return 0
        if delta == 1:
            self.last_sequence = sequence
            return 0

        # Forward gap. uint32 wraparound is handled naturally by the mask.
        skipped = delta - 1
        self.missing += skipped
        self.last_sequence = sequence
        return skipped

    @property
    def loss_ratio(self) -> float:
        total = self.received + self.missing
        return (self.missing / total) if total else 0.0

    def as_metrics(self) -> dict[str, Any]:
        return {
            "received": self.received,
            "missing": self.missing,
            "reordered": self.reordered,
            "duplicates": self.duplicates,
            "lossRatio": round(self.loss_ratio, 4),
        }

    def reset(self) -> None:
        self.last_sequence = None
        self.received = 0
        self.missing = 0
        self.reordered = 0
        self.duplicates = 0
