"""Plain data types shared by signaling, media and the call manager."""
from __future__ import annotations

import enum
from dataclasses import dataclass, field


class CallState(str, enum.Enum):
    IDLE = "idle"
    RINGING_IN = "ringing_in"          # incoming request reserved, not yet accepted
    REQUESTING = "requesting"          # outgoing: preparing / sending requestCall
    RINGING_OUT = "ringing_out"        # outgoing: waiting for the callee to accept
    EXCHANGING_KEYS = "exchanging_keys"
    CONNECTING = "connecting"          # DH done, waiting for media CONNECTED
    ACTIVE = "active"                  # media connected, audio bridge running
    ENDING = "ending"


class Direction(str, enum.Enum):
    INCOMING = "incoming"
    OUTGOING = "outgoing"


class MediaState(str, enum.Enum):
    CONNECTING = "CONNECTING"
    CONNECTED = "CONNECTED"
    FAILED = "FAILED"
    TIMEOUT = "TIMEOUT"
    CLOSED = "CLOSED"


@dataclass(frozen=True)
class CallProtocol:
    """What *we offer* in phone.requestCall / acceptCall / confirmCall."""
    min_layer: int
    max_layer: int
    udp_p2p: bool
    udp_reflector: bool
    library_versions: tuple[str, ...]


@dataclass(frozen=True)
class DhParams:
    """messages.getDhConfig result."""
    g: int
    p: bytes
    random: bytes


@dataclass(frozen=True)
class AuthParams:
    """Result of the local half of the key exchange."""
    g_a_or_b: bytes
    key_fingerprint: int


@dataclass(frozen=True)
class RelayConnection:
    """Telegram relay/reflector description (phoneConnection[Webrtc])."""
    id: int
    ip: str
    ipv6: str
    port: int
    username: str | None = None
    password: str | None = None
    turn: bool = False
    stun: bool = False
    tcp: bool = False
    peer_tag: bytes | None = None
    webrtc: bool = False


@dataclass(frozen=True)
class IncomingRequest:
    """An inbound private call (phoneCallRequested)."""
    call_id: int
    access_hash: int
    caller_id: int
    g_a_hash: bytes
    video: bool = False


@dataclass(frozen=True)
class Established:
    """The call as confirmed by Telegram (phoneCall / confirmCall result)."""
    g_a_or_b: bytes
    key_fingerprint: int
    connections: tuple[RelayConnection, ...]
    library_versions: tuple[str, ...]
    p2p_allowed: bool


@dataclass(frozen=True)
class ResolvedUser:
    user_id: int
    handle: object = field(default=None, compare=False, repr=False)


@dataclass(frozen=True)
class CallInfo:
    call_id: int
    peer_id: int
    direction: Direction
    library_versions: tuple[str, ...] = ()


@dataclass(frozen=True)
class CallEnd:
    reason: str
    direction: Direction | None = None
    call_id: int | None = None
    peer_id: int | None = None
    detail: str | None = None
