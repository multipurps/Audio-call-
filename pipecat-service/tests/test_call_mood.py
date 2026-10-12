"""The mood the user picks for a call (natural, angry, angry + argue, sweet, jovial, sad, talkative)."""

import pytest

from app.call_context import CallContext, build_extra_context, _CALL_COLUMNS_FULL, _CALL_COLUMNS_MOOD, _find_call_row
from app.config import load_settings
from app.conversation_policy import (
    ARGUE_STANCE,
    MOOD_CONTROLS,
    PRIVATE_BEHAVIOR_RULES,
    is_argue,
    mood_control,
    validate_live_instructions,
)
from app.live import _LIVE_POLICIES, _LIVE_POLICIES_ARGUE, build_live_system_prompt

ENV = {
    "ASSISTANT_BRIDGE_SECRET": "x" * 32,
    "OPENAI_API_KEY": "sk-test-key-value-123456",
    "FISH_API_KEY": "fk_test_key_value_123456",
}
MOODS = ["angry", "angry_argue", "sweet", "jovial", "sad", "talkative"]


def _ctx(mood="", objective="Tell Sam the venue is booked for Friday at six."):
    return CallContext(
        call_id="c1", user_id="u1", contact_id="k1", contact_name="Sam", platform="whatsapp",
        session_id="call-1", to_number="+15550001111", objective=objective, instructions="",
        status="in_progress", extra_context="", user_name="Ada", mood=mood,
    )


def _prompt(mood=""):
    ctx = _ctx(mood)
    return build_live_system_prompt(load_settings(ENV), build_extra_context(ctx), ctx)


# ---- natural is exactly what every call was before ------------------------------------

def test_natural_adds_nothing():
    base = _prompt("")
    assert "Mood:" not in base and "Stance for this call" not in base
    assert _prompt("not-a-mood") == base          # an unknown value is ignored, never injected
    assert mood_control("") is None and mood_control(None) is None and mood_control("natural") is None


# ---- each mood changes delivery, and only delivery ------------------------------------

@pytest.mark.parametrize("mood", MOODS)
def test_each_mood_adds_its_delivery_control_and_keeps_the_prompt_valid(mood):
    p = _prompt(mood)
    assert MOOD_CONTROLS[mood] in p
    assert validate_live_instructions(p) == []     # all required sections, in order
    assert "Tell Sam the venue is booked for Friday at six." in p   # the objective is untouched
    assert "You are speaking as Ada" in p                            # still the caller, not a generic AI


def test_moods_are_distinct_from_each_other():
    texts = {m: MOOD_CONTROLS[m] for m in ("angry", "sweet", "jovial", "sad", "talkative")}
    assert len(set(texts.values())) == 5
    for m in ("angry", "sweet", "jovial", "sad", "talkative"):
        others = [t for k, t in texts.items() if k != m]
        assert all(texts[m] not in _prompt(k) for k in ("angry", "sweet", "jovial", "sad", "talkative") if k != m)


def test_every_mood_stays_civil_and_never_announces_itself():
    for mood in ("angry", "sweet", "jovial", "sad", "talkative"):
        t = MOOD_CONTROLS[mood].lower()
        assert "never" in t or "do not" in t or "no " in t
    assert "no insults" in MOOD_CONTROLS["angry"].lower()
    assert "never announce" in MOOD_CONTROLS["angry"].lower()


# ---- Argue is only ever on for an angry call that asked for it -------------------------

def test_plain_angry_does_not_argue():
    p = _prompt("angry")
    assert "Stance for this call" not in p
    assert "Stop speaking when they interrupt" in p          # unchanged interruption policy


def test_argue_adds_the_stance_and_relaxes_the_interruption_policy():
    p = _prompt("angry_argue")
    assert ARGUE_STANCE in p
    assert MOOD_CONTROLS["angry"] in p
    assert "Do not concede" in p and "outranks the advice above" in p
    assert "you do not have to give way" in p
    assert "Stop speaking when they interrupt" not in p
    assert _LIVE_POLICIES_ARGUE != _LIVE_POLICIES


def test_argue_stance_is_bounded_and_does_not_sound_like_a_debate_bot():
    t = ARGUE_STANCE
    assert "no insults, threats, slurs or swearing" in t.lower()
    assert "do not lie" in t.lower()
    assert "debate language" in t.lower() and "therapist" in t.lower()   # named as things NOT to do
    assert "clearly ask to end the call" in t.lower()                      # a way out is always there
    assert "never agree" in t.lower() and "no \"you're right\"" in t.lower()   # literal: no agreement of any kind


def test_only_angry_argue_is_argue():
    assert is_argue("angry_argue") and is_argue(" ANGRY_ARGUE ")
    for m in ("angry", "sweet", "jovial", "sad", "talkative", "", None, "argue"):
        assert not is_argue(m)


def test_argue_stance_does_not_change_the_forbidden_claims_or_identity_rules():
    p = _prompt("angry_argue")
    assert PRIVATE_BEHAVIOR_RULES.split("\n")[0] in p
    base = _prompt("")
    # everything after the rules section (objective, caller, forbidden claims, opening) is identical
    tail = lambda s: s[s.index("Your private objective"):]
    assert tail(p) == tail(base)


# ---- reading the mood off the call row ------------------------------------------------

class _Rest:
    def __init__(self, mood_column_exists):
        self.mood_column_exists = mood_column_exists
        self.tried = []

    async def select(self, table, *, select, filters, order=None, limit=None):
        self.tried.append(select)
        if ", mood" in select and not self.mood_column_exists:
            raise RuntimeError('column "mood" does not exist')
        row = {"id": "c1", "status": "queued"}
        if ", mood" in select:
            row["mood"] = "angry_argue"
        return [row]


async def test_mood_is_read_when_the_column_exists():
    rest = _Rest(True)
    row = await _find_call_row(rest, session_id="call-c1", platform="whatsapp")
    assert row["mood"] == "angry_argue"
    assert rest.tried[0] == _CALL_COLUMNS_MOOD


async def test_a_database_without_the_mood_column_still_resolves_the_call():
    rest = _Rest(False)
    row = await _find_call_row(rest, session_id="call-c1", platform="whatsapp")
    assert row and "mood" not in row                       # falls back, call is unaffected
    assert rest.tried[:2] == [_CALL_COLUMNS_MOOD, _CALL_COLUMNS_FULL]


def test_sassy_is_a_mood_with_its_own_line_and_no_argue():
    from app.conversation_policy import is_argue
    assert "sassy and rude" in MOOD_CONTROLS["sassy"]
    assert not is_argue("sassy")
    p = _prompt("sassy")
    assert MOOD_CONTROLS["sassy"] in p
    assert "Stance for this call" not in p


def test_the_non_live_pipeline_also_gets_mood_and_argue():
    from app.call_context import build_extra_context
    ctx = _ctx("angry_argue") if "_ctx" in globals() else None
    assert ctx is not None
    text = build_extra_context(ctx)
    assert MOOD_CONTROLS["angry"] in text and ARGUE_STANCE in text
    assert MOOD_CONTROLS["angry"] not in build_extra_context(_ctx(""))
