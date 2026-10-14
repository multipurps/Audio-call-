"""Browser entry point for the in-app Emysa call.

The in-app call used to be turn based (record, transcribe, text model, text to
speech). It now runs the SAME conversation a WhatsApp call runs: GPT-Live
speech to speech with the mic open for the whole call, unless the user chose
their cloned voice (then the classic engine with the clone, decided by
``CallConversation._resolve_call_voice_and_engine`` from the user's saved
choice - this module never picks an engine or a voice).

To reuse that conversation unchanged, the browser's websocket is wrapped in
:class:`BrowserAcafSocket`, which presents the ACAF peer that
``AcafBridge`` expects:

  browser -> service   binary: raw PCM16 mono at 16 kHz  (wrapped as AUDIO_IN)
                       text:   {"type":"hangup"} | {"type":"interrupt"} | ping
  service -> browser   binary: raw PCM16 mono at the bridge rate (AUDIO_OUT)
                       text:   ready / interrupt / hangup / error / ended

Auth is a short-lived HMAC token minted by the app's API with the shared bridge
secret (the browser never holds the secret):
    token = ``{exp}.{user_id}.{sig}``,
    sig   = HMAC-SHA256(secret, "appcall:{session_id}:{user_id}:{exp}") hex.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import time
from typing import Any

from loguru import logger

from app.monitor import get_hub
from app.protocol import (
    CONTROL_CALL_ACTIVE,
    CONTROL_HANGUP,
    CONTROL_HELLO,
    CONTROL_INTERRUPT,
    CONTROL_PING,
    AudioFrame,
    FrameType,
)

BROWSER_SAMPLE_RATE = 16000
#: Mic audio that waited longer than this before the bridge read it is dropped. The
#: bridge starts reading only after the conversation has started (context lookup,
#: voice choice, pipeline build: ~2.5 s warm, ~10 s on a cold instance), while the
#: browser streams the mic from the moment the socket opens. Without this the first
#: read returned that whole backlog in one burst (730 frames, ~15 s of audio, in the
#: first 5 s window of a measured cold call) and the opening line queued behind it.
STALE_UPLINK_SECS = 1.0
MAX_APP_CALL_TOKEN_TTL_SECS = 2 * 3600
TOKEN_SKEW_SECS = 60.0

#: Control messages from the service that the browser acts on.
_FORWARDED_CONTROLS = frozenset({"ready", "interrupt", "hangup", "error", "stopped"})


class AppCallTokenError(ValueError):
    """Missing, malformed, expired or forged in-app call token."""


def sign_app_call_token(
    secret: str, *, session_id: str, user_id: str, ttl_secs: float = 600, expires_at: int | None = None
) -> str:
    if not secret:
        raise AppCallTokenError("app call secret is not configured")
    if not session_id or not user_id or "." in user_id:
        raise AppCallTokenError("invalid session or user id")
    exp = int(expires_at if expires_at is not None else time.time() + ttl_secs)
    sig = hmac.new(secret.encode(), f"appcall:{session_id}:{user_id}:{exp}".encode(), hashlib.sha256).hexdigest()
    return f"{exp}.{user_id}.{sig}"


def verify_app_call_token(secret: str, token: str, *, session_id: str, prefix: str = "appcall") -> str:
    """Return the token's user id, or raise :class:`AppCallTokenError`."""
    if not secret:
        raise AppCallTokenError("app calls are not configured")
    parts = (token or "").split(".")
    if len(parts) != 3:
        raise AppCallTokenError("malformed token")
    exp_str, user_id, sig = parts
    try:
        exp = int(exp_str)
    except ValueError as exc:
        raise AppCallTokenError("malformed token expiry") from exc
    now = time.time()
    if exp < now - TOKEN_SKEW_SECS:
        raise AppCallTokenError("token expired")
    if exp > now + MAX_APP_CALL_TOKEN_TTL_SECS + TOKEN_SKEW_SECS:
        raise AppCallTokenError("token expiry out of range")
    if not user_id or not sig:
        raise AppCallTokenError("malformed token")
    expected = hmac.new(secret.encode(), f"{prefix}:{session_id}:{user_id}:{exp}".encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, sig):
        raise AppCallTokenError("signature mismatch")
    return user_id


def verify_any_app_call_token(secret: str, token: str, *, session_id: str) -> tuple[str, bool]:
    """(user id, is_trainer). A trainer token is signed under its own prefix, so a normal
    user token can never be presented as one."""
    try:
        return verify_app_call_token(secret, token, session_id=session_id), False
    except AppCallTokenError as exc:
        if str(exc) != "signature mismatch":
            raise
    return verify_app_call_token(secret, token, session_id=session_id, prefix="trainercall"), True


class BrowserAcafSocket:
    """Presents a browser websocket to ``AcafBridge`` as an ACAF peer."""

    def __init__(self, websocket: Any, *, secret: str, session_id: str, user_id: str) -> None:
        self._ws = websocket
        self._hello = json.dumps(
            {
                "type": CONTROL_HELLO,
                "sessionId": session_id,
                "secret": secret,
                "platform": "app",
                "userId": user_id,
                "sampleRate": BROWSER_SAMPLE_RATE,
                "channels": 1,
                "encoding": "pcm_s16le",
            }
        )
        self._seq = 0
        self._t0 = time.monotonic()
        self._call_active_sent = False
        self._pending: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
        # Everything the browser sends is read here as soon as the socket is up, stamped,
        # and handed to the bridge on request, so audio that went stale while the call
        # was starting can be discarded instead of replayed (see STALE_UPLINK_SECS).
        self._inbox: asyncio.Queue[tuple[float, dict[str, Any]]] = asyncio.Queue()
        self._pump_task: asyncio.Task[None] | None = None
        self._stale_frames = 0
        self._stale_bytes = 0
        self._session_id = session_id
        self._transcript_sub: Any = None
        self._transcript_task: asyncio.Task[None] | None = None

    def _ensure_transcript_feed(self) -> None:
        """Push each finished transcript turn to the browser the moment it is recorded.

        The browser used to learn about turns only by polling the database: the turn was
        debounced 0.75 s, written to Supabase, then picked up by a 1.2 s poll (about 2 s or
        more after the turn existed). MonitorHub already fans every turn out instantly to
        listen-in sockets; this subscribes the call's own socket as a captions-only listener
        (no audio frames). The database copy is still written and still polled as a fallback.
        """
        if self._transcript_task is not None:
            return
        sub = get_hub().subscribe(self._session_id, audio=False)
        if sub is None:
            return
        self._transcript_sub = sub
        self._transcript_task = asyncio.ensure_future(self._forward_transcript(sub))

    async def _forward_transcript(self, sub: Any) -> None:
        try:
            while True:
                item = await sub.get()
                if item is None:
                    return
                if isinstance(item, dict):
                    await self._ws.send_text(json.dumps(item))
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 - captions are best-effort; the call must go on
            logger.debug("app call transcript feed ended")

    def _ensure_pump(self) -> None:
        if self._pump_task is None:
            self._pump_task = asyncio.ensure_future(self._pump())

    async def _pump(self) -> None:
        """Read the browser socket continuously; the only caller of ``self._ws.receive()``."""
        try:
            while True:
                message = await self._ws.receive()
                self._inbox.put_nowait((time.monotonic(), message))
                if message.get("type") == "websocket.disconnect":
                    return
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 - a dead socket ends the call through the normal path
            self._inbox.put_nowait((time.monotonic(), {"type": "websocket.disconnect"}))

    # -- the AcafBridge-facing surface ---------------------------------

    async def receive_text(self) -> str:
        """The bridge's first read is the hello; the service writes it, not the browser."""
        self._ensure_pump()
        self._ensure_transcript_feed()
        return self._hello

    async def receive(self) -> dict[str, Any]:
        while True:
            if not self._pending.empty():
                return self._pending.get_nowait()
            self._ensure_pump()
            queued_at, message = await self._inbox.get()
            if message.get("type") == "websocket.disconnect":
                return message
            data = message.get("bytes")
            if data is not None and time.monotonic() - queued_at > STALE_UPLINK_SECS:
                self._stale_frames += 1
                self._stale_bytes += len(data)
                continue
            break
        if self._stale_frames:
            logger.info(
                "discarded mic audio captured while the call was starting",
                extra={
                    "frames": self._stale_frames,
                    "audioSecs": round(self._stale_bytes / (BROWSER_SAMPLE_RATE * 2), 1),
                },
            )
            self._stale_frames = 0
            self._stale_bytes = 0
        if data is not None:
            self._seq += 1
            frame = AudioFrame.audio_in(
                data,
                sequence=self._seq,
                timestamp_ms=int((time.monotonic() - self._t0) * 1000),
                sample_rate=BROWSER_SAMPLE_RATE,
            )
            return {"type": "websocket.receive", "bytes": frame.encode()}
        text = message.get("text")
        if text is not None:
            try:
                body = json.loads(text)
            except (TypeError, ValueError):
                return {"type": "websocket.receive", "text": json.dumps({"type": CONTROL_PING})}
            kind = body.get("type") if isinstance(body, dict) else None
            if kind in (CONTROL_HANGUP, CONTROL_INTERRUPT, CONTROL_PING):
                return {"type": "websocket.receive", "text": json.dumps({"type": kind})}
        return {"type": "websocket.receive", "text": json.dumps({"type": CONTROL_PING})}

    async def send_bytes(self, payload: bytes) -> None:
        try:
            frame = AudioFrame.decode(payload)
        except Exception:  # noqa: BLE001 - a bad frame is dropped, never fatal
            return
        if frame.type != FrameType.AUDIO_OUT or not frame.payload:
            return
        # Browser frame: 4-byte little-endian sample rate + PCM16 mono.
        await self._ws.send_bytes(frame.sample_rate.to_bytes(4, "little") + frame.payload)

    async def send_text(self, text: str) -> None:
        try:
            body = json.loads(text)
        except (TypeError, ValueError):
            return
        kind = body.get("type") if isinstance(body, dict) else None
        if kind == "ready" and not self._call_active_sent:
            # Nobody has to "answer" an in-app call: the person is already here.
            # The service starts the conversation (and the GPT-Live session) on
            # call_active, exactly as it does when a callee picks up.
            self._call_active_sent = True
            self._pending.put_nowait(
                {"type": "websocket.receive", "text": json.dumps({"type": CONTROL_CALL_ACTIVE})}
            )
        if kind in _FORWARDED_CONTROLS:
            await self._ws.send_text(json.dumps({"type": kind}))

    async def close(self) -> None:
        if self._pump_task is not None and not self._pump_task.done():
            self._pump_task.cancel()
        if self._transcript_task is not None and not self._transcript_task.done():
            self._transcript_task.cancel()
        if self._transcript_sub is not None:
            get_hub().unsubscribe(self._session_id, self._transcript_sub)
            self._transcript_sub = None
        try:
            await self._ws.send_text(json.dumps({"type": "ended"}))
            await self._ws.close(code=1000)
        except Exception:  # noqa: BLE001
            logger.debug("app call socket already closed")
