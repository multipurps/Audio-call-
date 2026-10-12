"""Per-user test voices (ElevenLabs / Cartesia), Deepgram STT, and the rule that
cloned or test voices never run on GPT-Live."""
import asyncio
import dataclasses

import pytest

from app.config import ConfigError, TEST_TTS_PROVIDERS, TTS_PROVIDERS, load_settings
from app.vocal import strip_tts_markers

BASE = {"ASSISTANT_BRIDGE_SECRET": "x" * 24, "OPENAI_API_KEY": "sk-test-openai-key", "FISH_API_KEY": "fish-test-key-1234"}


def test_env_cannot_select_a_test_voice_provider():
    assert set(TTS_PROVIDERS) == {"fish", "mock"}
    assert set(TEST_TTS_PROVIDERS) == {"elevenlabs", "cartesia"}
    with pytest.raises(ConfigError):
        load_settings({**BASE, "ASSISTANT_TTS_PROVIDER": "elevenlabs"})


def test_default_is_still_fish():
    assert load_settings(dict(BASE)).tts_provider == "fish"


@pytest.mark.parametrize("prov,cls_path", [
    ("elevenlabs", "pipecat.services.elevenlabs.tts.ElevenLabsHttpTTSService"),
    ("cartesia", "pipecat.services.cartesia.tts.CartesiaHttpTTSService"),
])
def test_build_tts_uses_the_users_saved_voice_and_key(prov, cls_path):
    pytest.importorskip("pipecat")
    import importlib
    from app.providers import build_tts
    mod, cls = cls_path.rsplit(".", 1)
    s = dataclasses.replace(load_settings(dict(BASE)), tts_provider=prov, tts_test_voice_id="vendor-voice-123",
                            tts_test_api_key="user-key-abcdefgh", tts_voice_id="fish-clone-id-99999", tts_voice_is_per_call=True)
    async def _build():
        return build_tts(s)

    tts = asyncio.run(_build())
    assert isinstance(tts, getattr(importlib.import_module(mod), cls))
    assert tts._settings.voice == "vendor-voice-123"   # never the Fish clone id
    # HTTP (one request per sentence), never the websocket service that dropped the audio
    assert "Http" in type(tts).__mro__[1].__name__ or "Http" in type(tts).__name__
    assert "user-key-abcdefgh" in s.secret_values()   # redacted from logs


def test_test_voice_without_key_is_refused():
    from app.providers import build_tts
    s = dataclasses.replace(load_settings(dict(BASE)), tts_provider="cartesia", tts_test_voice_id="vendor-voice-123")
    with pytest.raises(ValueError):
        build_tts(s)


def test_cloned_or_test_voice_never_uses_gpt_live_even_when_live_is_forced():
    for engine in ("auto", "live"):
        env = {**BASE, "ASSISTANT_CALL_ENGINE": engine}
        s = load_settings(env)
        assert s.engine_for_call() == "live"  # a normal call can use GPT-Live
        clone = dataclasses.replace(s, tts_voice_id="fish-clone-id-99999", tts_voice_is_per_call=True)
        assert clone.engine_for_call() == "classic"
        test = dataclasses.replace(s, tts_provider="elevenlabs", tts_test_voice_id="vendor-voice-123", tts_test_api_key="k" * 20)
        assert test.engine_for_call() == "classic"


def test_fish_tags_are_dropped_for_other_voices():
    assert strip_tts_markers("Oh [laughing] that's great (soft) really").split() == ["Oh", "that's", "great", "really"]
    assert strip_tts_markers("Hi [[END_CALL]] bye").split() == ["Hi", "bye"]


# ---- Deepgram -----------------------------------------------------------------

def test_deepgram_selected_with_key():
    s = load_settings({**BASE, "ASSISTANT_STT_PROVIDER": "deepgram", "DEEPGRAM_API_KEY": "dg-test-key-12345"})
    assert s.stt_provider == "deepgram"
    assert s.resolved_stt_model() == "nova-3"
    assert "dg-test-key-12345" in s.secret_values()
    assert "dg-test-key-12345" not in str(s.redacted_summary())


def test_deepgram_without_key_boots_on_openai_instead_of_crashing():
    assert load_settings({**BASE, "ASSISTANT_STT_PROVIDER": "deepgram"}).stt_provider == "openai"


def test_build_stt_deepgram():
    pytest.importorskip("deepgram")
    from pipecat.services.deepgram.stt import DeepgramSTTService
    from app.providers import build_stt
    s = load_settings({**BASE, "ASSISTANT_STT_PROVIDER": "deepgram", "DEEPGRAM_API_KEY": "dg-test-key-12345"})
    stt = build_stt(s, "en")
    assert isinstance(stt, DeepgramSTTService)
    assert stt._settings.model == "nova-3"


def test_saved_test_voice_is_read_per_user(monkeypatch):
    from app import call_context

    class FakeRest:
        def __init__(self, *a, **k): pass
        async def aclose(self): pass
        async def select(self, table, **k):
            return {
                "voice_preferences": [{"live_voice_id": "marin", "use_custom_voice": True}],
                "voice_profiles": [{"provider_voice_id": "fishclone12345", "status": "ready"}],
                "voice_test_settings": [{"provider": "elevenlabs", "voice_id": "vendor-voice-123", "api_key": "user-key-abcdefgh"}],
            }[table]

    monkeypatch.setattr(call_context, "_Rest", FakeRest)
    s = dataclasses.replace(load_settings(dict(BASE)), supabase_url="https://x.supabase.co", supabase_service_role_key="s" * 30)
    prefs = asyncio.run(call_context.fetch_voice_prefs(s, "user-1", "sess-1"))
    assert (prefs.test_tts_provider, prefs.test_tts_voice_id) == ("elevenlabs", "vendor-voice-123")
    assert prefs.test_tts_api_key == "user-key-abcdefgh"
    assert prefs.custom_voice_id == "fishclone12345"  # normal prefs still read


def test_missing_test_table_does_not_lose_normal_prefs(monkeypatch):
    from app import call_context

    class FakeRest:
        def __init__(self, *a, **k): pass
        async def aclose(self): pass
        async def select(self, table, **k):
            if table == "voice_test_settings":
                raise RuntimeError("relation does not exist")
            return [{"live_voice_id": "marin"}] if table == "voice_preferences" else []

    monkeypatch.setattr(call_context, "_Rest", FakeRest)
    s = dataclasses.replace(load_settings(dict(BASE)), supabase_url="https://x.supabase.co", supabase_service_role_key="s" * 30)
    prefs = asyncio.run(call_context.fetch_voice_prefs(s, "user-1", "sess-1"))
    assert prefs is not None and prefs.live_voice_id == "marin" and prefs.test_tts_provider is None


def test_a_switched_off_test_voice_is_not_used(monkeypatch):
    from app import call_context

    class FakeRest:
        def __init__(self, *a, **k): pass
        async def aclose(self): pass
        async def select(self, table, **k):
            return {
                "voice_preferences": [{"live_voice_id": "marin", "use_custom_voice": False}],
                "voice_profiles": [],
                "voice_test_settings": [{"provider": "elevenlabs", "voice_id": "vendor-voice-123", "api_key": "user-key-abcdefgh", "active": False}],
            }[table]

    monkeypatch.setattr(call_context, "_Rest", FakeRest)
    s = dataclasses.replace(load_settings(dict(BASE)), supabase_url="https://x.supabase.co", supabase_service_role_key="s" * 30)
    prefs = asyncio.run(call_context.fetch_voice_prefs(s, "user-1", "sess-1"))
    assert prefs.test_tts_provider is None and prefs.test_tts_api_key is None
    assert prefs.live_voice_id == "marin"
