"""The in-app call is the user talking WITH Emysa. Emysa is Emysa; the user is never "the caller she speaks as"."""

from app.call_context import CallContext, build_extra_context
from app.config import load_settings
from app.conversation import APP_GREETING, APP_OPENING_CUE, OPENING_CUE as CLASSIC_CALLER_CUE
from app.conversation_policy import (
    H_CALLER, H_OPENING, is_app_call, validate_live_instructions,
)
from app.live import (
    BACKEND_INSTRUCTIONS, BACKEND_INSTRUCTIONS_APP, OPENING_CUE, OPENING_CUE_APP,
    build_live_system_prompt, opening_cue,
)

ENV = {
    "ASSISTANT_BRIDGE_SECRET": "x" * 32,
    "OPENAI_API_KEY": "sk-test-key-value-123456",
    "FISH_API_KEY": "fk_test_key_value_123456",
}
BRIEFING = (
    "This is a live voice conversation directly with the person you work for, inside their app. "
    "You are Emysa, their assistant. They are briefing you so you can make a call on their behalf. "
    "There is nobody else on this call to speak to or to represent. Contacts you can call for them: Victor."
)


def _ctx(platform="app", user_name="Ayodele Olu", **kw):
    base = dict(
        call_id="c1", user_id="u1", contact_id=None,
        contact_name="Emysa" if platform == "app" else "Victor",
        platform=platform, session_id="call-1", to_number="Emysa" if platform == "app" else "+2349000000000",
        objective="Have a live voice conversation with the user." if platform == "app" else "Tell Victor I will be late.",
        instructions=BRIEFING if platform == "app" else "", status="in_progress", extra_context="",
        user_name=user_name,
    )
    base.update(kw)
    return CallContext(**base)


def _app_prompt(**kw):
    ctx = _ctx(**kw)
    return build_live_system_prompt(load_settings(ENV), build_extra_context(ctx), ctx)


# ---- the screenshot bug: Emysa greeted the user as "Emysa" and introduced herself as the user ----

def test_the_model_is_emysa_and_the_user_is_the_other_person():
    p = _app_prompt()
    assert "You are Emysa" in p
    assert "You are talking with Ayodele, the person you work for." in p
    assert "Never speak as them" in p or "never speak as them" in p
    assert "never greet them as if they were Emysa" in p


def test_nothing_tells_the_model_to_speak_as_the_user_or_to_call_someone():
    p = _app_prompt()
    for banned in (
        "You are speaking as", "You are calling:", "speaking as the person who set this call up",
        "You are not an assistant", "the person you are calling", "You are the one calling",
        "Never open or restart the conversation with", "Do not introduce yourself unless",
        "You are the person described",
    ):
        assert banned not in p, banned


def test_the_prompt_is_still_a_valid_structured_prompt():
    assert validate_live_instructions(_app_prompt()) == []


def test_opening_is_an_assistant_greeting_the_user_not_a_caller_ringing_someone():
    p = _app_prompt()
    opening = p[p.index("OPENING STYLE"):]
    assert "short, natural hello using their first name" in opening
    assert "Never greet them as Emysa" in opening
    assert opening_cue(app_call=True) == OPENING_CUE_APP
    assert "just picked up" not in OPENING_CUE_APP and "you are calling" not in OPENING_CUE_APP.lower()
    assert "Emysa" in OPENING_CUE_APP
    assert "Emysa" not in APP_GREETING and "{" not in APP_GREETING   # the fallback never names anyone as the caller


def test_a_configured_greeting_override_is_not_used_for_the_app_call():
    assert opening_cue("Hello, who is this?", app_call=True) == OPENING_CUE_APP
    assert "Hello, who is this?" in opening_cue("Hello, who is this?")      # other calls keep it
    assert opening_cue("") == OPENING_CUE


def test_without_a_name_nothing_is_invented():
    p = _app_prompt(user_name="")
    assert "their name is not on file" in p
    assert "You are talking with Ayodele" not in p


def test_the_user_is_never_told_a_call_was_placed_from_the_briefing():
    p = _app_prompt()
    assert "Never say or suggest that a call has been placed" in p


def test_the_briefing_text_the_app_sends_is_what_guides_the_conversation():
    p = _app_prompt()
    assert "Contacts you can call for them: Victor." in p


# ---- the classic engine (custom voice) gets the same identity ----

def test_classic_context_block_is_emysa_too():
    block = build_extra_context(_ctx())
    assert "You are Emysa" in block and "You are talking with Ayodele" in block
    assert "this overrides any earlier line" in block
    assert "You are speaking as" not in block and "You are calling:" not in block


def test_classic_opening_and_backend_are_not_a_callers():
    assert "just joined the call" in APP_OPENING_CUE and "picked up" not in APP_OPENING_CUE
    assert "picked up" in CLASSIC_CALLER_CUE                   # calls to other people unchanged
    assert "assistant, Emysa" in BACKEND_INSTRUCTIONS_APP
    assert "working for the speaker" in BACKEND_INSTRUCTIONS   # unchanged


# ---- every other call is exactly as before ----

def test_calls_to_other_people_still_speak_as_the_user():
    ctx = _ctx(platform="whatsapp")
    assert not is_app_call(ctx)
    p = build_live_system_prompt(load_settings(ENV), build_extra_context(ctx), ctx)
    assert "You are speaking as Ayodele Olu" in p
    assert "You are calling: Victor." in p
    assert "You are Emysa" not in p
    assert is_app_call(_ctx(platform="app")) and is_app_call(_ctx(platform=" APP "))
