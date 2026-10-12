"""ElevenLabs / Cartesia can replace Fish for A/B testing without touching the
rest of the pipeline."""
import dataclasses

import pytest

from app.config import ConfigError, TTS_PROVIDERS, load_settings
from app.vocal import strip_tts_markers

BASE = {"ASSISTANT_BRIDGE_SECRET": "x" * 24, "OPENAI_API_KEY": "sk-test-openai-key", "FISH_API_KEY": "fish-test-key-1234"}


def test_new_providers_are_selectable():
    assert {"fish", "elevenlabs", "cartesia"} <= set(TTS_PROVIDERS)


def test_default_is_still_fish():
    assert load_settings(dict(BASE)).tts_provider == "fish"


@pytest.mark.parametrize("prov,key,voice", [("elevenlabs", "ELEVENLABS_API_KEY", "ELEVENLABS_VOICE_ID"), ("cartesia", "CARTESIA_API_KEY", "CARTESIA_VOICE_ID")])
def test_provider_needs_its_own_key_and_voice(prov, key, voice):
    env = {**BASE, "ASSISTANT_TTS_PROVIDER": prov}
    with pytest.raises(ConfigError):
        load_settings(env)
    with pytest.raises(ConfigError):
        load_settings({**env, key: "k" * 20})  # key but no voice
    s = load_settings({**env, key: "k" * 20, voice: "voice-abc-123"})
    assert s.tts_provider == prov


def test_keys_are_redacted():
    s = load_settings({**BASE, "ASSISTANT_TTS_PROVIDER": "cartesia", "CARTESIA_API_KEY": "c" * 20, "CARTESIA_VOICE_ID": "v" * 12})
    assert "c" * 20 in s.secret_values()
    assert "c" * 20 not in str(s.redacted_summary())


@pytest.mark.parametrize("prov,env_key,env_voice,cls_path", [
    ("elevenlabs", "ELEVENLABS_API_KEY", "ELEVENLABS_VOICE_ID", "pipecat.services.elevenlabs.tts.ElevenLabsTTSService"),
    ("cartesia", "CARTESIA_API_KEY", "CARTESIA_VOICE_ID", "pipecat.services.cartesia.tts.CartesiaTTSService"),
])
def test_build_tts_uses_the_vendor_voice_not_the_fish_id(prov, env_key, env_voice, cls_path):
    pytest.importorskip("pipecat")
    from app.providers import build_tts
    import importlib
    mod, cls = cls_path.rsplit(".", 1)
    klass = getattr(importlib.import_module(mod), cls)
    s = load_settings({**BASE, "ASSISTANT_TTS_PROVIDER": prov, env_key: "k" * 20, env_voice: "vendor-voice-123", "ASSISTANT_TTS_VOICE_ID": "fish-clone-id-99999"})
    # a per-call Fish clone id must never be sent to another vendor
    s = dataclasses.replace(s, tts_voice_id="fish-clone-id-99999", tts_voice_is_per_call=True)
    tts = build_tts(s)
    assert isinstance(tts, klass)
    assert tts._settings.voice == "vendor-voice-123"


def test_fish_tags_are_dropped_for_other_voices():
    assert strip_tts_markers("Oh [laughing] that's great (soft) really").split() == ["Oh", "that's", "great", "really"]
    assert strip_tts_markers("Hi [[END_CALL]] bye").split() == ["Hi", "bye"]
