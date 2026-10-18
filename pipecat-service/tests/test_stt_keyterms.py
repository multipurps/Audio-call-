"""STT name hints: names and proper nouns of this call go into the gpt-4o-mini-transcribe prompt (classic: custom / test voice pipeline)."""

from __future__ import annotations

from app.call_context import STT_KEYTERM_LIMIT, CallContext, stt_keyterms
from app.config import Settings
from app.providers import DOMAIN_STT_TERMS, build_stt


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


def _spoken_words(prompt: str) -> list[str]:
    return prompt.split("Words that may be spoken: ", 1)[1].rstrip(".").split(", ")


def test_names_go_into_the_transcription_prompt_before_the_domain_words():
    prompt = _openai(names=["Ayodele", "Lekki"])._settings.prompt
    assert prompt.startswith("Transcribe the caller's speech only.")
    assert _spoken_words(prompt) == ["Ayodele", "Lekki", *DOMAIN_STT_TERMS]


def test_domain_words_are_sent_on_every_call_even_without_names():
    # Lowercase words like "scores" are never proper nouns, so name extraction skips them.
    for names in ([], None):
        prompt = _openai(names=names)._settings.prompt
        assert prompt.startswith("Transcribe the caller's speech only.")
        assert _spoken_words(prompt) == list(DOMAIN_STT_TERMS)
        assert "scores" in DOMAIN_STT_TERMS


def test_a_name_that_matches_a_domain_word_is_not_sent_twice():
    words = _spoken_words(_openai(names=["Scores", "scores"])._settings.prompt)
    assert words[0] == "Scores"
    assert [w.lower() for w in words].count("scores") == 1


def test_the_model_is_gpt_4o_mini_transcribe_and_a_leftover_nova_name_never_reaches_openai():
    assert _openai()._settings.model == "gpt-4o-mini-transcribe"
    assert _openai(model="nova-3")._settings.model == "gpt-4o-mini-transcribe"


def test_the_call_language_is_passed_to_openai():
    # Pipecat stores the language as the code OpenAI receives ("en", "yo").
    assert _openai(language="yo")._settings.language == "yo"
    assert _openai(language="en-US")._settings.language == "en"
    assert _openai(language="not-a-language")._settings.language == "en"
    assert _openai(language=None)._settings.language == "en"
