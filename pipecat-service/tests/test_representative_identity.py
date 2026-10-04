"""Identity model for live calls: the person who set the call up is the speaker.

Emysa is the infrastructure. These tests pin what the model is actually TOLD
(the prompt, the opening cue, the call context, the note wrapper), because a
test cannot judge a model's wording, but it can prove nothing in the context
tells the model to be an assistant, to say it is Emysa, or to read the
caller's instruction out as "the user asked me to...".
"""

from __future__ import annotations

import asyncio
import dataclasses

import pytest

import app.call_context as cc
from app.call_context import CallContext, build_extra_context
from app.config import load_settings
from app.conversation import DEFAULT_GREETING, OPENING_CUE, OPERATOR_NOTE_PREFIX
from app.pipeline import DEFAULT_SYSTEM_PROMPT, build_system_prompt
from tests.test_conversation import caller_frame, make_conversation

ARSENAL = "Call John and ask if he remembers what he told me yesterday about the Arsenal match."


def ctx(**over) -> CallContext:
    base = dict(
        call_id="c", user_id="u", contact_id=None, contact_name="John", platform="whatsapp",
        session_id="s", to_number="+2348011112222", objective=ARSENAL, instructions="",
        status="queued", extra_context="", user_name="Ada", user_country="Nigeria",
    )
    base.update(over)
    return CallContext(**base)


def settings():
    return load_settings({
        "ASSISTANT_BRIDGE_SECRET": "x" * 32,
        "OPENAI_API_KEY": "ok_test_key_value_123456",
        "FISH_API_KEY": "fk_test_key_value_123456",
    })


class TestWhatTheModelIsTold:
    def test_the_whole_composed_prompt_never_names_the_product(self):
        full = build_system_prompt(settings(), extra_context=build_extra_context(ctx()))
        assert "Emysa" not in full

    def test_prompt_makes_the_person_the_speaker_not_an_assistant(self):
        p = " ".join(DEFAULT_SYSTEM_PROMPT.split())
        assert "speaking as the person who set this call up" in p
        assert "You are Emysa" not in p
        assert "it is never the speaker" in p

    def test_brief_is_private_intention_not_a_message_to_relay(self):
        p = " ".join(DEFAULT_SYSTEM_PROMPT.split())
        assert "not a message to relay, not a script, and not a request made to you" in p
        # the worked examples from the product brief
        assert "Tell Sarah I'm running late" in p and "Hey Sarah, I'm running a little late." in p
        assert "Arsenal" in p

    def test_assistant_openers_and_relay_phrasing_are_banned(self):
        p = " ".join(DEFAULT_SYSTEM_PROMPT.split())
        for phrase in ("What's on your mind", "How can I help", "I'm here on the phone", "the user asked"):
            assert phrase in p.split("Banned:")[1].split("If you catch yourself")[0]

    def test_where_are_you_never_becomes_an_ai_explanation(self):
        p = " ".join(DEFAULT_SYSTEM_PROMPT.split())
        assert "do not invent a place, a plan or a story, and never explain how the call works" in p

    def test_opening_cue_greeting_and_note_wrapper_are_identity_free(self):
        for text in (OPENING_CUE, DEFAULT_GREETING, OPERATOR_NOTE_PREFIX):
            low = text.lower()
            assert "emysa" not in low and "ai assistant" not in low and "on behalf" not in low
        assert "Do not introduce yourself unless your private brief says to" in OPENING_CUE
        # the system prompt recognises notes by this exact start
        assert OPERATOR_NOTE_PREFIX.startswith("[Private note")
        assert '"[Private note"' in DEFAULT_SYSTEM_PROMPT

    def test_an_operator_prompt_still_owns_the_persona(self):
        custom = build_system_prompt(dataclasses.replace(settings(), system_prompt="You are a terse PA."))
        assert "You are a terse PA." in custom and "speaking as the person" not in custom


class TestCallContextCarriesTheIdentity:
    def test_model_is_told_who_it_speaks_as_and_who_it_is_calling(self):
        text = build_extra_context(ctx())
        assert "You are speaking as Ada." in text
        assert "say your name plainly" in text
        assert "You are calling: John." in text

    def test_instruction_is_labelled_a_private_brief_never_a_user_request(self):
        text = build_extra_context(ctx(instructions="Keep it light"))
        assert "Your private brief for this call" in text and ARSENAL in text
        assert "not a message to relay or a script to read" in text
        assert "More private detail for your brief: Keep it light" in text
        assert "from the user" not in text

    def test_country_is_not_presented_as_current_location(self):
        text = build_extra_context(ctx())
        assert "Your country: Nigeria." in text
        assert "not where you are right now" in text
        assert "do not know your current location" in text.replace("You do not know", "do not know")

    def test_unknown_name_and_country_are_never_invented(self):
        text = build_extra_context(ctx(user_name="", user_country=""))
        assert "Their name is not on file, so do not invent one" in text
        assert "do not know where you are right now" in text
        assert "Ada" not in text and "Nigeria" not in text


class FakeRest:
    def __init__(self, rows=None, fail_when=None):
        self.rows, self.fail_when, self.selects = rows or [], fail_when or (lambda cols: False), []

    async def select(self, table, *, select, filters, limit=None, order=None):
        self.selects.append(select)
        if self.fail_when(select):
            raise RuntimeError("column profiles.country does not exist")
        return self.rows


class TestProfileFetch:
    def test_reads_name_country_and_language(self):
        rest = FakeRest([{"language": "yo", "name": " Ada ", "country": "NG"}])
        assert asyncio.run(cc._fetch_profile(rest, user_id="u")) == {"language": "yo", "name": "Ada", "country": "NG"}

    def test_unmigrated_country_column_does_not_lose_the_name_or_language(self):
        rest = FakeRest([{"language": "fr", "name": "Ada"}], fail_when=lambda cols: "country" in cols)
        got = asyncio.run(cc._fetch_profile(rest, user_id="u"))
        assert got == {"language": "fr", "name": "Ada", "country": ""}
        assert rest.selects == ["language,name,country", "language,name"]

    def test_total_failure_falls_back_to_english_and_no_identity(self):
        rest = FakeRest(fail_when=lambda cols: True)
        assert asyncio.run(cc._fetch_profile(rest, user_id="u")) == {"language": "en", "name": "", "country": ""}


class TestRealOpeningOnTheWire:
    async def test_llm_receives_a_person_opening_not_an_emysa_intro(self):
        # No ASSISTANT_GREETING: the model opens the call itself from the brief.
        conv, _, _, llm = make_conversation(greeting="")
        await conv.start()
        try:
            await conv.note_call_active("relay-signal")
            for _ in range(20):
                await conv.push_audio(caller_frame())
                await asyncio.sleep(0.02)
            await asyncio.sleep(1.0)
            assert llm.contexts, "the model was never asked to open the call"
            first = llm.contexts[0]
            assert first[-1] == OPENING_CUE or OPENING_CUE in first
            assert not any("Emysa" in (m or "") for m in first), "the identity leaked into the context"
        finally:
            await conv.stop("test")
