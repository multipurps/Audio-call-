"""STT name hints: names and proper nouns of this call go into the gpt-4o-mini-transcribe prompt (classic: custom / test voice pipeline)."""

from __future__ import annotations

from app.call_context import STT_KEYTERM_LIMIT, CallContext, stt_keyterms
from app.config import Settings
from app.providers import build_stt


def ctx(**kw) -> CallContext:
    base = dict(
        call_id="c", user_id="u", contact_id=None, contact_name="Funmilayo Adeyemi", platform="whatsapp",
        session_id="s", to_number="+2348000000001", objective="Tell Funmilayo the Lekki delivery is late.",
        instructions="", status="queued", extra_context="", user_name="Ayodele Bello",
    )
    base.update(kw)
    return CallContext(**base)


def test_names_come_first_and_instructions_words_are_not_terms():
    terms = stt_keyterms(ctx())
    assert terms[:4] == ["Ayodele Bello", "Ayodele", "Funmilayo Adeyemi", "Funmilayo"]
    assert "Lekki" in terms
    assert "Tell" not in terms  # a sentence-start verb is not a name


def test_no_context_or_blank_names_give_no_terms():
    assert stt_keyterms(None) == []
    assert stt_keyterms(ctx(user_name="", contact_name="", objective="tell them it is late")) == []


def test_terms_are_deduplicated_and_capped():
    objective = " ".join(f"Name{chr(97 + i % 26)}{chr(97 + i // 26)}x" for i in range(80)).title()
    terms = stt_keyterms(ctx(objective=objective + " Funmilayo funmilayo"))
    assert len(terms) <= STT_KEYTERM_LIMIT
    assert len({t.lower() for t in terms}) == len(terms)


def _openai(model: str | None = None, language: str | None = "en", names=None):
    settings = Settings(bridge_secret="x" * 32, stt_provider="openai", openai_api_key="sk-test-key", stt_model=model)
    return build_stt(settings, language, names)


def test_names_go_into_the_transcription_prompt():
    prompt = _openai(names=["Ayodele", "Lekki"])._settings.prompt
    assert "Names that may be spoken: Ayodele, Lekki." in prompt
    assert prompt.startswith("Transcribe the caller's speech only.")


def test_no_names_leaves_the_prompt_unchanged():
    assert "Names that may be spoken" not in _openai(names=[])._settings.prompt


def test_the_model_is_gpt_4o_mini_transcribe_and_a_leftover_nova_name_never_reaches_openai():
    assert _openai()._settings.model == "gpt-4o-mini-transcribe"
    assert _openai(model="nova-3")._settings.model == "gpt-4o-mini-transcribe"


def test_the_call_language_is_passed_to_openai():
    # Pipecat stores the language as the code OpenAI receives ("en", "yo").
    assert _openai(language="yo")._settings.language == "yo"
    assert _openai(language="en-US")._settings.language == "en"
    assert _openai(language="not-a-language")._settings.language == "en"
    assert _openai(language=None)._settings.language == "en"
