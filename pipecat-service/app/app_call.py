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


def verify_app_call_token(secret: str, token: str, *, session_id: str) -> str:
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
    expected = hmac.new(secret.encode(), f"appcall:{session_id}:{user_id}:{exp}".encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, sig):
        raise AppCallTokenError("signature mismatch")
    return user_id


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

    # -- the AcafBridge-facing surface ---------------------------------

    async def receive_text(self) -> str:
        """The bridge's first read is the hello; the service writes it, not the browser."""
        return self._hello

    async def receive(self) -> dict[str, Any]:
        if not self._pending.empty():
            return self._pending.get_nowait()
        message = await self._ws.receive()
        if message.get("type") == "websocket.disconnect":
            return message
        data = message.get("bytes")
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
        try:
            await self._ws.send_text(json.dumps({"type": "ended"}))
            await self._ws.close(code=1000)
        except Exception:  # noqa: BLE001
            logger.debug("app call socket already closed")
