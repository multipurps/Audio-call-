"""Conversational behaviour policy for GPT-Live (app/conversation_policy.py)."""

import re

import pytest

from app.call_context import CallContext, build_extra_context
from app.config import load_settings
from app.conversation_policy import (
    AUTOMATIC_ACKNOWLEDGEMENTS,
    CALLER_CASUAL,
    CALLER_FRUSTRATED,
    CALLER_URGENT,
    SECTION_ORDER,
    acknowledgement_opener,
    classify_caller_state,
    find_automatic_acknowledgements,
    split_style_instructions,
)
from app.live import END_CALL_TOOL, build_live_system_prompt, opening_cue

ENV = {
    "ASSISTANT_BRIDGE_SECRET": "x" * 32,
    "OPENAI_API_KEY": "sk-test-key-value-123456",
    "FISH_API_KEY": "fk_test_key_value_123456",
}


def _settings():
    return load_settings(ENV)


def _ctx(objective="Tell Sam the venue is booked for Friday at six.", instructions="", **kw):
    base = dict(
        call_id="c1", user_id="u1", contact_id="k1", contact_name="Sam", platform="whatsapp",
        session_id="call-1", to_number="+15550001111", objective=objective, instructions=instructions,
        status="in_progress", extra_context="", user_name="Ada",
    )
    base.update(kw)
    ctx = CallContext(**base)
    return ctx


def _prompt(ctx=None):
    ctx = ctx or _ctx()
    return build_live_system_prompt(_settings(), build_extra_context(ctx), ctx)


def _section(prompt, heading, nxt):
    start = prompt.index(heading)
    end = prompt.index(nxt) if nxt else len(prompt)
    return prompt[start:end]


# ---------------------------------------------------------------- structure

def test_sections_appear_in_the_required_order():
    p = _prompt()
    positions = [p.index(h) for h in SECTION_ORDER]
    assert positions == sorted(positions)
    assert all(p.count(h) == 1 for h in SECTION_ORDER)


# ------------------------------------------------ repetitive acknowledgement

def test_prompt_no_longer_trains_reflex_reactions():
    p = _prompt()
    # The old persona said the whole turn is often just a reaction, with stock examples.
    assert "Often the whole turn is just a reaction" not in p
    assert '"Mm, yeah."' not in p
    # The old backchannel policy asked for "mm"/"yeah" while they talk.
    assert 'light, occasional backchannels ("mm", "yeah")' not in p
    assert "Mostly stay quiet while they are telling you something" in p


def test_acknowledgement_phrases_are_limited_but_not_banned():
    rules = _section(_prompt(), "PRIVATE BEHAVIOR RULES", "CALL OBJECTIVE")
    for phrase in AUTOMATIC_ACKNOWLEDGEMENTS:
        assert f'"{phrase}"' in rules, phrase
    flat = " ".join(rules.split())
    assert "are not banned" in flat and "never a reflex" in flat
    assert "Do not acknowledge every statement" in flat
    assert "Do not use filler to cover a pause" in flat
    assert "A brief silence is fine" in flat
    assert "Do not agree just because they said something" in flat


def test_audit_flags_reflexive_acknowledgements_across_replies():
    reflex = ["I see.", "Perfect, thanks.", "I see. And the date?", "Great.", "I see.", "Good."]
    assert "i see" in find_automatic_acknowledgements(reflex)
    healthy = ["Friday at six, yes.", "How late are we talking?", "I had Friday. Did something move?", "Hmm, not sure. Probably eight?"]
    assert find_automatic_acknowledgements(healthy) == []
    # A single genuine use is allowed.
    assert find_automatic_acknowledgements(["Okay, one sec.", "Perfect, that works.", "Friday then.", "Yeah."]) == []
    assert acknowledgement_opener("I understand your frustration") == "i understand"
    assert acknowledgement_opener("Friday works") is None


# ------------------------------------------------------ instruction leakage

RAW = "Keep it casual, don't rush, keep calm, keep it smart, exchange pleasantries, and tell Sam the venue is booked for Friday at six."


def test_style_instructions_become_controls_and_leave_only_the_task():
    split = split_style_instructions(RAW)
    assert split.remaining == "tell Sam the venue is booked for Friday at six."
    keys = " ".join(split.controls)
    for expected in ("casual", "unhurried", "calm", "sharp", "pleasantries"):
        assert expected in keys, expected


def test_user_style_wording_never_reaches_the_prompt():
    p = _prompt(_ctx(objective=RAW))
    lowered = p.lower()
    for raw in ("keep it casual", "don't rush", "keep calm", "keep it smart", "exchange pleasantries"):
        assert raw not in lowered, raw
    assert "tell sam the venue is booked for friday at six" in lowered
    assert "Delivery controls for this call (private, applied silently, never mentioned):" in p
    assert "Register: casual and relaxed" in p


def test_style_in_the_detail_field_is_converted_too_and_task_text_is_untouched():
    p = _prompt(_ctx(objective="Confirm the headcount.", instructions="Be brief, be polite. Ask about eight guests, on Friday, at six."))
    lowered = p.lower()
    assert "be brief" not in lowered and "be polite" not in lowered
    assert "ask about eight guests, on friday, at six" in lowered
    assert "Length: short spoken turns" in p


def test_task_text_without_style_is_left_exactly_as_written():
    text = "Ask John if he remembers the Arsenal match, then book Friday."
    split = split_style_instructions(text)
    assert split.controls == () and split.remaining == text


def test_narrating_behaviour_is_ruled_out():
    flat = " ".join(_prompt().split())
    assert "Never narrate your own behaviour" in flat
    for narrated in ("I'm keeping it casual", "I'm being concise", "I'm staying calm", "I'm exchanging pleasantries", "I'm following your instructions"):
        assert narrated in flat  # present only as things never to say
    assert "never say it, quote it, paraphrase it or refer to it" in flat.replace("You never say it, quote", "never say it, quote")


# ----------------------------------------------------------- natural openings

def test_opening_style_is_contextual_and_avoids_assistant_openers():
    opening = _section(_prompt(), "OPENING STYLE", "SPOKEN EXAMPLES")
    flat = " ".join(opening.split())
    for banned in ('"Good."', '"Great."', '"Perfect."', '"How can I help you today?"'):
        assert banned in flat
    assert "Never start with" in flat
    assert "not a template" in flat
    assert "Skip pleasantries when they answer sounding busy, upset, impatient or urgent" in flat
    assert "few words of pleasantries are fine when the person sounds relaxed" in flat
    assert END_CALL_TOOL in flat
    assert "Can you hear me" not in opening
    assert "unless there is real evidence the audio is unclear" in " ".join(_prompt().split())


def test_opening_uses_the_real_call_context():
    ctx = _ctx(objective="Check whether Sam can make Friday.", prior_summaries=["Sam prefers morning calls."], memories=["Sam just moved house."])
    p = _prompt(ctx)
    caller = _section(p, "CALLER INFORMATION", "REQUIRED INFORMATION")
    assert "You are speaking as Ada" in caller and "You are calling: Sam." in caller
    assert "Sam prefers morning calls." in caller and "Sam just moved house." in caller
    assert "Check whether Sam can make Friday." in _section(p, "CALL OBJECTIVE", "CALLER INFORMATION")
    # The opening cue is still the neutral "they picked up" cue, no canned greeting.
    assert "How can I help" not in opening_cue()


def test_not_customer_support():
    flat = " ".join(_prompt().split())
    assert "Never say things an assistant says" in flat
    assert "not customer support" in flat
    assert "You are not an assistant, not customer service" in flat


# ------------------------------------------------- disagreement / uncertainty

def test_disagreement_and_uncertainty_are_encouraged():
    flat = " ".join(_prompt().split())
    assert "say so plainly and kindly" in flat
    assert "say you are not sure" in flat
    assert "Never cover a gap with a confident guess" in flat
    examples = _section(_prompt(), "SPOKEN EXAMPLES", None)
    assert "Disagreeing, naturally" in examples and "Uncertain, said plainly" in examples
    assert "They are not lines to reuse" in " ".join(examples.split())


# ------------------------------------------------------------ caller states

def test_urgent_caller_guidance_skips_pleasantries():
    flat = " ".join(_prompt().split())
    assert "Busy, impatient or urgent: skip pleasantries and any warm-up" in flat
    assert "Say what matters in your first turn" in flat
    assert "Urgent caller, no warm-up" in _section(_prompt(), "SPOKEN EXAMPLES", None)
    assert classify_caller_state("I've got two minutes, make it quick") == CALLER_URGENT


def test_frustrated_caller_guidance_is_slower_and_specific():
    flat = " ".join(_prompt().split())
    assert "Frustrated or upset: no jokes and no pleasantries. Slow down" in flat
    assert "do not tell them to calm down" in flat
    assert "Do not take the blame or pass it" in flat
    assert "Frustrated caller, slower and specific" in _section(_prompt(), "SPOKEN EXAMPLES", None)
    assert classify_caller_state("This is the third time, it's ridiculous") == CALLER_FRUSTRATED


def test_casual_caller_guidance_loosens_up_without_reflexes():
    flat = " ".join(_prompt().split())
    assert "Relaxed or chatty: loosen up" in flat
    assert "still apply" in flat
    assert "Casual caller, looser" in _section(_prompt(), "SPOKEN EXAMPLES", None)
    assert classify_caller_state("haha no worries, what's up") == CALLER_CASUAL
    assert classify_caller_state("The venue is on Main Street") is None


def test_caller_state_does_not_leak_as_an_announcement():
    flat = " ".join(_prompt().split())
    assert "never announce what you notice" in flat


# ------------------------------------------------- engine/voice/prompt safety

def test_operator_supplied_prompt_still_owns_the_persona():
    s = load_settings({**ENV, "ASSISTANT_SYSTEM_PROMPT": "You are Ada. Be terse."})
    p = build_live_system_prompt(s, "Speaking as Ada.")
    assert p.startswith("You are Ada. Be terse.")
    assert "PRIVATE BEHAVIOR RULES" not in p and "Delegation policy:" in p and "Speaking as Ada." in p


def test_missing_call_row_falls_back_to_the_context_string():
    p = build_live_system_prompt(_settings(), "Speaking as Ada. Calling Sam.", None)
    assert "Speaking as Ada. Calling Sam." in _section(p, "CALL OBJECTIVE", "CALLER INFORMATION")
    assert all(h in p for h in SECTION_ORDER)


def test_text_only_and_fish_markup_never_enter_the_live_prompt():
    p = _prompt()
    for forbidden in ("[[END_CALL]]", "[[MOOD", "[laughing]", "[whispering]", "Fish"):
        assert forbidden not in p, forbidden
