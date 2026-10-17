"""Classic-pipeline STT: streaming by default, batch only as the kill switch."""

import dataclasses

from app.config import load_settings

BASE_ENV = {"ASSISTANT_BRIDGE_SECRET": "test-secret-0123456789abcdef", "OPENAI_API_KEY": "sk-test", "ASSISTANT_STT_PROVIDER": "openai", "FISH_API_KEY": "fish-test-key"}
from app.providers import build_stt


def _settings(**overrides):
    base = load_settings(BASE_ENV)
    return dataclasses.replace(base, **overrides)


def test_streaming_is_the_default():
    assert load_settings(BASE_ENV).stt_streaming is True


def test_kill_switch_env_turns_streaming_off():
    assert load_settings({**BASE_ENV, "ASSISTANT_STT_STREAMING": "0"}).stt_streaming is False


def test_default_builds_the_streaming_service():
    from pipecat.services.openai.stt import OpenAIRealtimeSTTService

    stt = build_stt(_settings(stt_streaming=True))
    assert isinstance(stt, OpenAIRealtimeSTTService)


def test_kill_switch_builds_the_previous_batch_service():
    from pipecat.services.openai.stt import OpenAISTTService

    stt = build_stt(_settings(stt_streaming=False))
    assert isinstance(stt, OpenAISTTService)
