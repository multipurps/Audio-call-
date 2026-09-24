"""Per-call session lifecycle: heartbeat, timeout, reconnect, cleanup.

One `CallSession` per live call. It owns everything with a lifetime shorter
than the process: the outbound queue, the sequence counters, the heartbeat
clock, the pipeline task handle, and the transcript.

The three failure modes this exists to prevent, all of which are silent
without it:

  1. **A zombie session.** The peer disappears without a close frame (a
     dropped mobile connection is the normal case, not the exception). Without
     an idle timeout the session -- and its Pipecat pipeline, and its LLM/TTS
     connections -- stays alive forever, billing and holding memory.
  2. **A half-open connection.** The socket looks alive but nothing is
     flowing. A heartbeat with a deadline detects this; a heartbeat without a
     deadline does not, because it never checks whether a reply came back.
  3. **A slow leak on redeploy.** Render sends SIGTERM on deploy. Without
     coordinated shutdown, in-flight calls are cut mid-sentence and their
     state is never released.

Reconnect is deliberately modelled as *resume*, not as a new call: the
carrier may reconnect the transport socket (a mobile network handover), and
when it does the same session must continue with the same transcript and
memory. The brief asks for "reconnection or clear failure handling"; this
gives both, with a bounded grace period after which the session is reaped and
the failure is explicit.
"""

from __future__ import annotations

import asyncio
import enum
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable, Awaitable

from loguru import logger

from app.backpressure import BackpressureSignal, BoundedFrameQueue
from app.protocol import ControlMessage, SequenceTracker


class SessionState(str, enum.Enum):
    """Lifecycle states. Transitions are enforced by `transition_to`."""

    CREATED = "created"
    ACTIVE = "active"
    #: Peer vanished; held open in case it reconnects.
    RECONNECTING = "reconnecting"
    STOPPING = "stopping"
    STOPPED = "stopped"


#: Allowed transitions. Anything not listed is a bug, and raising on it turns
#: a subtle lifecycle bug into a loud failure in testing.
_ALLOWED_TRANSITIONS: dict[SessionState, frozenset[SessionState]] = {
    SessionState.CREATED: frozenset({SessionState.ACTIVE, SessionState.STOPPING}),
    SessionState.ACTIVE: frozenset(
        {SessionState.RECONNECTING, SessionState.STOPPING}
    ),
    SessionState.RECONNECTING: frozenset(
        {SessionState.ACTIVE, SessionState.STOPPING}
    ),
    SessionState.STOPPING: frozenset({SessionState.STOPPED}),
    SessionState.STOPPED: frozenset(),
}


class InvalidTransition(RuntimeError):
    """Raised on an illegal session state transition."""


@dataclass
class SessionStats:
    """Everything about a session that is safe to log or serve over /healthz."""

    frames_in: int = 0
    frames_out: int = 0
    malformed_in: int = 0
    bytes_in: int = 0
    bytes_out: int = 0
    heartbeats_sent: int = 0
    heartbeats_missed: int = 0
    reconnects: int = 0
    barge_ins: int = 0
    tts_cancelled: int = 0
    turns: int = 0
    transcript_chars: int = 0
    created_at: float = field(default_factory=time.monotonic)

    @property
    def uptime_secs(self) -> float:
        return time.monotonic() - self.created_at


class CallSession:
    """State and lifetime for one live call."""

    def __init__(
        self,
        session_id: str,
        *,
        platform: str = "unknown",
        user_id: str | None = None,
        idle_timeout_secs: float = 30.0,
        heartbeat_interval_secs: float = 10.0,
        outbound_queue_max_frames: int = 100,
        max_call_seconds: float = 1800.0,
        reconnect_grace_secs: float = 15.0,
        metadata: dict[str, Any] | None = None,
    ) -> None:
        self.session_id = session_id
        self.platform = platform
        #: Supabase user id. Never a phone number or a token.
        self.user_id = user_id
        self.metadata = metadata or {}

        self.state = SessionState.CREATED
        self.stats = SessionStats()
        self.created_at = time.monotonic()

        self._idle_timeout = idle_timeout_secs
        self._heartbeat_interval = heartbeat_interval_secs
        self._reconnect_grace = reconnect_grace_secs
        self._max_call_seconds = max_call_seconds

        self.outbound: BoundedFrameQueue = BoundedFrameQueue(outbound_queue_max_frames)
        self.backpressure = BackpressureSignal(self.outbound)
        self.inbound_sequences = SequenceTracker()

        self.last_inbound_at = time.monotonic()
        self.last_outbound_at = time.monotonic()
        # Seeded to "now", not 0.0. `time.monotonic()` is uptime-since-boot, so
        # 0.0 would make a brand-new session look like its heartbeat was due
        # long ago and fire one on the very first tick of the watchdog --
        # before the peer has had any chance to answer.
        self.last_heartbeat_at = time.monotonic()
        self.last_heartbeat_reply_at = self.last_heartbeat_at
        self.disconnected_at: float | None = None

        #: Set by the transport; awaited on shutdown so a redeploy does not
        #: cut a call mid-sentence without first telling the carrier.
        self.stop_callbacks: list[Callable[[str], Awaitable[None]]] = []
        self._stopped = asyncio.Event()

    # -- transitions -----------------------------------------------------

    def transition_to(self, new_state: SessionState) -> None:
        if new_state == self.state:
            return
        if new_state not in _ALLOWED_TRANSITIONS[self.state]:
            raise InvalidTransition(
                f"session {self.session_id}: cannot go "
                f"{self.state.value} -> {new_state.value}"
            )
        logger.info(
            "session state change",
            extra={
                "sessionId": self.session_id,
                "from": self.state.value,
                "to": new_state.value,
            },
        )
        self.state = new_state

    # -- liveness --------------------------------------------------------

    def note_inbound(self, *, sequence: int | None = None, byte_count: int = 0) -> None:
        """Record inbound activity. Any frame counts as liveness."""
        self.last_inbound_at = time.monotonic()
        self.stats.frames_in += 1
        self.stats.bytes_in += byte_count
        if sequence is not None:
            self.inbound_sequences.observe(sequence)

    def note_outbound(self, byte_count: int = 0) -> None:
        self.last_outbound_at = time.monotonic()
        self.stats.frames_out += 1
        self.stats.bytes_out += byte_count

    def note_malformed(self, byte_count: int = 0) -> None:
        """Record an unparseable inbound frame.

        Counted separately from `frames_in` so a peer that is sending
        corrupted audio shows up as a distinct signal rather than as either
        "healthy traffic" or "silence". Liveness is still refreshed: a
        malformed frame proves the peer is alive even though its bytes are
        unusable, and treating it as silence would tear down a call that is
        merely corrupt.
        """
        self.last_inbound_at = time.monotonic()
        self.stats.malformed_in += 1
        self.stats.bytes_in += byte_count

    def note_heartbeat_reply(self) -> None:
        self.last_heartbeat_reply_at = time.monotonic()

    def heartbeat_due(self, now: float | None = None) -> bool:
        now = now if now is not None else time.monotonic()
        return (now - self.last_heartbeat_at) >= self._heartbeat_interval

    def mark_heartbeat_sent(self, now: float | None = None) -> str:
        self.last_heartbeat_at = now if now is not None else time.monotonic()
        self.stats.heartbeats_sent += 1
        return ControlMessage("ping", self.session_id).to_json()

    def is_idle(self, now: float | None = None) -> bool:
        """No inbound audio for longer than the idle timeout."""
        now = now if now is not None else time.monotonic()
        return (now - self.last_inbound_at) > self._idle_timeout

    def heartbeat_unanswered(self, now: float | None = None) -> bool:
        """A heartbeat was sent and no reply arrived within the interval.

        Checked separately from `is_idle` because a peer can be sending audio
        while failing to answer heartbeats, and that is a different (and
        earlier) warning sign than going quiet.
        """
        now = now if now is not None else time.monotonic()
        if self.stats.heartbeats_sent == 0:
            return False
        if self.last_heartbeat_reply_at >= self.last_heartbeat_at:
            return False
        return (now - self.last_heartbeat_at) > (self._heartbeat_interval * 2.5)

    def exceeded_max_duration(self, now: float | None = None) -> bool:
        now = now if now is not None else time.monotonic()
        return (now - self.created_at) > self._max_call_seconds

    # -- reconnect -------------------------------------------------------

    def mark_disconnected(self) -> None:
        if self.state is SessionState.ACTIVE:
            self.transition_to(SessionState.RECONNECTING)
        self.disconnected_at = time.monotonic()

    def can_resume(self, now: float | None = None) -> bool:
        """Whether a reconnect may rejoin this session rather than start new."""
        if self.state is not SessionState.RECONNECTING:
            return False
        if self.disconnected_at is None:
            return True
        now = now if now is not None else time.monotonic()
        return (now - self.disconnected_at) <= self._reconnect_grace

    def mark_resumed(self) -> None:
        """Peer reconnected: continue this session with its history intact."""
        self.transition_to(SessionState.ACTIVE)
        self.disconnected_at = None
        self.stats.reconnects += 1
        # Heartbeats restart cleanly; a stale missed-heartbeat state from
        # before the gap would otherwise immediately trip the watchdog.
        self.last_heartbeat_reply_at = time.monotonic()
        logger.info(
            "session resumed after reconnect",
            extra={"sessionId": self.session_id, "reconnects": self.stats.reconnects},
        )

    def reconnect_expired(self, now: float | None = None) -> bool:
        return (
            self.state is SessionState.RECONNECTING
            and not self.can_resume(now)
        )

    # -- cancellation ----------------------------------------------------

    def cancel_outbound(self) -> int:
        """Drop queued outbound audio. Called on barge-in.

        Returns the number of frames abandoned. Anything already written to
        the carrier socket is gone and cannot be recalled -- the bridge's own
        playout buffer is what clears the rest, which is why the INTERRUPT
        control frame must reach it.
        """
        dropped = self.outbound.discard_all()
        self.backpressure.reset()
        self.stats.tts_cancelled += dropped
        if dropped:
            logger.debug(
                "cancelled queued TTS frames",
                extra={"sessionId": self.session_id, "dropped": dropped},
            )
        return dropped

    def note_barge_in(self) -> None:
        self.stats.barge_ins += 1

    # -- teardown --------------------------------------------------------

    async def stop(self, reason: str = "closed") -> None:
        """Tear the session down. Idempotent; never raises.

        Registered stop callbacks run first so the carrier is told the call is
        over while the transport can still carry the message. Failures in a
        callback are logged and swallowed: one misbehaving callback must not
        prevent the remaining ones from running, or the session from being
        released.
        """
        if self.state is SessionState.STOPPED:
            return
        if self.state is not SessionState.STOPPING:
            try:
                self.transition_to(SessionState.STOPPING)
            except InvalidTransition:
                # Stop is called from finally blocks and signal handlers; a
                # transition error must not propagate from here.
                self.state = SessionState.STOPPING

        for callback in self.stop_callbacks:
            try:
                await callback(reason)
            except Exception as exc:  # noqa: BLE001 - teardown must complete
                logger.warning(
                    "session stop callback failed",
                    extra={
                        "sessionId": self.session_id,
                        "error": type(exc).__name__,
                    },
                )
        self.stop_callbacks.clear()

        self.outbound.discard_all()
        self.state = SessionState.STOPPED
        self._stopped.set()
        logger.info(
            "session stopped",
            extra={"sessionId": self.session_id, "reason": reason, **self.safe_stats()},
        )

    async def wait_stopped(self) -> None:
        await self._stopped.wait()

    @property
    def stopped(self) -> bool:
        return self.state is SessionState.STOPPED

    def on_stop(self, callback: Callable[[str], Awaitable[None]]) -> None:
        self.stop_callbacks.append(callback)

    # -- observability ---------------------------------------------------

    def safe_stats(self) -> dict[str, Any]:
        """Session telemetry with nothing sensitive in it.

        No audio, no transcript text, no phone numbers, no tokens -- the
        counters only. A transcript's *length* is fine; its content is not.
        """
        return {
            "state": self.state.value,
            "platform": self.platform,
            "uptimeSecs": round(self.stats.uptime_secs, 1),
            "framesIn": self.stats.frames_in,
            "framesOut": self.stats.frames_out,
            "malformedIn": self.stats.malformed_in,
            "bytesIn": self.stats.bytes_in,
            "bytesOut": self.stats.bytes_out,
            "heartbeatsSent": self.stats.heartbeats_sent,
            "heartbeatsMissed": self.stats.heartbeats_missed,
            "reconnects": self.stats.reconnects,
            "bargeIns": self.stats.barge_ins,
            "ttsCancelled": self.stats.tts_cancelled,
            "turns": self.stats.turns,
            "transcriptChars": self.stats.transcript_chars,
            "inboundSequence": self.inbound_sequences.as_metrics(),
            "outboundQueue": self.outbound.stats().as_dict(),
            "backpressure": self.backpressure.stats,
        }


class SessionRegistry:
    """Tracks live sessions, enforces limits, and reaps the dead.

    Deliberately in-process: sessions are tied to a socket held by this
    process, so a shared store would add latency to the hot path for no
    benefit. A Render restart drops all sessions, which is why the reconnect
    path exists at the carrier level.
    """

    def __init__(self, *, max_sessions: int = 200) -> None:
        self._sessions: dict[str, CallSession] = {}
        self._max_sessions = max_sessions
        self._lock = asyncio.Lock()
        self.total_created = 0
        self.total_rejected = 0

    def __len__(self) -> int:
        return len(self._sessions)

    async def create(self, **kwargs: Any) -> CallSession:
        """Create a new session, or raise when at capacity.

        Refusing the call is correct here: accepting it would mean three or
        four calls share one Render instance's CPU badly enough that all of
        them break, rather than one being refused cleanly.
        """
        async with self._lock:
            if len(self._sessions) >= self._max_sessions:
                self.total_rejected += 1
                raise CapacityError(
                    f"at capacity ({self._max_sessions} concurrent sessions); "
                    "refusing new call"
                )
            session_id = kwargs.pop("session_id", None) or str(uuid.uuid4())
            session = CallSession(session_id, **kwargs)
            self._sessions[session_id] = session
            self.total_created += 1
            return session

    def get(self, session_id: str) -> CallSession | None:
        return self._sessions.get(session_id)

    def find_resumable(self, session_id: str) -> CallSession | None:
        """Return a session that a reconnecting peer may resume."""
        session = self._sessions.get(session_id)
        if session is not None and session.can_resume():
            return session
        return None

    async def remove(self, session_id: str, reason: str = "closed") -> None:
        async with self._lock:
            session = self._sessions.pop(session_id, None)
        if session is not None:
            await session.stop(reason)

    async def reap(self, now: float | None = None) -> list[str]:
        """Stop sessions that are idle, expired, or past their reconnect grace.

        Returns the ids that were reaped, for logging and tests.
        """
        now = now if now is not None else time.monotonic()
        reaped: list[str] = []

        for session in list(self._sessions.values()):
            reason: str | None = None
            if session.stopped:
                reason = "already-stopped"
            elif session.reconnect_expired(now):
                reason = "reconnect-timeout"
            elif session.exceeded_max_duration(now):
                reason = "max-duration"
            elif session.is_idle(now) and session.state is SessionState.ACTIVE:
                reason = "idle-timeout"
            if reason is None:
                continue

            if session.heartbeat_unanswered(now):
                session.stats.heartbeats_missed += 1
                logger.warning(
                    "session did not answer heartbeats",
                    extra={"sessionId": session.session_id},
                )

            await self.remove(session.session_id, reason)
            reaped.append(session.session_id)

        return reaped

    async def stop_all(self, reason: str = "shutdown") -> None:
        """Graceful shutdown: every session gets a chance to close cleanly."""
        sessions = list(self._sessions.values())
        if not sessions:
            return
        logger.info(
            "stopping all sessions", extra={"reason": reason, "count": len(sessions)}
        )
        await asyncio.gather(
            *(session.stop(reason) for session in sessions),
            return_exceptions=True,
        )
        self._sessions.clear()

    def snapshot(self) -> dict[str, Any]:
        return {
            "live": len(self._sessions),
            "totalCreated": self.total_created,
            "totalRejected": self.total_rejected,
            "maxSessions": self._max_sessions,
            "sessions": [s.safe_stats() for s in self._sessions.values()],
        }


class CapacityError(RuntimeError):
    """Raised when the service is at its concurrent-session limit."""
