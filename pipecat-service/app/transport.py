"""The ACAF bridge: one WebSocket connection carrying one live call.

Responsibilities, and deliberately nothing else:

  1. Authenticate the peer with the shared bridge secret.
  2. Negotiate the audio format via the `hello` handshake.
  3. Pump audio in both directions between the WebSocket and the Pipecat
     pipeline, through the serializer.
  4. Keep the connection honest: heartbeats with a deadline, idle timeouts,
     metrics.
  5. Tear the session down cleanly on any exit path.

It contains no Telegram logic, no Twilio logic, and no Pipecat service
configuration -- it is the seam, not the implementation. That is what lets the
same bridge serve the Telegram adapter and, in principle, any carrier whose
adapter can speak ACAF.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import time
from typing import Any

from fastapi import WebSocket
from loguru import logger

from app.backpressure import BoundedFrameQueue
from app.config import Settings
from app.protocol import (
    CONTROL_ERROR,
    CONTROL_HANGUP,
    CONTROL_HELLO,
    CONTROL_INTERRUPT,
    CONTROL_METRICS,
    CONTROL_PING,
    CONTROL_PONG,
    CONTROL_READY,
    CONTROL_STOPPED,
    AudioFrame,
    ControlMessage,
    Encoding,
    FrameType,
    ProtocolError,
)
from app.session import CallSession, SessionRegistry, SessionState
from app.serializer import TelegramFrameSerializer

#: How long the peer has to send `hello` after the socket opens. Anything
#: longer is an idle connection occupying a session slot.
HELLO_TIMEOUT_SECS = 10.0

#: Largest control message accepted. Control messages are small JSON objects;
#: a large one is either a bug or an attempt to exhaust memory.
MAX_CONTROL_BYTES = 8 * 1024


class BridgeAuthError(RuntimeError):
    """Raised when the peer fails the `hello` handshake."""


class AcafBridge:
    """One ACAF connection, from handshake to teardown."""

    def __init__(
        self,
        *,
        websocket: WebSocket,
        settings: Settings,
        registry: SessionRegistry,
    ) -> None:
        self._ws = websocket
        self._settings = settings
        self._registry = registry

        self.session: CallSession | None = None
        self.serializer: TelegramFrameSerializer | None = None
        self._closed = asyncio.Event()
        self._write_lock = asyncio.Lock()
        self._tasks: list[asyncio.Task[Any]] = []
        self._frames_sent = 0
        self._frames_dropped = 0
        #: Scratch queue used only before the handshake completes.
        self._pre_session_queue: BoundedFrameQueue | None = None
        #: True once the peer has deliberately ended the call (hangup/stopped).
        #: Distinguishes "call finished" from "socket dropped", which are very
        #: different: one should release the session now, the other must hold
        #: it open so the carrier can reconnect into the same conversation.
        self._peer_ended = False

    @property
    def _outbound(self) -> BoundedFrameQueue:
        """The session's outbound queue -- deliberately not a second queue.

        The bridge must drain the *same* queue that `CallSession.cancel_outbound()`
        clears on barge-in. Two separate queues was a real bug: the cancel
        path emptied the session's queue while the write pump drained the
        bridge's, so barge-in stopped nothing and queued TTS kept playing.

        Before a session exists there is nothing to send, so a small
        throwaway queue is returned rather than raising -- it also keeps the
        pre-handshake path from being a special case in every caller.
        """
        if self.session is not None:
            return self.session.outbound
        if self._pre_session_queue is None:
            self._pre_session_queue = BoundedFrameQueue(
                self._settings.outbound_queue_max_frames
            )
        return self._pre_session_queue

    # -- public API ------------------------------------------------------

    async def run(self) -> None:
        """Handshake, then pump until the call ends."""
        hello = await self._await_hello()
        self.session = await self._establish_session(hello)
        self.serializer = self._build_serializer(hello, self.session)

        self.session.transition_to(SessionState.ACTIVE)
        await self._send_control(CONTROL_READY, platform=self.session.platform)

        logger.info(
            "bridge established",
            extra={
                "sessionId": self.session.session_id,
                "platform": self.session.platform,
                "bridgeSampleRate": self.serializer.stats()["bridgeSampleRate"],
            },
        )

        # The session asks us to hang up when the assistant decides the call
        # is over; registering here means every teardown path goes through
        # one place.
        self.session.on_stop(self._on_session_stop)

        self._tasks = [
            asyncio.create_task(self._read_loop(), name="acaf-read"),
            asyncio.create_task(self._heartbeat_loop(), name="acaf-heartbeat"),
            asyncio.create_task(self._write_loop(), name="acaf-write"),
        ]
        try:
            await self._closed.wait()
        finally:
            await self._cancel_tasks()

    async def close(self, reason: str = "closed") -> None:
        """Close the socket. Moves the session on to its next state.

        Deliberately does *not* always release the session, because there are
        two different endings and conflating them breaks reconnection:

          * **The call is over.** The peer sent `hangup`, the session was
            stopped internally, or the process is shutting down. Release the
            session now; nothing will reconnect to it.

          * **The socket dropped.** A mobile network handover, a proxy
            restart, a transient TCP reset. The carrier may reconnect within
            the grace period and must land back in the *same* conversation,
            so the session is left in RECONNECTING for `SessionRegistry.reap`
            to collect if nothing reclaims it.

        Releasing on every socket close would make the reconnect path
        unreachable, and the brief asks for reconnection explicitly.
        """
        if self._closed.is_set() and self.session is None:
            return
        with contextlib.suppress(Exception):
            await self._send_control(CONTROL_STOPPED, reason=reason)
        self._closed.set()
        with contextlib.suppress(Exception):
            await self._ws.close()

        session = self.session
        if session is not None:
            deliberate = (
                self._peer_ended
                or session.stopped
                or reason in ("shutdown", "hung-up", "peer-hangup", "session-stopped")
            )
            if deliberate:
                with contextlib.suppress(Exception):
                    await self._registry.remove(session.session_id, reason)
            else:
                session.mark_disconnected()
            self.session = None

    def stats(self) -> dict[str, Any]:
        return {
            "framesSent": self._frames_sent,
            "framesDropped": self._frames_dropped,
            "session": self.session.safe_stats() if self.session else None,
            "serializer": self.serializer.stats() if self.serializer else None,
        }

    # -- handshake -------------------------------------------------------

    async def _await_hello(self) -> ControlMessage:
        """Wait for and validate the peer's `hello` control message."""
        try:
            raw = await asyncio.wait_for(self._ws.receive_text(), timeout=HELLO_TIMEOUT_SECS)
        except asyncio.TimeoutError as exc:
            raise BridgeAuthError("no hello within timeout") from exc

        if len(raw) > MAX_CONTROL_BYTES:
            raise BridgeAuthError("hello too large")

        try:
            body = json.loads(raw)
        except (TypeError, ValueError) as exc:
            raise BridgeAuthError("hello was not valid JSON") from exc

        message = ControlMessage.from_dict(body)
        if message.type != CONTROL_HELLO:
            raise BridgeAuthError(f"expected hello, got {message.type!r}")

        self._authenticate(message)
        return message

    def _authenticate(self, message: ControlMessage) -> None:
        """Verify the shared bridge secret.

        Mock mode skips this so a local run needs no secret at all. In every
        other mode a wrong secret is refused -- and the failure is logged
        without the supplied or expected value, since logging either would
        defeat the check.
        """
        if self._settings.mock_mode:
            return
        expected = self._settings.bridge_secret
        supplied = message.extra.get("secret")
        if not isinstance(supplied, str) or not expected:
            raise BridgeAuthError("missing bridge secret")
        # Constant-time comparison: a timing side channel on a shared secret
        # is a real (if unglamorous) way to leak it one byte at a time.
        import hmac

        if not hmac.compare_digest(supplied, expected):
            logger.warning("bridge handshake rejected: bad secret")
            raise BridgeAuthError("invalid bridge secret")

    def _build_serializer(
        self, hello: ControlMessage, session: CallSession
    ) -> TelegramFrameSerializer:
        """Configure the serializer from the peer's declared audio format.

        Defaults are applied when the peer omits a field, and the defaults are
        the bridge format (16 kHz mono PCM16), never a carrier's native rate.
        """
        bridge_rate = _int_or(
            hello.extra.get("sampleRate"), self._settings.bridge_sample_rate
        )
        channels = _int_or(hello.extra.get("channels"), 1)
        encoding_name = str(hello.extra.get("encoding") or "pcm_s16le")

        if encoding_name != Encoding.PCM_S16LE.name.lower():
            # Refusing early is better than failing per-frame for the whole
            # call. Only PCM is supported because Pipecat 1.11 ships no Opus
            # decoder; see app/serializer.py.
            raise ProtocolError(
                f"unsupported bridge encoding {encoding_name!r}; this build "
                "accepts 'pcm_s16le' only"
            )

        params = TelegramFrameSerializer.InputParams(
            bridge_sample_rate=bridge_rate,
            bridge_channels=channels,
            # The peer owns the call: if it drops the socket, it hangs up.
            # Sending a hangup on every socket close would discard calls that
            # are being reconnected.
            auto_hang_up=False,
        )
        return TelegramFrameSerializer(session.session_id, params=params)

    async def _establish_session(self, hello: ControlMessage) -> CallSession:
        """Resume a reconnecting session, or create a new one."""
        requested_id = hello.session_id or hello.extra.get("sessionId")
        if isinstance(requested_id, str) and requested_id:
            existing = self._registry.find_resumable(requested_id)
            if existing is not None:
                existing.mark_resumed()
                return existing

        return await self._registry.create(
            session_id=requested_id if isinstance(requested_id, str) else None,
            platform=str(hello.extra.get("platform") or "unknown"),
            user_id=(
                str(hello.extra["userId"]) if hello.extra.get("userId") else None
            ),
            idle_timeout_secs=self._settings.idle_timeout_secs,
            heartbeat_interval_secs=self._settings.heartbeat_interval_secs,
            outbound_queue_max_frames=self._settings.outbound_queue_max_frames,
            max_call_seconds=self._settings.max_call_seconds,
        )

    # -- pump loops ------------------------------------------------------

    async def _read_loop(self) -> None:
        """Read inbound messages until the peer stops or the socket closes."""
        assert self.session is not None
        try:
            while not self._closed.is_set():
                message = await self._ws.receive()

                if message["type"] == "websocket.disconnect":
                    self.session.mark_disconnected()
                    logger.info(
                        "peer disconnected",
                        extra={"sessionId": self.session.session_id},
                    )
                    break

                if (text := message.get("text")) is not None:
                    if len(text) > MAX_CONTROL_BYTES:
                        logger.warning(
                            "oversized control message ignored",
                            extra={"sessionId": self.session.session_id},
                        )
                        continue
                    if await self._handle_control(text):
                        continue
                    continue

                if (data := message.get("bytes")) is not None:
                    await self._handle_audio(data)

        except WebSocketDisconnect:
            self.session.mark_disconnected()
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 - ends this call only
            logger.warning(
                "read loop ended",
                extra={
                    "sessionId": self.session.session_id,
                    "error": type(exc).__name__,
                },
            )
        finally:
            self._closed.set()

    async def _handle_control(self, text: str) -> bool:
        """Handle one control message. Returns True if it was consumed."""
        assert self.session is not None
        try:
            message = ControlMessage.from_dict(json.loads(text))
        except (ProtocolError, TypeError, ValueError):
            logger.warning(
                "malformed control message ignored",
                extra={"sessionId": self.session.session_id},
            )
            return True

        if message.type == CONTROL_PING:
            self.session.note_heartbeat_reply()
            await self._send_control(CONTROL_PONG)
            return True

        if message.type == CONTROL_PONG:
            self.session.note_heartbeat_reply()
            return True

        if message.type == CONTROL_INTERRUPT:
            # Caller started speaking. Drop queued assistant audio; anything
            # already on the wire is the carrier's problem to flush, which is
            # what the outbound INTERRUPT frame tells it to do.
            self.session.note_barge_in()
            dropped = self.session.cancel_outbound()
            self._frames_dropped += dropped
            if self.serializer is not None:
                self.serializer.note_assistant_stopped_speaking()
            logger.debug(
                "barge-in: cancelled queued audio",
                extra={"sessionId": self.session.session_id, "dropped": dropped},
            )
            return True

        if message.type in (CONTROL_HANGUP, CONTROL_STOPPED):
            self._peer_ended = True
            logger.info(
                "peer ended the call",
                extra={"sessionId": self.session.session_id, "type": message.type},
            )
            self._closed.set()
            return True

        return True

    async def _handle_audio(self, data: bytes) -> None:
        """Feed one inbound audio frame to the pipeline."""
        assert self.session is not None
        if len(data) > self._settings.max_frame_bytes:
            logger.warning(
                "oversized audio frame dropped",
                extra={"sessionId": self.session.session_id, "bytes": len(data)},
            )
            return

        # Decode once here to recover the sequence number. `note_inbound`
        # must receive it -- without it the SequenceTracker never sees a
        # sequence and silently reports zero loss forever, which is worse
        # than having no metric at all because it looks healthy.
        try:
            decoded = AudioFrame.decode(data)
        except ProtocolError:
            self.session.note_malformed(byte_count=len(data))
            logger.debug(
                "malformed inbound frame",
                extra={"sessionId": self.session.session_id, "bytes": len(data)},
            )
            return

        self.session.note_inbound(
            sequence=decoded.sequence, byte_count=len(data)
        )

        if self.serializer is None:
            return
        # Deserializing here (rather than handing raw bytes to a transport)
        # keeps the ACAF protocol entirely inside this service: Pipecat sees
        # only its own frame types.
        frame = await self.serializer.deserialize(data)
        if frame is None:
            return
        await self._forward_to_pipeline(frame)

    async def _forward_to_pipeline(self, frame: Any) -> None:
        """Placeholder seam for pipeline input.

        The bridge is transport, not pipeline. In the assembled service the
        `FastAPIWebsocketTransport` reads the socket itself; when the bridge
        owns the socket (as here, so it can do its own handshake, heartbeats
        and backpressure) frames are pushed onto the pipeline task's input
        queue through this method.
        """
        queue = getattr(self, "_pipeline_input", None)
        if queue is not None:
            await queue.put(frame)

    def _inbound_sequence(self, data: bytes) -> int | None:
        """Peek at a frame's sequence number without full deserialization."""
        try:
            return AudioFrame.decode(data).sequence
        except ProtocolError:
            return None

    async def _heartbeat_loop(self) -> None:
        """Send heartbeats and periodic metrics; notice when they go unanswered."""
        assert self.session is not None
        try:
            while not self._closed.is_set():
                await asyncio.sleep(self._settings.heartbeat_interval_secs)
                if self._closed.is_set():
                    return

                if self.session.heartbeat_unanswered():
                    self.session.stats.heartbeats_missed += 1
                    logger.warning(
                        "peer has not answered heartbeats; closing bridge",
                        extra={"sessionId": self.session.session_id},
                    )
                    self._closed.set()
                    return

                if self.session.heartbeat_due():
                    await self._send_text(self.session.mark_heartbeat_sent())

                if self.serializer is not None:
                    metrics = self.serializer.maybe_metrics()
                    if metrics:
                        await self._send_text(metrics)
                        self._report_metrics(metrics)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "heartbeat loop ended",
                extra={
                    "sessionId": self.session.session_id,
                    "error": type(exc).__name__,
                },
            )
            self._closed.set()

    async def _write_loop(self) -> None:
        """Drain the outbound queue, applying backpressure."""
        assert self.session is not None
        try:
            while not self._closed.is_set():
                if self._outbound.empty:
                    await asyncio.sleep(0.005)
                    continue

                if not self.session.backpressure.should_send():
                    # Skip this frame to halve the data rate. Counted so the
                    # degradation is visible rather than silent.
                    dropped = self._outbound.get()
                    if dropped is not None:
                        self._frames_dropped += 1
                    continue

                item = self._outbound.get()
                if item is None:
                    continue
                payload, byte_count = item  # type: ignore[misc]
                await self._ws.send_bytes(payload)
                self.session.note_outbound(byte_count)
                self._frames_sent += 1
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "write loop ended",
                extra={
                    "sessionId": self.session.session_id,
                    "error": type(exc).__name__,
                },
            )
            self._closed.set()

    # -- outbound helpers ------------------------------------------------

    async def send_audio(self, payload: bytes) -> None:
        """Queue an outbound audio frame, applying drop-oldest backpressure."""
        assert self.session is not None
        dropped = self._outbound.put((payload, len(payload)))
        if dropped:
            self._frames_dropped += 1

    async def _send_control(self, message_type: str, **extra: Any) -> None:
        session_id = self.session.session_id if self.session else None
        await self._send_text(
            ControlMessage(message_type, session_id, extra=extra).to_json()
        )

    async def _send_text(self, text: str) -> None:
        """Send a control message, serialized against concurrent writers."""
        async with self._write_lock:
            if self._closed.is_set() and json.loads(text).get("type") != CONTROL_STOPPED:
                return
            await self._ws.send_text(text)

    async def _on_session_stop(self, reason: str) -> None:
        """Session teardown callback: tell the peer, then close."""
        with contextlib.suppress(Exception):
            await self._send_control(CONTROL_HANGUP, reason=reason)
        self._closed.set()

    async def _cancel_tasks(self) -> None:
        for task in self._tasks:
            task.cancel()
        for task in self._tasks:
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await task
        self._tasks.clear()

    def _report_metrics(self, payload: str) -> None:
        """Log a metrics frame in structured form.

        The frame itself is forwarded to the peer; logging it here means the
        operator can see loss and barge-in counts in the Render log without
        having to correlate against the PHP side.
        """
        with contextlib.suppress(Exception):
            body = json.loads(payload)
            logger.info(
                "session metrics",
                extra={
                    "sessionId": body.get("sessionId"),
                    "uptimeSecs": body.get("uptimeSecs"),
                    "missingFrames": body.get("inbound", {}).get("missing"),
                    "bargeIns": body.get("bargeIns"),
                    "ttsFramesCancelled": body.get("ttsFramesCancelled"),
                },
            )


def _int_or(value: Any, default: int) -> int:
    """Coerce a handshake field to int, falling back on anything unusable."""
    if isinstance(value, bool) or not isinstance(value, (int, float, str)):
        return default
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return default
    return parsed if parsed > 0 else default
