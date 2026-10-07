"""Reviewed per-contact memory on a live call (sql/026_contact_memory.sql).

The call service uses the service role, which bypasses RLS, so isolation here
rests on the query filters and on re-checking every returned row.
"""

import app.call_context as cc
from app.call_context import CallContext, build_extra_context

USER_A = "11111111-1111-1111-1111-111111111111"
USER_B = "22222222-2222-2222-2222-222222222222"


class RecordingRest:
    def __init__(self, rows_by_table):
        self.rows_by_table = rows_by_table
        self.calls = []

    async def select(self, table, *, select, filters, limit=None, order=None):
        self.calls.append((table, dict(filters)))
        return list(self.rows_by_table.get(table, []))


def memory(text, *, kind="preferences", status="approved", user=USER_A, contact="c-a", updated="2024-03-01"):
    return {
        "user_id": user, "contact_id": contact, "memory_type": kind,
        "memory_text": text, "status": status, "updated_at": updated,
    }


class TestFetchContactMemory:
    async def test_only_approved_and_edited_are_used(self):
        rest = RecordingRest({"contact_memories": [
            memory("Approved fact", status="approved"),
            memory("Edited fact", status="edited"),
            memory("Unreviewed guess", status="candidate"),
            memory("Rejected fact", status="rejected"),
        ]})
        lines = await cc._fetch_contact_memory(rest, user_id=USER_A, contact_id="c-a", session_id="s")
        assert sorted(lines) == ["Preferences: Approved fact", "Preferences: Edited fact"]

    async def test_query_is_pinned_to_user_and_contact_and_status(self):
        rest = RecordingRest({"contact_memories": []})
        await cc._fetch_contact_memory(rest, user_id=USER_A, contact_id="c-a", session_id="s")
        (table, filters), = rest.calls
        assert table == "contact_memories"
        assert filters["user_id"] == f"eq.{USER_A}"
        assert filters["contact_id"] == "eq.c-a"
        assert filters["status"] == "in.(approved,edited)"

    async def test_rows_of_another_user_or_contact_are_dropped_even_if_the_query_returned_them(self):
        rest = RecordingRest({"contact_memories": [
            memory("Mine", user=USER_A, contact="c-a"),
            memory("Another user's note about the same contact id", user=USER_B, contact="c-a"),
            memory("Same user, different contact", user=USER_A, contact="c-z"),
        ]})
        lines = await cc._fetch_contact_memory(rest, user_id=USER_A, contact_id="c-a", session_id="s")
        assert lines == ["Preferences: Mine"]

    async def test_nothing_is_queried_without_both_ids(self):
        rest = RecordingRest({"contact_memories": [memory("x")]})
        assert await cc._fetch_contact_memory(rest, user_id=USER_A, contact_id=None, session_id="s") == []
        assert await cc._fetch_contact_memory(rest, user_id="", contact_id="c-a", session_id="s") == []
        assert rest.calls == []

    async def test_secrets_are_never_spoken(self):
        secrets = ["password is hunter2", "your code is 482913", "pin 4821", "account number 0123456789", "IBAN GB82WEST12345698765432"]
        rest = RecordingRest({"contact_memories": [memory(s) for s in secrets] + [memory("Likes tea"), memory("Birthday is on 5 May")]})
        lines = await cc._fetch_contact_memory(rest, user_id=USER_A, contact_id="c-a", session_id="s")
        assert sorted(lines) == ["Preferences: Birthday is on 5 May", "Preferences: Likes tea"]

    async def test_important_things_first_and_the_block_is_capped(self):
        rows = [memory(f"Trivia {i} " + "word " * 12, kind="previous_context") for i in range(60)]
        rows.append(memory("Does not want calls before 10am", kind="caller_preferences"))
        rest = RecordingRest({"contact_memories": rows})
        lines = await cc._fetch_contact_memory(rest, user_id=USER_A, contact_id="c-a", session_id="s")
        assert lines[0] == "On calls: Does not want calls before 10am"
        assert len(lines) <= cc._CONTACT_MEMORY_MAX_ITEMS
        assert sum(len(line) for line in lines) <= cc._CONTACT_MEMORY_MAX_CHARS

    async def test_a_database_error_never_breaks_the_call(self):
        class Boom:
            async def select(self, *a, **k):
                raise RuntimeError("down")
        assert await cc._fetch_contact_memory(Boom(), user_id=USER_A, contact_id="c-a", session_id="s") == []


class TestResolveContactByNumber:
    CONTACTS = [
        {"id": "c-a", "user_id": USER_A, "phone_number": "+234 801 234 5678"},
        {"id": "c-b", "user_id": USER_A, "phone_number": "+14155552671"},
    ]

    async def test_exact_digits_match_regardless_of_formatting(self):
        rest = RecordingRest({"contacts": self.CONTACTS})
        assert await cc._resolve_contact_by_number(rest, user_id=USER_A, number="+2348012345678", session_id="s") == "c-a"
        assert await cc._resolve_contact_by_number(rest, user_id=USER_A, number="2348012345678", session_id="s") == "c-a"

    async def test_lookup_is_scoped_to_the_users_own_contacts(self):
        rest = RecordingRest({"contacts": self.CONTACTS})
        await cc._resolve_contact_by_number(rest, user_id=USER_A, number="+2348012345678", session_id="s")
        assert rest.calls == [("contacts", {"user_id": f"eq.{USER_A}"})]

    async def test_another_users_contact_is_never_matched_even_if_returned(self):
        rest = RecordingRest({"contacts": [{"id": "c-x", "user_id": USER_B, "phone_number": "+2348012345678"}]})
        assert await cc._resolve_contact_by_number(rest, user_id=USER_A, number="+2348012345678", session_id="s") is None

    async def test_no_partial_or_suffix_match(self):
        rest = RecordingRest({"contacts": self.CONTACTS})
        for number in ["+2348012345679", "8012345678", "+234801234567", "12345", ""]:
            assert await cc._resolve_contact_by_number(rest, user_id=USER_A, number=number, session_id="s") is None, number

    async def test_two_contacts_with_one_number_is_ambiguous(self):
        rest = RecordingRest({"contacts": self.CONTACTS + [{"id": "c-c", "user_id": USER_A, "phone_number": "+2348012345678"}]})
        assert await cc._resolve_contact_by_number(rest, user_id=USER_A, number="+2348012345678", session_id="s") is None


def make_context(**overrides) -> CallContext:
    base = dict(
        call_id="call-1", user_id=USER_A, contact_id="c-a", contact_name="Marilyn", platform="whatsapp",
        session_id="call-9", to_number="+2348012345678", objective="", instructions="", status="ringing", extra_context="",
    )
    base.update(overrides)
    return CallContext(**base)


class TestPrompt:
    def test_confirmed_notes_appear_without_their_source(self):
        context = make_context(contact_memory=["On calls: Does not want calls before 10am", "Identity: Prefers to be called Lyn"])
        prompt = build_extra_context(context)
        assert "Does not want calls before 10am" in prompt
        assert "Prefers to be called Lyn" in prompt
        assert "never say where they came from" in prompt

    def test_no_notes_means_no_section(self):
        assert "Notes about this person" not in build_extra_context(make_context())
