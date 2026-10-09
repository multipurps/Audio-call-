"""Retry/attempt context, prior-call hygiene, memory scoping, and instruction integrity."""

import asyncio

import pytest

import app.call_context as cc
from app.call_context import CallContext, build_extra_context
from app.call_state import (
    AttemptContext, AttemptFact, derive_attempts, in_chain, is_diagnostic_text, is_retry_command, render_attempt_lines,
)
from app.config import load_settings
from app.conversation_policy import (
    audit_reply, build_structured_live_prompt, instructions_fingerprint, validate_live_instructions,
)
from app.live import build_live_system_prompt, lock_live_instructions

ENV = {"ASSISTANT_BRIDGE_SECRET": "x" * 32, "OPENAI_API_KEY": "sk-test-key-value-123456", "FISH_API_KEY": "fk_test_key_value_123456"}
U = "11111111-1111-1111-1111-111111111111"


class Rest:
    def __init__(self, tables):
        self.tables = tables
        self.calls = []

    async def select(self, table, *, select, filters, limit=None, order=None):
        self.calls.append((table, dict(filters), select))
        rows = self.tables.get(table, [])
        if isinstance(rows, Exception):
            raise rows
        return list(rows)


def _ctx(**kw):
    base = dict(call_id="c2", user_id=U, contact_id="k1", contact_name="Sam", platform="whatsapp", session_id="call-2",
                to_number="+2348000000001", objective="Ask about the invoice", instructions="", status="in_progress",
                extra_context="", user_name="Ada")
    base.update(kw)
    return CallContext(**base)


# ------------------------------------------------------------- attempt facts

def test_missing_events_are_unknown_never_failed_or_not_rung():
    f = derive_attempts([{"id": "c1", "status": "no_answer", "attempt_number": 1, "attempt_events": []}], current_id="c2")[0]
    assert f.rang is None and f.outcome == "unknown" and not f.answered


def test_only_a_recorded_ringing_event_supports_unanswered():
    f = derive_attempts([{"id": "c1", "status": "no_answer", "attempt_events": [{"state": "ringing"}]}], current_id="c2")[0]
    assert f.rang is True and f.outcome == "unanswered"


def test_current_call_and_other_chains_are_excluded():
    rows = [{"id": "c2", "retry_of": "c1"}, {"id": "c1"}, {"id": "zz", "retry_of": "other"}]
    chain = [r for r in rows if in_chain(r, root_id="c1", current_id="c2")]
    assert [r["id"] for r in chain] == ["c1"]
    assert [a.call_id for a in derive_attempts(chain, current_id="c2")] == ["c1"]


def test_stale_events_from_the_previous_attempt_stay_on_that_attempt():
    prev = {"id": "c1", "status": "failed", "attempt_events": [{"state": "ringing"}, {"state": "failed"}]}
    cur_events = []  # attempt 2 has its own, empty list
    assert derive_attempts([prev], current_id="c2")[0].states == ("ringing", "failed")
    assert cur_events == []


def test_attempt_lines_never_explain_or_assert_a_cause():
    for outcome_row in (
        {"id": "c1", "status": "failed", "attempt_events": []},
        {"id": "c1", "status": "no_answer", "attempt_events": [{"state": "ringing"}]},
        {"id": "c1", "status": "rejected", "attempt_events": []},
    ):
        text = " ".join(render_attempt_lines(2, derive_attempts([outcome_row], current_id="c2")))
        assert "attempt 2" in text
        assert "do not mention it unless they do" in text.lower()
        assert "never ask whether they have or have set up the app" in text.lower()
        for bad in ("whatsapp is not connected", "not registered", "link it in profile", "isn't on whatsapp"):
            assert bad not in text.lower()


def test_first_attempt_has_no_attempt_lines():
    assert render_attempt_lines(1, []) == []


def test_diagnostics_and_retry_commands_are_recognised():
    assert is_diagnostic_text("Couldn't connect: WhatsApp is not connected — link it in Profile first.")
    assert is_diagnostic_text("The call never rang on their side. Check that they have WhatsApp")
    assert not is_diagnostic_text("I spoke with Sam about Friday.")
    assert is_retry_command("Try again") and is_retry_command("call him again") and not is_retry_command("Ask about Friday")


# ------------------------------------------------------- context construction

def test_attempt_lines_reach_both_prompt_builders_and_exclude_account_state():
    ctx = _ctx(attempt=AttemptContext(attempt_number=2, retry_of="c1", previous=derive_attempts(
        [{"id": "c1", "status": "failed", "attempt_events": []}], current_id="c2")))
    extra = build_extra_context(ctx)
    prompt = build_structured_live_prompt(persona="P", personality="Q", policies="", end_call_tool="end_call", call_context=ctx)
    for text in (extra, prompt):
        assert "attempt 2" in text
        assert "not connected" not in text.lower() and "reconnect" not in text.lower() and "link it" not in text.lower()


async def test_prior_summaries_exclude_failed_attempts_current_call_and_diagnostics():
    rest = Rest({"calls": [
        {"outcome_summary": "I spoke with Sam about Friday.", "created_at": "2026-10-01"},
        {"outcome_summary": "Couldn't connect: WhatsApp is not connected — link it in Profile first.", "created_at": "2026-10-02"},
        {"outcome_summary": "The call to Sam did not connect. It never rang on their side. Check that they have WhatsApp", "created_at": "2026-10-03"},
    ]})
    out = await cc._fetch_prior_summaries(rest, user_id=U, contact_id="k1", session_id="s", exclude_call_id="c2")
    assert out == ["I spoke with Sam about Friday."]
    _, filters, _ = rest.calls[0]
    assert filters["summary_status"] == "eq.completed" and filters["status"] == "eq.completed" and filters["id"] == "neq.c2"


async def test_attempt_context_reads_only_the_retry_chain():
    rest = Rest({"calls": [
        {"id": "c1", "status": "no_answer", "created_at": "2099-01-01T00:00:00Z", "attempt_number": 1, "attempt_events": [{"state": "ringing"}], "retry_of": None},
        {"id": "c2", "status": "queued", "created_at": "2099-01-01T00:05:00Z", "attempt_number": 2, "attempt_events": [], "retry_of": "c1"},
        {"id": "x", "status": "failed", "created_at": "2099-01-01T00:01:00Z", "attempt_number": 1, "attempt_events": [], "retry_of": "unrelated"},
    ]})
    row = {"id": "c2", "retry_of": "c1", "attempt_number": 2}
    attempt = await cc._fetch_attempt_context(rest, user_id=U, row=row, session_id="s")
    assert attempt.attempt_number == 2
    assert [a.call_id for a in attempt.previous] == ["c1"]


async def test_first_call_does_not_query_attempts():
    rest = Rest({})
    attempt = await cc._fetch_attempt_context(rest, user_id=U, row={"id": "c1"}, session_id="s")
    assert attempt.attempt_number == 1 and attempt.previous == [] and rest.calls == []


async def test_unmigrated_database_degrades_instead_of_losing_the_call_row():
    class Legacy(Rest):
        async def select(self, table, *, select, filters, limit=None, order=None):
            if "attempt_events" in select:
                raise RuntimeError("column calls.attempt_events does not exist")
            return [{"id": "c1", "user_id": U}]
    row = await cc._find_call_row(Legacy({}), session_id="call-abc", platform="whatsapp")
    assert row == {"id": "c1", "user_id": U}


# --------------------------------------------------------------- memory scope

def _mem(text, *, contact="k1", user=U, status="confirmed", updated="2026-10-08T00:00:00Z"):
    return {"content": text, "memory_type": "semantic", "contact_id": contact, "user_id": user, "status": status,
            "created_at": updated, "updated_at": updated}


async def test_memories_need_a_contact_and_never_include_other_contacts_or_owners():
    rest = Rest({"memories": [_mem("Lives in Lagos"), _mem("Lives in Abuja", contact="k2"), _mem("Other owner's fact", user="u-other")]})
    assert await cc._fetch_memories(rest, user_id=U, contact_id=None, session_id="s") == []
    lines = await cc._fetch_memories(rest, user_id=U, contact_id="k1", session_id="s")
    assert len(lines) == 1 and lines[0].startswith("Lives in Lagos (")
    _, filters, _ = rest.calls[0]
    assert filters["contact_id"] == "eq.k1" and filters["status"] == "eq.confirmed" and filters["user_id"] == f"eq.{U}"


async def test_memory_lines_say_how_recent_they_are_and_drop_diagnostics():
    rest = Rest({"memories": [_mem("Prefers voice notes", updated="2024-01-01T00:00:00Z"), _mem("WhatsApp is not connected")]})
    lines = await cc._fetch_memories(rest, user_id=U, contact_id="k1", session_id="s")
    assert lines == ["Prefers voice notes (over a year ago)"]


async def test_memory_failure_is_non_fatal_and_returns_nothing():
    rest = Rest({"memories": RuntimeError("boom")})
    assert await cc._fetch_memories(rest, user_id=U, contact_id="k1", session_id="s") == []


# ---------------------------------------------------- instruction integrity

def _prompt():
    return build_live_system_prompt(load_settings(ENV), None, _ctx())


def test_built_prompt_validates_and_has_no_legacy_reaction_directives():
    p = _prompt()
    assert validate_live_instructions(p) == []
    for legacy in ("React first", "Mm, yeah", 'a quiet "Hmm."', "Use small fillers"):
        assert legacy not in p


def test_validation_catches_missing_sections_and_legacy_text():
    assert validate_live_instructions("just be friendly")
    assert any("legacy" in x for x in validate_live_instructions(_prompt() + "\nReact first, then add."))


@pytest.mark.parametrize("reply,kind", [
    ("Give me a sec, let me check.", "narration"), ("What's on your mind?", "generic-opener"),
    ("Got it.", "acknowledgement"), ("Hmm, okay", "acknowledgement"), ("I understand.", "acknowledgement"),
    ("Yeaah", "acknowledgement"), ("Perfect, thanks", "acknowledgement"),
])
def test_audit_flags_every_banned_pattern(reply, kind):
    assert any(v.startswith(kind) for v in audit_reply(reply))


def test_audit_leaves_direct_answers_alone():
    assert audit_reply("Friday at six, yes.") == [] and audit_reply("How late are we talking?") == []


class FakeLLM:
    def __init__(self, instructions):
        self.sent = instructions
        self.updates = []

    async def _update_settings(self, delta):
        self.updates.append(delta)
        from pipecat.services.settings import is_given

        if is_given(getattr(delta, "system_instruction", None)):
            self.sent = delta.system_instruction
        return {}

    def _invocation_params(self):
        return {"instructions": self.sent}


def test_later_session_updates_cannot_silently_replace_the_instructions():
    from pipecat.services.settings import NOT_GIVEN

    prompt = _prompt()
    llm = lock_live_instructions(FakeLLM(prompt), prompt, "s1")
    assert llm._emysa_instruction_fingerprint == instructions_fingerprint(prompt)

    class Delta:
        system_instruction = "You are a helpful assistant. How can I help?"

    d = Delta()
    asyncio.run(llm._update_settings(d))
    assert d.system_instruction is NOT_GIVEN
    assert llm.sent == prompt


def test_divergent_instructions_are_restored_at_the_point_they_are_sent():
    prompt = _prompt()
    llm = lock_live_instructions(FakeLLM(prompt), prompt, "s1")
    llm.sent = "You are a helpful assistant."
    assert llm._invocation_params()["instructions"] == prompt
    llm.sent = prompt + "\n\n(service addendum)"  # an addendum around the locked text is fine
    assert llm._invocation_params()["instructions"].startswith(prompt)


def test_an_invalid_prompt_cannot_start_a_session():
    with pytest.raises(RuntimeError):
        lock_live_instructions(FakeLLM("x"), "You are a helpful assistant.", "s1")
