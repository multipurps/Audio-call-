"""The owner's private chat, the call brief and the recipient are kept apart on the live model."""

import app.call_context as cc
from app.call_context import CallContext, build_extra_context
from app.live import build_live_system_prompt
from app.config import Settings

USER = "11111111-1111-1111-1111-111111111111"


class Rest:
    def __init__(self, rows):
        self.rows, self.calls = rows, []

    async def select(self, table, *, select, filters, limit=None, order=None):
        self.calls.append((table, dict(filters)))
        return list(self.rows.get(table, []))


def ctx(**kw):
    base = dict(call_id="c1", user_id=USER, contact_id="matthew", contact_name="Matthew", platform="phone",
                session_id="call-1", to_number="+2348000000000", objective="Tell Matthew what I do.",
                instructions="Tell Matthew what I do.", status="in_progress", extra_context="")
    base.update(kw)
    return CallContext(**base)


def test_boundary_rules_reach_the_live_prompt():
    c = ctx()
    c.extra_context = build_extra_context(c)
    prompt = build_live_system_prompt(Settings(), c.extra_context, c)
    assert "was not part of it and has not said or asked anything yet" in prompt
    assert "Never invent an earlier conversation" in prompt
    assert "Tell Matthew what I do." in prompt


def test_owner_question_is_not_a_recipient_statement():
    c = ctx(objective="Explain what I do", instructions="Explain what I do")
    prompt = build_live_system_prompt(Settings(), build_extra_context(c), c)
    assert "Explain what I do" in prompt
    assert "has not said or asked anything yet" in prompt


def test_reviewed_contact_notes_reach_the_live_model():
    c = ctx(contact_memory=["Preferences: calls after 10am"])
    prompt = build_live_system_prompt(Settings(), build_extra_context(c), c)
    assert "calls after 10am" in prompt


async def test_recipient_memories_are_scoped_to_the_contact_and_owner_rows_are_dropped():
    rows = {"memories": [
        {"content": "Matthew likes tea", "contact_id": "matthew", "user_id": USER, "updated_at": "2026-09-01"},
        {"content": "Owner asked what Emysa does", "contact_id": None, "user_id": USER, "updated_at": "2026-09-02"},
        {"content": "Sarah likes coffee", "contact_id": "sarah", "user_id": USER, "updated_at": "2026-09-02"},
    ]}
    out = await cc._fetch_memories(Rest(rows), user_id=USER, contact_id="matthew", session_id="s")
    assert len(out) == 1 and out[0].startswith("Matthew likes tea")


async def test_a_later_call_retrieves_only_that_contacts_memories_and_summaries():
    rest = Rest({"calls": [{"outcome_summary": "I told Matthew what I do.", "created_at": "2026-09-01"}]})
    out = await cc._fetch_prior_summaries(rest, user_id=USER, contact_id="matthew", session_id="s")
    assert out == ["I told Matthew what I do."]
    _, filters = rest.calls[0]
    assert filters["contact_id"] == "eq.matthew" and filters["user_id"] == f"eq.{USER}"
    assert filters["summary_status"] == "eq.completed"
