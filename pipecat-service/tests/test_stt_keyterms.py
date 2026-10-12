"""Deepgram key terms: names and proper nouns of this call, for the classic (custom / test voice) pipeline."""

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


def _deepgram(model: str):
    settings = Settings(
        bridge_secret="x" * 32, stt_provider="deepgram", deepgram_api_key="dg-test-key", stt_model=model,
    )
    return build_stt(settings, "en", ["Ayodele", "Lekki"])


def test_nova3_receives_the_key_terms():
    assert _deepgram("nova-3")._settings.keyterm == ["Ayodele", "Lekki"]


def test_other_models_ignore_the_hint_instead_of_failing():
    assert _deepgram("nova-2")._settings.keyterm is None
