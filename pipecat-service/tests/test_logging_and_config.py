"""Tests for the two guarantees the brief is most specific about:
credentials never reaching a log, and audio never reaching a log --
plus startup configuration validation.
"""

from __future__ import annotations

import json
import logging
import struct

import pytest

from app.config import (
    DEFAULT_LLM_MODEL,
    DEFAULT_STT_MODEL,
    ConfigError,
    Settings,
    load_settings,
)
from app.logging_setup import (
    REDACTED,
    JsonFormatter,
    RedactionFilter,
    configure_logging,
    log_audio,
    redact,
    scrub_mapping,
)

SECRET = "sk_live_do_not_leak_me_1234567890"
FISH_SECRET = "fish_audio_key_abcdefghijklmnop"


# --------------------------------------------------------------------------
# Secrets must never reach a log line
# --------------------------------------------------------------------------


class TestRedaction:
    def test_replaces_a_secret_in_plain_text(self):
        assert SECRET not in redact(f"using key {SECRET} now", [SECRET])

    def test_leaves_text_without_secrets_alone(self):
        assert redact("just a message", [SECRET]) == "just a message"

    def test_handles_empty_inputs(self):
        assert redact("", [SECRET]) == ""
        assert redact("text", []) == "text"

    def test_replaces_multiple_secrets(self):
        text = f"a={SECRET} b={FISH_SECRET}"
        out = redact(text, [SECRET, FISH_SECRET])
        assert SECRET not in out
        assert FISH_SECRET not in out

    def test_scrub_mapping_drops_sensitive_keys_entirely(self):
        result = scrub_mapping(
            {"api_key": SECRET, "authorization": f"Bearer {SECRET}", "safe": "ok"},
            [SECRET],
        )
        assert result["api_key"] == REDACTED
        assert result["authorization"] == REDACTED
        assert result["safe"] == "ok"

    def test_scrub_mapping_is_recursive(self):
        result = scrub_mapping({"outer": {"api_key": SECRET, "keep": 1}}, [SECRET])
        assert result["outer"]["api_key"] == REDACTED
        assert result["outer"]["keep"] == 1

    def test_scrub_mapping_redacts_secrets_inside_plain_values(self):
        result = scrub_mapping({"note": f"deployed with {SECRET}"}, [SECRET])
        assert SECRET not in result["note"]

    def test_scrub_mapping_handles_lists(self):
        result = scrub_mapping({"keys": [SECRET, "harmless"]}, [SECRET])
        assert result["keys"][0] == REDACTED
        assert result["keys"][1] == "harmless"

    def test_filter_scrubs_the_log_record(self):
        record = logging.LogRecord(
            "test", logging.INFO, __file__, 1, f"key is {SECRET}", None, None
        )
        RedactionFilter([SECRET]).filter(record)
        assert SECRET not in record.getMessage()

    def test_filter_scrubs_exception_text(self):
        try:
            raise RuntimeError(f"auth failed for {SECRET}")
        except RuntimeError:
            import sys

            record = logging.LogRecord(
                "test", logging.ERROR, __file__, 1, "boom", None, sys.exc_info()
            )
        RedactionFilter([SECRET]).filter(record)
        rendered = logging.Formatter().formatException(record.exc_info)
        assert SECRET not in rendered

    def test_filter_with_no_secrets_is_a_no_op(self):
        record = logging.LogRecord("test", logging.INFO, __file__, 1, "hello", None, None)
        assert RedactionFilter([]).filter(record) is True
        assert record.getMessage() == "hello"

    def test_filter_can_be_given_secrets_later(self):
        """Secrets may load after logging is configured; same instance updates."""
        filter_ = RedactionFilter()
        filter_.set_secrets([SECRET])
        record = logging.LogRecord("test", logging.INFO, __file__, 1, SECRET, None, None)
        filter_.filter(record)
        assert SECRET not in record.getMessage()

    def test_end_to_end_through_a_real_logger(self, capsys):
        logger = logging.getLogger("redaction-e2e")
        logger.handlers.clear()
        configure_logging(secrets=[SECRET], json_output=True)
        logging.getLogger("redaction-e2e").info("using %s", SECRET)

        captured = capsys.readouterr().out
        assert SECRET not in captured
        assert REDACTED in captured
        parsed = json.loads(captured.strip().splitlines()[-1])
        assert parsed["level"] == "INFO"


# --------------------------------------------------------------------------
# Audio content must never reach a log line
# --------------------------------------------------------------------------


class TestAudioIsNeverLogged:
    def test_log_audio_emits_only_metadata(self, caplog):
        payload = struct.pack("<8h", 1000, -1000, 2000, -2000, 3000, -3000, 4000, -4000)
        with caplog.at_level(logging.DEBUG):
            log_audio(
                logging.getLogger("audiotest"),
                "frame received",
                payload=payload,
                sample_rate=16000,
                channels=1,
                encoding="pcm_s16le",
                sequence=7,
                session_id="sess-1",
            )
        record = caplog.records[-1]
        rendered = record.getMessage()
        # The metadata is present...
        assert "frame received" in rendered
        assert record.bytes == len(payload)
        assert record.sampleRate == 16000
        assert record.seq == 7
        # ...and the payload is not, in any representation.
        assert payload.hex() not in rendered
        assert repr(payload) not in rendered
        assert "1000" not in rendered or "bytes" in rendered

    def test_log_audio_records_level_not_samples(self, caplog):
        payload = struct.pack("<4h", 16000, 16000, 16000, 16000)
        with caplog.at_level(logging.DEBUG):
            log_audio(logging.getLogger("audiotest"), "loud", payload=payload)
        assert caplog.records[-1].level is not None
        assert caplog.records[-1].level > 0.4

    def test_log_audio_marks_silence(self, caplog):
        with caplog.at_level(logging.DEBUG):
            log_audio(
                logging.getLogger("audiotest"),
                "quiet",
                payload=struct.pack("<4h", 0, 0, 0, 0),
            )
        assert caplog.records[-1].level == 0.0

    def test_log_audio_without_payload(self, caplog):
        with caplog.at_level(logging.DEBUG):
            log_audio(logging.getLogger("audiotest"), "no payload", sequence=1)
        assert caplog.records[-1].seq == 1
        assert not hasattr(caplog.records[-1], "bytes")

    def test_json_formatter_output_parses(self):
        formatter = JsonFormatter()
        record = logging.LogRecord(
            "test", logging.INFO, __file__, 1, "hello %s", ("world",), None
        )
        record.seq = 5
        body = json.loads(formatter.format(record))
        assert body["msg"] == "hello world"
        assert body["seq"] == 5
        assert body["level"] == "INFO"

    def test_json_formatter_survives_unserialisable_extra(self):
        formatter = JsonFormatter()
        record = logging.LogRecord("test", logging.INFO, __file__, 1, "x", None, None)
        record.weird = object()
        # Must not raise: a logging call that throws would take down the task
        # it is trying to report on.
        assert "weird" in formatter.format(record)


# --------------------------------------------------------------------------
# Configuration
# --------------------------------------------------------------------------


class TestSettingsDefaults:
    def test_mock_mode_needs_no_credentials(self):
        settings = load_settings({"ASSISTANT_MOCK_MODE": "true"})
        assert settings.mock_mode
        assert settings.stt_provider == "groq"
        assert settings.llm_provider == "groq"
        assert settings.tts_provider == "fish"

    def test_port_falls_back_to_8080(self):
        assert load_settings({"ASSISTANT_MOCK_MODE": "true"}).port == 8080

    def test_port_reads_render_injected_value(self):
        assert load_settings({"ASSISTANT_MOCK_MODE": "true", "PORT": "10000"}).port == 10000

    def test_resolved_defaults(self):
        settings = load_settings({"ASSISTANT_MOCK_MODE": "true"})
        assert settings.resolved_stt_model() == DEFAULT_STT_MODEL
        assert settings.resolved_llm_model() == DEFAULT_LLM_MODEL


class TestSettingsValidation:
    def test_missing_bridge_secret_fails_closed(self):
        with pytest.raises(ConfigError, match="ASSISTANT_BRIDGE_SECRET is required"):
            load_settings({"GROQ_API_KEY": "x" * 20, "FISH_API_KEY": "y" * 20})

    def test_short_bridge_secret_rejected(self):
        with pytest.raises(ConfigError, match="at least 16 characters"):
            load_settings(
                {
                    "ASSISTANT_BRIDGE_SECRET": "tooshort",
                    "GROQ_API_KEY": "x" * 20,
                    "FISH_API_KEY": "y" * 20,
                }
            )

    def test_groq_stt_requires_groq_key(self):
        with pytest.raises(ConfigError, match="GROQ_API_KEY is required when ASSISTANT_STT_PROVIDER=groq"):
            load_settings({"ASSISTANT_BRIDGE_SECRET": "a" * 32, "FISH_API_KEY": "y" * 20})

    def test_openai_llm_requires_openai_key(self):
        with pytest.raises(ConfigError, match="OPENAI_API_KEY is required"):
            load_settings(
                {
                    "ASSISTANT_BRIDGE_SECRET": "a" * 32,
                    "GROQ_API_KEY": "x" * 20,
                    "FISH_API_KEY": "y" * 20,
                    "ASSISTANT_LLM_PROVIDER": "openai",
                }
            )

    def test_openai_llm_without_groq_stt_is_accepted(self):
        settings = load_settings(
            {
                "ASSISTANT_BRIDGE_SECRET": "a" * 32,
                "OPENAI_API_KEY": "k" * 20,
                "FISH_API_KEY": "y" * 20,
                "ASSISTANT_LLM_PROVIDER": "openai",
                "ASSISTANT_STT_PROVIDER": "mock",
            }
        )
        assert settings.resolved_llm_base_url() == "https://api.openai.com/v1"

    def test_fish_tts_requires_fish_key(self):
        with pytest.raises(ConfigError, match="FISH_API_KEY is required"):
            load_settings(
                {
                    "ASSISTANT_BRIDGE_SECRET": "a" * 32,
                    "GROQ_API_KEY": "x" * 20,
                    "ASSISTANT_TTS_PROVIDER": "fish",
                }
            )

    def test_unknown_provider_rejected_with_the_valid_list(self):
        with pytest.raises(ConfigError, match="ASSISTANT_STT_PROVIDER must be one of"):
            load_settings(
                {"ASSISTANT_MOCK_MODE": "true", "ASSISTANT_STT_PROVIDER": "deepgram"}
            )

    def test_unknown_llm_provider_rejected(self):
        with pytest.raises(ConfigError, match="ASSISTANT_LLM_PROVIDER must be one of"):
            load_settings(
                {"ASSISTANT_MOCK_MODE": "true", "ASSISTANT_LLM_PROVIDER": "anthropic"}
            )

    def test_unknown_tts_provider_rejected(self):
        with pytest.raises(ConfigError, match="ASSISTANT_TTS_PROVIDER must be one of"):
            load_settings(
                {"ASSISTANT_MOCK_MODE": "true", "ASSISTANT_TTS_PROVIDER": "elevenlabs"}
            )

    def test_persistent_memory_requires_supabase(self):
        with pytest.raises(ConfigError, match="SUPABASE_URL"):
            load_settings(
                {
                    "ASSISTANT_MOCK_MODE": "true",
                    "ASSISTANT_ENABLE_PERSISTENT_MEMORY": "true",
                }
            )

    def test_persistent_memory_with_supabase_is_accepted(self):
        settings = load_settings(
            {
                "ASSISTANT_MOCK_MODE": "true",
                "ASSISTANT_ENABLE_PERSISTENT_MEMORY": "true",
                "SUPABASE_URL": "https://example.supabase.co",
                "SUPABASE_SERVICE_ROLE_KEY": "service-role-key-value",
            }
        )
        assert settings.enable_persistent_memory

    def test_persistent_memory_is_off_by_default(self):
        """The brief requires persistent memory behind an explicit flag."""
        assert load_settings({"ASSISTANT_MOCK_MODE": "true"}).enable_persistent_memory is False

    def test_invalid_boolean_rejected(self):
        with pytest.raises(ConfigError, match="must be a boolean"):
            load_settings({"ASSISTANT_MOCK_MODE": "maybe"})

    def test_invalid_integer_rejected(self):
        with pytest.raises(ConfigError, match="must be an integer"):
            load_settings({"ASSISTANT_MOCK_MODE": "true", "PORT": "not-a-port"})

    def test_negative_integer_rejected(self):
        with pytest.raises(ConfigError, match="must be >= 1"):
            load_settings({"ASSISTANT_MOCK_MODE": "true", "PORT": "-1"})


class TestSecretHandling:
    def test_secret_values_are_collected_for_redaction(self):
        settings = load_settings(
            {
                "ASSISTANT_BRIDGE_SECRET": "a" * 32,
                "GROQ_API_KEY": "gk_abcdefghijklmnop",
                "FISH_API_KEY": "fk_abcdefghijklmnop",
            }
        )
        secrets = settings.secret_values()
        assert "a" * 32 in secrets
        assert "gk_abcdefghijklmnop" in secrets
        assert "fk_abcdefghijklmnop" in secrets

    def test_no_secrets_in_mock_mode(self):
        assert load_settings({"ASSISTANT_MOCK_MODE": "true"}).secret_values() == ()

    def test_redacted_summary_contains_no_secret_values(self):
        settings = load_settings(
            {
                "ASSISTANT_BRIDGE_SECRET": "a" * 32,
                "GROQ_API_KEY": "gk_abcdefghijklmnop",
                "FISH_API_KEY": "fk_abcdefghijklmnop",
            }
        )
        rendered = json.dumps(settings.redacted_summary())
        assert "a" * 32 not in rendered
        assert "gk_abcdefghijklmnop" not in rendered
        assert "fk_abcdefghijklmnop" not in rendered
        assert "<set>" in rendered

    def test_unset_credentials_show_as_unset(self):
        summary = Settings(mock_mode=True).redacted_summary()
        assert summary["bridgeSecret"] == "<unset>"
        assert summary["fishKey"] == "<unset>"

    def test_config_is_immutable(self):
        settings = load_settings({"ASSISTANT_MOCK_MODE": "true"})
        with pytest.raises(Exception):
            settings.port = 9999  # type: ignore[misc]
