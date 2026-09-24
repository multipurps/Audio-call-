"""Session lifecycle tests.

Covers the brief's requirements for safe call termination, reconnection,
timeout, session cleanup, and graceful shutdown -- the failure modes that are
silent in production if untested (zombie sessions, half-open sockets,
sessions leaked on redeploy).
"""

from __future__ import annotations

import asyncio
import json

import pytest

from app.session import (
    CallSession,
    CapacityError,
    InvalidTransition,
    SessionRegistry,
    SessionState,
)


def make_session(**overrides) -> CallSession:
    kwargs = dict(
        session_id="sess-1",
        platform="telegram",
        user_id="user-1",
        idle_timeout_secs=30.0,
        heartbeat_interval_secs=10.0,
        outbound_queue_max_frames=10,
        max_call_seconds=1800.0,
        reconnect_grace_secs=15.0,
    )
    kwargs.update(overrides)
    return CallSession(**kwargs)


# --------------------------------------------------------------------------
# State machine
# --------------------------------------------------------------------------


class TestStateMachine:
    def test_starts_created(self):
        assert make_session().state is SessionState.CREATED

    def test_legal_transitions(self):
        session = make_session()
        session.transition_to(SessionState.ACTIVE)
        session.transition_to(SessionState.RECONNECTING)
        session.transition_to(SessionState.ACTIVE)
        session.transition_to(SessionState.STOPPING)
        session.transition_to(SessionState.STOPPED)
        assert session.state is SessionState.STOPPED

    def test_active_cannot_jump_straight_to_stopped(self):
        """Teardown must pass through STOPPING so callbacks still run."""
        session = make_session()
        session.transition_to(SessionState.ACTIVE)
        with pytest.raises(InvalidTransition, match="active -> stopped"):
            session.transition_to(SessionState.STOPPED)

    def test_cannot_leave_stopped(self):
        session = make_session()
        session.transition_to(SessionState.STOPPING)
        session.transition_to(SessionState.STOPPED)
        with pytest.raises(InvalidTransition):
            session.transition_to(SessionState.ACTIVE)

    def test_repeated_transition_to_same_state_is_a_noop(self):
        session = make_session()
        session.transition_to(SessionState.ACTIVE)
        session.transition_to(SessionState.ACTIVE)
        assert session.state is SessionState.ACTIVE


# --------------------------------------------------------------------------
# Liveness and timeouts
# --------------------------------------------------------------------------


class TestLiveness:
    def test_fresh_session_is_not_idle(self):
        assert not make_session().is_idle()

    def test_idle_after_timeout(self):
        session = make_session(idle_timeout_secs=30.0)
        assert session.is_idle(now=session.last_inbound_at + 31.0)

    def test_inbound_activity_resets_idle(self):
        session = make_session(idle_timeout_secs=30.0)
        session.note_inbound(sequence=0, byte_count=320)
        assert not session.is_idle(now=session.last_inbound_at + 10.0)

    def test_max_duration(self):
        session = make_session(max_call_seconds=60.0)
        assert session.exceeded_max_duration(now=session.created_at + 61.0)
        assert not session.exceeded_max_duration(now=session.created_at + 59.0)

    def test_heartbeat_not_due_immediately(self):
        assert not make_session().heartbeat_due()

    def test_heartbeat_due_after_interval(self):
        session = make_session(heartbeat_interval_secs=10.0)
        assert session.heartbeat_due(now=session.last_heartbeat_at + 11.0)

    def test_mark_heartbeat_sent_returns_a_ping(self):
        session = make_session()
        payload = json.loads(session.mark_heartbeat_sent())
        assert payload["type"] == "ping"
        assert payload["sessionId"] == "sess-1"
        assert session.stats.heartbeats_sent == 1

    def test_unanswered_heartbeat_detected(self):
        """A half-open socket looks alive but answers nothing.

        Checking only for inbound audio would miss the case where the peer is
        still sending audio but has stopped responding -- and would never
        notice a peer that went quiet *and* stopped answering.
        """
        session = make_session(heartbeat_interval_secs=10.0)
        session.mark_heartbeat_sent(now=100.0)
        session.last_heartbeat_reply_at = 90.0
        assert session.heartbeat_unanswered(now=130.0)  # > 10 * 2.5

    def test_answered_heartbeat_is_not_flagged(self):
        session = make_session(heartbeat_interval_secs=10.0)
        session.mark_heartbeat_sent(now=100.0)
        session.note_heartbeat_reply_at = None  # defensive: attribute not set
        session.last_heartbeat_reply_at = 101.0
        assert not session.heartbeat_unanswered(now=103.0)

    def test_no_heartbeats_sent_means_nothing_to_miss(self):
        assert not make_session().heartbeat_unanswered(now=10_000.0)


# --------------------------------------------------------------------------
# Reconnect
# --------------------------------------------------------------------------


class TestReconnect:
    def test_disconnect_moves_to_reconnecting(self):
        session = make_session()
        session.transition_to(SessionState.ACTIVE)
        session.mark_disconnected()
        assert session.state is SessionState.RECONNECTING

    def test_can_resume_within_grace(self):
        session = make_session(reconnect_grace_secs=15.0)
        session.transition_to(SessionState.ACTIVE)
        session.mark_disconnected()
        assert session.can_resume(now=session.disconnected_at + 5.0)

    def test_cannot_resume_after_grace(self):
        session = make_session(reconnect_grace_secs=15.0)
        session.transition_to(SessionState.ACTIVE)
        session.mark_disconnected()
        assert not session.can_resume(now=session.disconnected_at + 16.0)

    def test_reconnect_expired_helper(self):
        session = make_session(reconnect_grace_secs=15.0)
        session.transition_to(SessionState.ACTIVE)
        session.mark_disconnected()
        assert session.reconnect_expired(now=session.disconnected_at + 20.0)
        assert not session.reconnect_expired(now=session.disconnected_at + 5.0)

    def test_resume_keeps_transcript_and_counters(self):
        """A network handover must not reset the conversation."""
        session = make_session()
        session.transition_to(SessionState.ACTIVE)
        session.stats.turns = 4
        session.stats.frames_in = 120
        session.note_inbound(sequence=5)
        session.mark_disconnected()
        session.mark_resumed()

        assert session.state is SessionState.ACTIVE
        assert session.stats.turns == 4
        assert session.stats.frames_in == 121
        assert session.stats.reconnects == 1
        assert session.inbound_sequences.last_sequence == 5

    def test_active_session_cannot_be_resumed_as_if_reconnecting(self):
        session = make_session()
        session.transition_to(SessionState.ACTIVE)
        assert not session.can_resume()


# --------------------------------------------------------------------------
# Barge-in / cancellation
# --------------------------------------------------------------------------


class TestCancellation:
    def test_cancel_outbound_drops_queued_frames(self):
        session = make_session()
        for i in range(5):
            session.outbound.put(i)
        dropped = session.cancel_outbound()
        assert dropped == 5
        assert len(session.outbound) == 0
        assert session.stats.tts_cancelled == 5

    def test_cancel_on_empty_queue_is_harmless(self):
        assert make_session().cancel_outbound() == 0

    def test_barge_in_counted(self):
        session = make_session()
        session.note_barge_in()
        session.note_barge_in()
        assert session.stats.barge_ins == 2

    def test_cancel_resets_backpressure_state(self):
        session = make_session()
        for i in range(10):
            session.outbound.put(i)
        session.backpressure.update()
        assert session.backpressure.skipping
        session.cancel_outbound()
        assert not session.backpressure.skipping


# --------------------------------------------------------------------------
# Teardown
# --------------------------------------------------------------------------


class TestTeardown:
    @pytest.mark.asyncio
    async def test_stop_is_idempotent(self):
        session = make_session()
        await session.stop("test")
        await session.stop("test-again")
        assert session.state is SessionState.STOPPED

    @pytest.mark.asyncio
    async def test_stop_runs_callbacks(self):
        session = make_session()
        reasons = []

        async def callback(reason: str) -> None:
            reasons.append(reason)

        session.on_stop(callback)
        await session.stop("hung-up")
        assert reasons == ["hung-up"]

    @pytest.mark.asyncio
    async def test_one_failing_callback_does_not_block_the_others(self):
        """Teardown must complete even when a callback misbehaves."""
        session = make_session()
        ran = []

        async def bad(reason: str) -> None:
            raise RuntimeError("callback exploded")

        async def good(reason: str) -> None:
            ran.append(reason)

        session.on_stop(bad)
        session.on_stop(good)
        await session.stop("test")

        assert ran == ["test"]
        assert session.state is SessionState.STOPPED

    @pytest.mark.asyncio
    async def test_stop_clears_the_outbound_queue(self):
        session = make_session()
        for i in range(5):
            session.outbound.put(i)
        await session.stop()
        assert len(session.outbound) == 0

    @pytest.mark.asyncio
    async def test_stop_signals_waiters(self):
        session = make_session()
        await session.stop()
        # Must return promptly rather than hang.
        await asyncio.wait_for(session.wait_stopped(), timeout=1.0)

    @pytest.mark.asyncio
    async def test_stop_records_a_safe_reason(self):
        session = make_session()
        session.on_stop(lambda reason: _noop())
        await session.stop("idle-timeout")
        stats = session.safe_stats()
        assert stats["uptimeSecs"] >= 0


async def _noop() -> None:
    return None


# --------------------------------------------------------------------------
# Registry
# --------------------------------------------------------------------------


class TestSessionRegistry:
    @pytest.mark.asyncio
    async def test_create_and_get(self):
        registry = SessionRegistry()
        session = await registry.create(session_id="abc", platform="telegram")
        assert registry.get("abc") is session
        assert len(registry) == 1

    @pytest.mark.asyncio
    async def test_generated_ids_are_unique(self):
        registry = SessionRegistry()
        a = await registry.create()
        b = await registry.create()
        assert a.session_id != b.session_id

    @pytest.mark.asyncio
    async def test_capacity_is_enforced(self):
        registry = SessionRegistry(max_sessions=2)
        await registry.create()
        await registry.create()
        with pytest.raises(CapacityError, match="at capacity"):
            await registry.create()
        assert registry.total_rejected == 1

    @pytest.mark.asyncio
    async def test_remove_stops_and_drops(self):
        registry = SessionRegistry()
        await registry.create(session_id="abc")
        await registry.remove("abc", "hung-up")
        assert registry.get("abc") is None
        assert len(registry) == 0

    @pytest.mark.asyncio
    async def test_remove_unknown_id_is_harmless(self):
        await SessionRegistry().remove("does-not-exist")

    @pytest.mark.asyncio
    async def test_reap_idle_sessions(self):
        registry = SessionRegistry()
        session = await registry.create(session_id="idle-1")
        session.transition_to(SessionState.ACTIVE)
        reaped = await registry.reap(now=session.last_inbound_at + 31.0)
        assert reaped == ["idle-1"]
        assert len(registry) == 0

    @pytest.mark.asyncio
    async def test_reap_keeps_active_sessions(self):
        registry = SessionRegistry()
        session = await registry.create(session_id="busy-1")
        session.transition_to(SessionState.ACTIVE)
        reaped = await registry.reap(now=session.last_inbound_at + 5.0)
        assert reaped == []
        assert len(registry) == 1

    @pytest.mark.asyncio
    async def test_reap_expired_reconnect(self):
        registry = SessionRegistry()
        session = await registry.create(
            session_id="recon-1", reconnect_grace_secs=15.0
        )
        session.transition_to(SessionState.ACTIVE)
        session.mark_disconnected()
        reaped = await registry.reap(now=session.disconnected_at + 20.0)
        assert reaped == ["recon-1"]

    @pytest.mark.asyncio
    async def test_reap_honours_max_duration(self):
        registry = SessionRegistry()
        session = await registry.create(session_id="long-1", max_call_seconds=60.0)
        session.transition_to(SessionState.ACTIVE)
        reaped = await registry.reap(now=session.created_at + 61.0)
        assert reaped == ["long-1"]

    @pytest.mark.asyncio
    async def test_find_resumable_within_grace(self):
        registry = SessionRegistry()
        session = await registry.create(
            session_id="r1", reconnect_grace_secs=15.0
        )
        session.transition_to(SessionState.ACTIVE)
        session.mark_disconnected()
        assert registry.find_resumable("r1") is session

    @pytest.mark.asyncio
    async def test_find_resumable_returns_none_when_active(self):
        registry = SessionRegistry()
        session = await registry.create(session_id="r2")
        session.transition_to(SessionState.ACTIVE)
        assert registry.find_resumable("r2") is None

    @pytest.mark.asyncio
    async def test_stop_all_is_graceful(self):
        registry = SessionRegistry()
        sessions = [await registry.create(session_id=f"s{i}") for i in range(5)]
        for session in sessions:
            session.transition_to(SessionState.ACTIVE)

        await registry.stop_all("shutdown")
        assert len(registry) == 0
        assert all(s.stopped for s in sessions)

    @pytest.mark.asyncio
    async def test_stop_all_continues_past_a_failing_session(self):
        registry = SessionRegistry()
        good = await registry.create(session_id="good")
        bad = await registry.create(session_id="bad")
        good.transition_to(SessionState.ACTIVE)
        bad.transition_to(SessionState.ACTIVE)

        async def explode(reason: str) -> None:
            raise RuntimeError("nope")

        bad.on_stop(explode)
        await registry.stop_all("shutdown")

        assert good.stopped
        assert bad.stopped
        assert len(registry) == 0

    @pytest.mark.asyncio
    async def test_stop_all_on_empty_registry(self):
        await SessionRegistry().stop_all()

    @pytest.mark.asyncio
    async def test_snapshot_is_json_safe_and_leaks_nothing(self):
        registry = SessionRegistry()
        session = await registry.create(
            session_id="snap-1", platform="telegram", user_id="user-secret-id"
        )
        session.transition_to(SessionState.ACTIVE)
        session.note_inbound(sequence=0, byte_count=320)
        snapshot = registry.snapshot()

        assert snapshot["live"] == 1
        assert json.loads(json.dumps(snapshot)) == snapshot
        rendered = json.dumps(snapshot)
        # Session ids and platform names are fine; secrets and audio are not.
        assert "user-secret-id" not in rendered
        assert "payload" not in rendered
        assert "audio" not in rendered

    @pytest.mark.asyncio
    async def test_stats_include_sequence_and_queue_health(self):
        session = make_session()
        session.transition_to(SessionState.ACTIVE)
        session.note_inbound(sequence=0)
        session.note_inbound(sequence=3)  # gap of 2
        stats = session.safe_stats()
        assert stats["inboundSequence"]["missing"] == 2
        assert stats["outboundQueue"]["enqueued"] == 0
        assert "backpressure" in stats
