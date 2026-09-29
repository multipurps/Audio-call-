"""Unit tests for the app-database call context (MOCKED, no network).

These are mocked-verification tests: they exercise resolution logic,
transcript dedupe/flush semantics, status transitions and the end-of-call
report *against fakes*, which is exactly what they are — they prove the
wiring and the guards, NOT that a real WhatsApp call completes end to end.
Real-call verification remains a manual step (see docs).
"""

from __future__ import annotations

import asyncio

import pytest

import app.call_context as cc
from app.call_context import CallContext, TranscriptLog, resolve_call_context
from app.config import Settings


class FakeRest:
    """Stands in for the PostgREST client; records every write."""

    def __init__(self, rows_by_table: dict[str, list[dict]] | None = None) -> None:
        self.rows_by_table = rows_by_table or {}
        self.patches: list[tuple[str, dict, dict]] = []
        self.select_calls: list[tuple[str, dict]] = []

    async def select(self, table, *, select, filters, limit=None, order=None):
        self.select_calls.append((table, dict(filters)))
        return self.rows_by_table.get(table, [])

    async def patch(self, table, *, match, body):
        self.patches.append((table, dict(match), dict(body)))

    async def aclose(self):
        return None


def make_context(rest: FakeRest | None = None, **overrides) -> CallContext:
    base = dict(
        call_id="call-uuid-1",
        user_id="user-uuid-1",
        contact_id="contact-uuid-1",
        contact_name="Alex",
        platform="whatsapp",
        session_id="call-platform-id-9",
        to_number="+14155552671",
        objective="Confirm lunch at noon",
        instructions="Keep it friendly",
        status="ringing",
        extra_context="",
        _rest=rest or FakeRest(),
    )
    base.update(overrides)
    return CallContext(**base)


class TestResolveDisabledWithoutCreds:
    async def test_mock_mode_returns_none(self):
        settings = Settings(mock_mode=True, bridge_secret="x" * 32)
        assert (
            await resolve_call_context(
                settings, session_id="call-abc", platform="whatsapp", user_id="u1"
            )
            is None
        )

    async def test_missing_supabase_returns_none(self):
        settings = Settings(bridge_secret="x" * 32, supabase_url=None)
        assert (
            await resolve_call_context(
                settings, session_id="call-abc", platform="whatsapp", user_id="u1"
            )
            is None
        )


class TestResolveFindsRow:
    async def test_row_found_and_context_built(self, monkeypatch):
        settings = Settings(
            bridge_secret="x" * 32,
            supabase_url="https://example.supabase.co",
            supabase_service_role_key="service-key-value",
            enable_persistent_memory=True,
            context_timeout_secs=2.0,
        )
        fake = FakeRest(
            {
                "calls": [
                    {
                        "id": "call-uuid-1",
                        "user_id": "user-uuid-1",
                        "contact_id": "contact-uuid-1",
                        "to_number": "+14155552671",
                        "objective": "Confirm lunch at noon",
                        "instructions": "Be friendly",
                        "status": "ringing",
                        "platform": "whatsapp",
                        "session_id": "chat-1",
                        "outcome_summary": None,
                        "created_at": "2026-09-29T10:00:00+00:00",
                    }
                ],
                "contacts": [{"name": "Alex"}],
                "memories": [
                    {
                        "content": "Prefers the window table",
                        "memory_type": "semantic",
                        "contact_id": "contact-uuid-1",
                        "created_at": "2026-09-28T10:00:00+00:00",
                    },
                    {
                        "content": "password: hunter2",
                        "memory_type": "semantic",
                        "contact_id": None,
                        "created_at": "2026-09-27T10:00:00+00:00",
                    },
                ],
                "calls_summaries": [],
            }
        )

        def fake_rest(*args, **kwargs):
            return fake

        async def fake_summaries(*args, **kwargs):
            return ["Last time you confirmed the lunch."]

        monkeypatch.setattr(cc, "_Rest", fake_rest)
        monkeypatch.setattr(cc, "_fetch_prior_summaries", fake_summaries)

        context = await resolve_call_context(
            settings, session_id="call-platform-id-9", platform="whatsapp", user_id="user-uuid-1"
        )
        assert context is not None
        assert context.call_id == "call-uuid-1"
        assert context.contact_name == "Alex"
        # Objective and instructions both surface in the prompt context.
        assert "Confirm lunch at noon" in context.extra_context
        assert "Be friendly" in context.extra_context
        # Secret-looking memory content is filtered out on read.
        assert "window table" in context.extra_context
        assert "hunter2" not in context.extra_context
        assert "Last time you confirmed the lunch." in context.extra_context


class TestStatusTransitions:
    async def test_in_progress_only_from_queued_or_ringing(self):
        rest = FakeRest({"calls": [{"status": "ringing"}]})
        ctx = make_context(rest=rest)
        await ctx.set_in_progress()
        assert rest.patches and rest.patches[0][2] == {"status": "in_progress"}

        rest2 = FakeRest({"calls": [{"status": "completed"}]})
        ctx2 = make_context(rest=rest2)
        await ctx2.set_in_progress()
        assert rest2.patches == []

    async def test_happens_once_even_if_called_twice(self):
        rest = FakeRest({"calls": [{"status": "ringing"}]})
        ctx = make_context(rest=rest)
        await ctx.set_in_progress()
        await ctx.set_in_progress()
        assert len([p for p in rest.patches if p[0] == "calls"]) == 1


class TestTranscriptLog:
    async def test_dedupe_and_flush_full_array(self):
        rest = FakeRest()
        ctx = make_context(rest=rest)
        log = TranscriptLog(ctx, debounce_secs=0.01)
        log.note("contact", "hello there")
        log.note("contact", "hello there")  # immediate repeat: dropped
        log.note("ai", "Hi Alex, about lunch")
        await log.close()
        entries = rest.patches[0][2]["transcript"]
        assert [e["speaker"] for e in entries] == ["contact", "ai"]
        assert all(e.get("at") for e in entries)
        # Final close flush wrote the whole array (idempotent write).
        assert rest.patches[-1][2]["transcript"] == entries

    async def test_debounced_write_happens_while_call_is_live(self):
        rest = FakeRest()
        ctx = make_context(rest=rest)
        log = TranscriptLog(ctx, debounce_secs=0.01)
        log.note("contact", "first turn")
        await asyncio.sleep(0.1)
        assert log.writes >= 1
        await log.close()

    async def test_interruption_flag_recorded(self):
        rest = FakeRest()
        ctx = make_context(rest=rest)
        log = TranscriptLog(ctx, debounce_secs=0.01)
        log.note("ai", "and then I thought", interrupted=True)
        await log.close()
        assert rest.patches[0][2]["transcript"][0]["interrupted"] is True

    async def test_notes_after_close_are_ignored(self):
        rest = FakeRest()
        ctx = make_context(rest=rest)
        log = TranscriptLog(ctx, debounce_secs=0.01)
        await log.close()
        log.note("contact", "too late")
        assert rest.patches == []


class TestEndReport:
    async def test_skips_when_carrier_already_reported(self, monkeypatch):
        monkeypatch.setattr(cc, "END_REPORT_DELAY_SECS", 0.0)
        rest = FakeRest({"calls": [{"status": "completed"}]})
        ctx = make_context(rest=rest)
        settings = Settings(bridge_secret="x" * 32, public_app_url="https://app.example")
        # No httpx client should even be reached: report_end re-checks status.
        await ctx.report_end(settings=settings, status="completed", duration_seconds=42, active=True)
        assert rest.patches == []

    async def test_direct_patch_when_no_app_url(self, monkeypatch):
        monkeypatch.setattr(cc, "END_REPORT_DELAY_SECS", 0.0)
        rest = FakeRest({"calls": [{"status": "in_progress"}]})
        ctx = make_context(rest=rest, platform="phone")
        settings = Settings(bridge_secret="x" * 32)
        await ctx.report_end(settings=settings, status="completed", duration_seconds=42, active=True)
        assert rest.patches[0][2]["status"] == "completed"
        assert rest.patches[0][2]["duration_seconds"] == 42
        assert rest.patches[0][2]["ended_at"]

    async def test_platform_phone_never_posts_to_app(self, monkeypatch):
        monkeypatch.setattr(cc, "END_REPORT_DELAY_SECS", 0.0)
        # relay-call-status accepts whatsapp/telegram only; other platforms
        # must take the direct-write path even when an app URL is set.
        rest = FakeRest({"calls": [{"status": "in_progress"}]})
        ctx = make_context(rest=rest, platform="phone")
        settings = Settings(
            bridge_secret="x" * 32, public_app_url="http://127.0.0.1:9"
        )
        await ctx.report_end(settings=settings, status="failed", duration_seconds=0, active=False)
        assert rest.patches and rest.patches[0][2]["status"] == "failed"


def test_session_id_candidates_strip_call_prefix():
    assert cc._session_id_candidates("call-abc-123") == ["call-abc-123", "abc-123"]
    assert cc._session_id_candidates("abc-123") == ["abc-123"]
