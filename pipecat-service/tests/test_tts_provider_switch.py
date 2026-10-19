"""OpenAI STT, the Fish default, and the rule that cloned voices never run on GPT-Live."""
import asyncio
import dataclasses

import pytest

from app.config import ConfigError, TTS_PROVIDERS, load_settings
from app.vocal import strip_tts_markers

BASE = {"ASSISTANT_BRIDGE_SECRET": "x" * 24, "OPENAI_API_KEY": "sk-test-openai-key", "FISH_API_KEY": "fish-test-key-1234"}


def test_fish_tags_are_dropped_for_other_voices():
    assert strip_tts_markers("Oh [laughing] that's great (soft) really").split() == ["Oh", "that's", "great", "really"]
    assert strip_tts_markers("Hi [[END_CALL]] bye").split() == ["Hi", "bye"]


# ---- STT (OpenAI gpt-4o-mini-transcribe; Deepgram was removed) -------------------

def test_stt_is_openai_gpt_4o_mini_transcribe_by_default():
    s = load_settings(BASE)
    assert s.stt_provider == "openai"
    assert s.resolved_stt_model() == "gpt-4o-mini-transcribe"


def test_a_leftover_deepgram_setting_boots_on_openai_instead_of_crashing():
    s = load_settings({**BASE, "ASSISTANT_STT_PROVIDER": "deepgram", "ASSISTANT_STT_MODEL": "nova-3", "DEEPGRAM_API_KEY": "dg-test-key-12345"})
    assert s.stt_provider == "openai"
    assert s.resolved_stt_model() == "gpt-4o-mini-transcribe"
    assert "dg-test-key-12345" not in str(s.redacted_summary())
    assert "dg-test-key-12345" not in s.secret_values()


def test_build_stt_openai():
    # Streaming transcription is the default; the batch service is the kill switch
    # (covered in tests/test_stt_streaming.py).
    from pipecat.services.openai.stt import OpenAIRealtimeSTTService
    from app.providers import build_stt
    stt = build_stt(load_settings(BASE), "en")
    assert isinstance(stt, OpenAIRealtimeSTTService)
    assert stt._settings.model == "gpt-4o-mini-transcribe"


def test_voice_pref_reads_overlap_instead_of_running_one_after_another(monkeypatch):
    """Measured: the three serial reads cost 0.9-1.2 s of call start. Each fake read takes
    0.2 s, so serial would be >= 0.6 s and concurrent is about 0.2 s."""
    import time

    from app import call_context

    class SlowRest:
        def __init__(self, *a, **k): pass
        async def aclose(self): pass
        async def select(self, table, **k):
            await asyncio.sleep(0.2)
            return {
                "voice_preferences": [{"live_voice_id": "marin"}],
                "voice_profiles": [{"provider_voice_id": "fishclone12345", "status": "ready"}],
                "voice_test_settings": [],
            }[table]

    monkeypatch.setattr(call_context, "_Rest", SlowRest)
    s = dataclasses.replace(load_settings(dict(BASE)), supabase_url="https://x.supabase.co", supabase_service_role_key="s" * 30)
    started = time.monotonic()
    prefs = asyncio.run(call_context.fetch_voice_prefs(s, "user-1", "sess-1"))
    elapsed = time.monotonic() - started
    assert prefs.live_voice_id == "marin" and prefs.custom_voice_id == "fishclone12345"
    assert elapsed < 0.45, f"reads look serial: {elapsed:.2f}s"


def test_a_failed_prefs_read_still_returns_none_and_closes_the_client(monkeypatch):
    from app import call_context

    closed = []

    class BrokenRest:
        def __init__(self, *a, **k): pass
        async def aclose(self): closed.append(True)
        async def select(self, table, **k):
            raise RuntimeError("timeout")

    monkeypatch.setattr(call_context, "_Rest", BrokenRest)
    s = dataclasses.replace(load_settings(dict(BASE)), supabase_url="https://x.supabase.co", supabase_service_role_key="s" * 30)
    assert asyncio.run(call_context.fetch_voice_prefs(s, "user-1", "sess-1")) is None
    assert closed == [True]
