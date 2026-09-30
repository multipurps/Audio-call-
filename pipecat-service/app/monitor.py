"""Live call monitoring for the authenticated app user.

The browser never touches the carrier's media path: WaCalls/mp-relay carry the
call audio over ACAF to this service, and this module fans a *copy* of both
directions out to whoever the app says may listen:

  * ``in``  — what the person on the call says (inbound caller audio),
  * ``out`` — what Emysa says to them (outbound TTS audio, post-pacing, i.e.
    exactly what the recipient is hearing at that moment).

Design constraints, all of which come from the brief:

  * **Real audio, not a visual fake.** Subscribers receive raw PCM16 frames
    with a direction byte; the app plays them. Nothing is synthesised here.
  * **Monitoring can never touch the call.** Publishing is a read-only fan-out
    from the pipeline's perspective; a slow or dead monitor drops frames
    (bounded queue, oldest first) instead of back-pressuring the call, and a
    muted/closed monitor changes nothing about what the recipient hears.
  * **No leakage between calls.** Each session id is its own room; a
    subscriber for one call can never observe another. When the call ends the
    room is closed and its subscribers are told.
  * **Authenticated.** ``/monitor/{session_id}`` requires a short-lived HMAC
    token minted by the app's own API (which shares ``ASSISTANT_BRIDGE_SECRET``
    with this service). The browser never holds the bridge secret.

Token format: ``{exp}.{user_id}.{sig}`` where ``sig = HMAC-SHA256(secret,
"monitor:{session_id}:{user_id}:{exp}")`` hex. Self-describing (so the
monitor route can verify without a user lookup), constant-time compared,
bounded lifetime, and bound to one session id — a leaked token from one call
cannot listen to another. User ids are UUIDs and never contain ``.``.
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import hmac
import struct
import time
from typing import Any

from loguru import logger

#: Binary monitor frame: 1 byte direction + 4 bytes LE sample rate + PCM16LE.
DIRECTION_CALLER = 1
DIRECTION_EMYSA = 2
_FRAME_PREFIX = struct.Struct("<BI")

#: Default/maximum token lifetime. Short: a monitor token is only needed for
#: the length of one call, and the app mints a fresh one per listen.
DEFAULT_TOKEN_TTL_SECS = 6 * 3600
MAX_TOKEN_TTL_SECS = 12 * 3600
#: Tolerated clock skew between the minting host (Vercel) and this one (Render).
TOKEN_SKEW_SECS = 60.0

#: Subscribers allowed per live call. Two: the user's phone and, say, a
#: desktop. More than that is a bug or an abuse.
MAX_SUBSCRIBERS_PER_SESSION = 2

#: How many monitor frames may queue per subscriber before the oldest are
#: dropped. ~3 s of 20 ms frames. A monitor is a live feed: late audio is
#: worthless, so the queue sheds rather than grows.
SUBSCRIBER_QUEUE_MAX_FRAMES = 150


class TokenError(ValueError):
    """Raised when a monitor token is missing, malformed, expired or forged."""


def sign_monitor_token(
    secret: str,
    *,
    session_id: str,
    user_id: str,
    expires_at: int | None = None,
    ttl_secs: float = DEFAULT_TOKEN_TTL_SECS,
) -> str:
    """Mint a monitor token for one session/user pair (server side).

    Shape: ``{exp}.{user_id}.{sig}``.
    """
    if not secret:
        raise TokenError("monitor token secret is not configured")
    if not session_id or not user_id:
        raise TokenError("session_id and user_id are required")
    if "." in user_id:
        raise TokenError("user_id must not contain '.'")
    exp = int(expires_at if expires_at is not None else time.time() + ttl_secs)
    exp = min(exp, int(time.time() + MAX_TOKEN_TTL_SECS))
    message = f"monitor:{session_id}:{user_id}:{exp}".encode()
    sig = hmac.new(secret.encode(), message, hashlib.sha256).hexdigest()
    return f"{exp}.{user_id}.{sig}"


def verify_monitor_token(secret: str, token: str, *, session_id: str) -> str:
    """Validate a token for ``session_id``. Returns the token's user id.

    Raises :class:`TokenError` with a reason safe to log (never echoes the
    token) on any failure.
    """
    if not secret:
        raise TokenError("monitor tokens are not configured")
    parts = (token or "").split(".")
    if len(parts) != 3:
        raise TokenError("malformed token")
    exp_str, user_id, sig = parts
    try:
        exp = int(exp_str)
    except ValueError as exc:
        raise TokenError("malformed token expiry") from exc
    now = time.time()
    if exp < now - TOKEN_SKEW_SECS:
        raise TokenError("token expired")
    if exp > now + MAX_TOKEN_TTL_SECS + TOKEN_SKEW_SECS:
        raise TokenError("token expiry out of range")
    if not user_id or not sig:
        raise TokenError("malformed token")
    message = f"monitor:{session_id}:{user_id}:{exp}".encode()
    expected = hmac.new(secret.encode(), message, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, sig):
        raise TokenError("signature mismatch")
    return user_id


def pack_monitor_frame(direction: int, sample_rate: int, pcm: bytes) -> bytes:
    return _FRAME_PREFIX.pack(direction, sample_rate) + pcm


class MonitorSubscriber:
    """One listening client. Bounded queue; drops oldest frames when slow."""

    def __init__(self, session_id: str, *, max_frames: int = SUBSCRIBER_QUEUE_MAX_FRAMES) -> None:
        self.session_id = session_id
        self._queue: asyncio.Queue[bytes | None] = asyncio.Queue()
        self._max_frames = max_frames
        self.frames_sent = 0
        self.frames_dropped = 0
        self.closed = False

    def offer(self, frame: bytes) -> None:
        if self.closed:
            return
        if self._queue.qsize() >= self._max_frames:
            with contextlib.suppress(asyncio.QueueEmpty):
                self._queue.get_nowait()
            self.frames_dropped += 1
        self._queue.put_nowait(frame)

    async def get(self) -> bytes | None:
        """Next frame, or None when the subscriber should stop."""
        if self.closed and self._queue.empty():
            return None
        item = await self._queue.get()
        if item is not None:
            self.frames_sent += 1
        return item

    def close(self) -> None:
        if self.closed:
            return
        self.closed = True
        with contextlib.suppress(asyncio.QueueEmpty):
            self._queue.put_nowait(None)


class MonitorHub:
    """In-process fan-out of monitor audio, keyed by bridge session id."""

    def __init__(self, *, max_subscribers: int = MAX_SUBSCRIBERS_PER_SESSION) -> None:
        self._rooms: dict[str, set[MonitorSubscriber]] = {}
        self._max_subscribers = max_subscribers
        self.total_published = 0

    def subscriber_count(self, session_id: str) -> int:
        return len(self._rooms.get(session_id, ()))

    def subscribe(self, session_id: str) -> MonitorSubscriber | None:
        """Attach a listener. None when the room is full (abuse guard)."""
        room = self._rooms.setdefault(session_id, set())
        # Reap dead subscribers so a browser tab that vanished without a
        # close frame cannot hold a slot forever.
        for sub in list(room):
            if sub.closed:
                room.discard(sub)
        if len(room) >= self._max_subscribers:
            return None
        sub = MonitorSubscriber(session_id)
        room.add(sub)
        logger.info(
            "monitor subscriber attached",
            extra={"sessionId": session_id, "subscribers": len(room)},
        )
        return sub

    def unsubscribe(self, session_id: str, sub: MonitorSubscriber) -> None:
        room = self._rooms.get(session_id)
        if not room:
            return
        room.discard(sub)
        sub.close()
        if not room:
            self._rooms.pop(session_id, None)

    def publish(self, session_id: str, direction: int, sample_rate: int, pcm: bytes) -> None:
        """Fan one PCM chunk out to the session's listeners. Never raises."""
        room = self._rooms.get(session_id)
        if not room or not pcm:
            return
        frame = pack_monitor_frame(direction, sample_rate, pcm)
        self.total_published += 1
        for sub in list(room):
            sub.offer(frame)

    def close_room(self, session_id: str) -> None:
        """The call ended: tell listeners and release the room."""
        room = self._rooms.pop(session_id, None)
        if not room:
            return
        for sub in room:
            sub.close()
        logger.info(
            "monitor room closed",
            extra={"sessionId": session_id, "subscribers": len(room)},
        )


#: Process-wide hub. The bridge conversation and the /monitor websocket route
#: both reach it; sessions are tied to this process's sockets, same reasoning
#: as SessionRegistry.
_HUB = MonitorHub()


def get_hub() -> MonitorHub:
    return _HUB


def reset_hub() -> MonitorHub:
    """Fresh hub for tests."""
    global _HUB
    _HUB = MonitorHub()
    return _HUB


async def run_monitor_socket(websocket: Any, *, hub: MonitorHub, session_id: str) -> dict[str, Any]:
    """Serve one monitor subscriber until the call ends or the socket drops.

    The websocket must already be authenticated and accepted. Returns stats
    for logging; never raises for a normal disconnect.
    """
    stats = {"frames": 0, "dropped": 0}
    sub = hub.subscribe(session_id)
    if sub is None:
        with contextlib.suppress(Exception):
            await websocket.send_json({"type": "error", "reason": "too-many-listeners"})
            await websocket.close(code=1008)
        return stats

    pump = asyncio.create_task(_pump(websocket, sub, stats), name=f"monitor-pump-{session_id}")
    reader = asyncio.create_task(_read(websocket), name=f"monitor-read-{session_id}")
    try:
        await asyncio.wait(
            {pump, reader}, return_when=asyncio.FIRST_COMPLETED, timeout=24 * 3600
        )
    finally:
        for task in (pump, reader):
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await task
        hub.unsubscribe(session_id, sub)
        stats["dropped"] = sub.frames_dropped
    return stats


async def _pump(websocket: Any, sub: MonitorSubscriber, stats: dict[str, Any]) -> None:
    while True:
        frame = await sub.get()
        if frame is None:
            # Room closed (call ended) or subscriber torn down.
            with contextlib.suppress(Exception):
                await websocket.send_json({"type": "ended"})
                await websocket.close(code=1000)
            return
        await websocket.send_bytes(frame)
        stats["frames"] += 1


async def _read(websocket: Any) -> None:
    """Drain client messages (ping / close). Ends when the socket drops."""
    while True:
        message = await websocket.receive()
        if message.get("type") == "websocket.disconnect":
            return
