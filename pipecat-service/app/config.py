"""Environment configuration for the assistant service.

Rules this module enforces, all of which come from the brief:

  * Every provider and model is selected by an environment variable, so the
    LLM/STT/TTS vendors are replaceable without a code change.
  * Missing required configuration fails **at startup**, loudly, rather than
    surfacing mid-call as a silent one-way audio path. A call that connects
    and then says nothing is the worst possible failure mode for this product.
  * No secret is ever defaulted to a real value. There is no fallback API key
    anywhere in this file, so a misconfigured deploy fails closed.
  * The env var names reuse the ones this repo already uses where one exists
    (`FISH_API_KEY`, `GROQ_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`)
    rather than introducing a second name for the same credential.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Mapping

# --------------------------------------------------------------------------
# Provider vocabularies. A provider is only listed here if an implementation
# actually exists in app/providers.py -- this list is not aspirational.
# --------------------------------------------------------------------------

STT_PROVIDERS = ("groq", "mock")
LLM_PROVIDERS = ("groq", "openai", "mock")
TTS_PROVIDERS = ("fish", "mock")

DEFAULT_STT_PROVIDER = "groq"
DEFAULT_LLM_PROVIDER = "groq"
DEFAULT_TTS_PROVIDER = "fish"

#: Groq is OpenAI-compatible, which is why the same OpenAI-compatible LLM
#: adapter serves both the "groq" and "openai" providers -- only base_url and
#: the key differ. This is a real API-compatibility fact, not a guess.
OPENAI_COMPATIBLE_BASE_URLS = {
    "groq": "https://api.groq.com/openai/v1",
    "openai": "https://api.openai.com/v1",
}

DEFAULT_STT_MODEL = "whisper-large-v3-turbo"
DEFAULT_LLM_MODEL = "llama-3.3-70b-versatile"


class ConfigError(RuntimeError):
    """Raised for invalid or missing configuration. Always fatal at startup."""


def _env(env: Mapping[str, str], key: str, default: str | None = None) -> str | None:
    value = env.get(key)
    if value is None:
        return default
    value = value.strip()
    return value if value else default


def _env_bool(env: Mapping[str, str], key: str, default: bool) -> bool:
    raw = _env(env, key)
    if raw is None:
        return default
    lowered = raw.lower()
    if lowered in ("1", "true", "yes", "on"):
        return True
    if lowered in ("0", "false", "no", "off"):
        return False
    raise ConfigError(f"{key} must be a boolean (true/false/1/0/yes/no), got {raw!r}")


def _env_int(
    env: Mapping[str, str], key: str, default: int, *, minimum: int = 0
) -> int:
    raw = _env(env, key)
    if raw is None:
        return default
    try:
        value = int(raw)
    except ValueError as exc:
        raise ConfigError(f"{key} must be an integer, got {raw!r}") from exc
    if value < minimum:
        raise ConfigError(f"{key} must be >= {minimum}, got {value}")
    return value


def _env_float(
    env: Mapping[str, str], key: str, default: float, *, minimum: float = 0.0
) -> float:
    raw = _env(env, key)
    if raw is None:
        return default
    try:
        value = float(raw)
    except ValueError as exc:
        raise ConfigError(f"{key} must be a number, got {raw!r}") from exc
    if value < minimum:
        raise ConfigError(f"{key} must be >= {minimum}, got {value}")
    return value


@dataclass(frozen=True)
class Settings:
    """Resolved, validated service configuration."""

    # -- transport -------------------------------------------------------
    host: str = "0.0.0.0"
    port: int = 8080

    #: Shared secret the PHP bridge must present in the `hello` control
    #: message. Required unless mock mode is on. Without it, anyone who can
    #: reach the Render URL can open a session and burn provider credit.
    bridge_secret: str | None = None

    #: Frames the pipeline should aim to emit/consume. The bridge's declared
    #: rate, independent of each carrier's native rate.
    bridge_sample_rate: int = 16000

    #: Seconds without any frame or heartbeat before the session is reaped.
    idle_timeout_secs: float = 30.0
    #: Seconds between server-initiated heartbeats.
    heartbeat_interval_secs: float = 10.0
    #: How many outbound audio frames may queue before the oldest is dropped.
    #: Real-time audio has no value once it is late, so the bound drops rather
    #: than grows -- growing it converts a latency problem into a memory leak.
    outbound_queue_max_frames: int = 100
    #: Largest inbound audio frame accepted, in bytes.
    max_frame_bytes: int = 64 * 1024

    # -- providers -------------------------------------------------------
    stt_provider: str = DEFAULT_STT_PROVIDER
    stt_model: str | None = None
    llm_provider: str = DEFAULT_LLM_PROVIDER
    llm_model: str | None = None
    llm_base_url: str | None = None
    llm_temperature: float = 0.7
    llm_max_tokens: int = 200
    tts_provider: str = DEFAULT_TTS_PROVIDER
    tts_voice_id: str | None = None
    tts_model: str | None = None

    # -- credentials -----------------------------------------------------
    groq_api_key: str | None = None
    openai_api_key: str | None = None
    fish_api_key: str | None = None

    # -- conversational behaviour ---------------------------------------
    system_prompt: str | None = None
    greeting: str | None = None
    #: Wall-clock ceiling on a single call, so a stuck call cannot hold a
    #: Render instance open indefinitely.
    max_call_seconds: float = 1800.0
    #: Consecutive silent turns before the assistant closes the call out.
    max_silent_turns: int = 3

    # -- optional persistent memory (explicitly feature-flagged) ----------
    #: Off by default. The brief calls for persistent user memory to sit
    #: behind an explicit flag, because it stores user data across calls.
    enable_persistent_memory: bool = False
    supabase_url: str | None = None
    supabase_service_role_key: str | None = None

    # -- testing ---------------------------------------------------------
    #: Runs the whole service with no network calls to any provider.
    mock_mode: bool = False

    # -- derived ---------------------------------------------------------

    def secret_values(self) -> tuple[str, ...]:
        """Every secret this process holds, for log redaction.

        Computed rather than stored so a frozen Settings instance stays
        immutable and a newly added credential cannot be forgotten here
        without also being forgotten in redacted_summary().
        """
        values = (
            self.bridge_secret,
            self.groq_api_key,
            self.openai_api_key,
            self.fish_api_key,
            self.supabase_service_role_key,
        )
        return tuple(v for v in values if v and len(v) >= 8)

    # -- validation ------------------------------------------------------

    def validate(self, env: Mapping[str, str] | None = None) -> None:
        """Fail fast on configuration that cannot produce a working call.

        Called once at startup. Every message names the exact variable to set,
        because the operator reading it is looking at a Render log at 2am.
        """
        env = env if env is not None else os.environ

        if self.stt_provider not in STT_PROVIDERS:
            raise ConfigError(
                f"ASSISTANT_STT_PROVIDER must be one of {STT_PROVIDERS}, "
                f"got {self.stt_provider!r}"
            )
        if self.llm_provider not in LLM_PROVIDERS:
            raise ConfigError(
                f"ASSISTANT_LLM_PROVIDER must be one of {LLM_PROVIDERS}, "
                f"got {self.llm_provider!r}"
            )
        if self.tts_provider not in TTS_PROVIDERS:
            raise ConfigError(
                f"ASSISTANT_TTS_PROVIDER must be one of {TTS_PROVIDERS}, "
                f"got {self.tts_provider!r}"
            )

        # Persistent memory is checked before the mock-mode early return: mock
        # mode removes the need for *provider* credentials, but it does not
        # give the process somewhere to store memory. Enabling the flag
        # without Supabase would otherwise fail on the first memory write,
        # mid-call, instead of here at startup.
        if self.enable_persistent_memory:
            if not self.supabase_url or not self.supabase_service_role_key:
                raise ConfigError(
                    "ASSISTANT_ENABLE_PERSISTENT_MEMORY=true requires "
                    "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY"
                )

        if self.mock_mode:
            # Mock mode exists precisely so the service runs with no
            # provider credentials at all. Everything below this point is a
            # credential requirement and is skipped.
            return

        if not self.bridge_secret:
            raise ConfigError(
                "ASSISTANT_BRIDGE_SECRET is required (or set "
                "ASSISTANT_MOCK_MODE=true for local testing). It must be the "
                "same value the PHP relay is configured with."
            )
        if len(self.bridge_secret) < 16:
            raise ConfigError(
                "ASSISTANT_BRIDGE_SECRET must be at least 16 characters. "
                "Generate one with: "
                "python -c \"import secrets;print(secrets.token_urlsafe(32))\""
            )

        if self.stt_provider == "groq" and not self.groq_api_key:
            raise ConfigError(
                "GROQ_API_KEY is required when ASSISTANT_STT_PROVIDER=groq"
            )
        if self.llm_provider == "groq" and not self.groq_api_key:
            raise ConfigError(
                "GROQ_API_KEY is required when ASSISTANT_LLM_PROVIDER=groq. "
                "Set ASSISTANT_LLM_PROVIDER=openai to use OPENAI_API_KEY instead."
            )
        if self.llm_provider == "openai" and not self.openai_api_key:
            raise ConfigError(
                "OPENAI_API_KEY is required when ASSISTANT_LLM_PROVIDER=openai"
            )
        if self.tts_provider == "fish" and not self.fish_api_key:
            raise ConfigError(
                "FISH_API_KEY is required when ASSISTANT_TTS_PROVIDER=fish"
            )

    # -- presentation ----------------------------------------------------

    def redacted_summary(self) -> dict[str, object]:
        """A loggable view of the configuration with all secrets removed.

        Deliberately explicit about each field rather than looping over
        `__dict__`: a new secret added later then has to be consciously
        classified here instead of leaking by default.
        """
        return {
            "host": self.host,
            "port": self.port,
            "bridgeSecret": "<set>" if self.bridge_secret else "<unset>",
            "bridgeSampleRate": self.bridge_sample_rate,
            "idleTimeoutSecs": self.idle_timeout_secs,
            "heartbeatIntervalSecs": self.heartbeat_interval_secs,
            "outboundQueueMaxFrames": self.outbound_queue_max_frames,
            "sttProvider": self.stt_provider,
            "sttModel": self.stt_model or DEFAULT_STT_MODEL,
            "llmProvider": self.llm_provider,
            "llmModel": self.llm_model or DEFAULT_LLM_MODEL,
            "llmBaseUrl": self.resolved_llm_base_url(),
            "ttsProvider": self.tts_provider,
            "ttsVoiceId": self.tts_voice_id or "<default>",
            "fishKey": "<set>" if self.fish_api_key else "<unset>",
            "groqKey": "<set>" if self.groq_api_key else "<unset>",
            "openaiKey": "<set>" if self.openai_api_key else "<unset>",
            "persistentMemory": self.enable_persistent_memory,
            "mockMode": self.mock_mode,
        }

    def resolved_llm_base_url(self) -> str:
        return (
            self.llm_base_url
            or OPENAI_COMPATIBLE_BASE_URLS.get(self.llm_provider, "")
        )

    def resolved_stt_model(self) -> str:
        return self.stt_model or DEFAULT_STT_MODEL

    def resolved_llm_model(self) -> str:
        return self.llm_model or DEFAULT_LLM_MODEL


def load_settings(env: Mapping[str, str] | None = None) -> Settings:
    """Build Settings from the environment and validate them."""
    env = env if env is not None else os.environ

    mock_mode = _env_bool(env, "ASSISTANT_MOCK_MODE", False)

    settings = Settings(
        host=_env(env, "ASSISTANT_HOST", "0.0.0.0") or "0.0.0.0",
        # Render injects PORT. Falling back to 8080 matches the other relays
        # in this repo (server/, server-social/).
        port=_env_int(env, "PORT", 8080, minimum=1),
        bridge_secret=_env(env, "ASSISTANT_BRIDGE_SECRET"),
        bridge_sample_rate=_env_int(env, "ASSISTANT_BRIDGE_SAMPLE_RATE", 16000, minimum=8000),
        idle_timeout_secs=_env_float(env, "ASSISTANT_IDLE_TIMEOUT_SECS", 30.0, minimum=1.0),
        heartbeat_interval_secs=_env_float(
            env, "ASSISTANT_HEARTBEAT_INTERVAL_SECS", 10.0, minimum=0.5
        ),
        outbound_queue_max_frames=_env_int(
            env, "ASSISTANT_OUTBOUND_QUEUE_MAX_FRAMES", 100, minimum=1
        ),
        max_frame_bytes=_env_int(env, "ASSISTANT_MAX_FRAME_BYTES", 64 * 1024, minimum=64),
        stt_provider=_env(env, "ASSISTANT_STT_PROVIDER", DEFAULT_STT_PROVIDER)
        or DEFAULT_STT_PROVIDER,
        stt_model=_env(env, "ASSISTANT_STT_MODEL"),
        llm_provider=_env(env, "ASSISTANT_LLM_PROVIDER", DEFAULT_LLM_PROVIDER)
        or DEFAULT_LLM_PROVIDER,
        llm_model=_env(env, "ASSISTANT_LLM_MODEL"),
        llm_base_url=_env(env, "ASSISTANT_LLM_BASE_URL"),
        llm_temperature=_env_float(env, "ASSISTANT_LLM_TEMPERATURE", 0.7),
        llm_max_tokens=_env_int(env, "ASSISTANT_LLM_MAX_TOKENS", 200, minimum=1),
        tts_provider=_env(env, "ASSISTANT_TTS_PROVIDER", DEFAULT_TTS_PROVIDER)
        or DEFAULT_TTS_PROVIDER,
        tts_voice_id=_env(env, "ASSISTANT_TTS_VOICE_ID"),
        tts_model=_env(env, "ASSISTANT_TTS_MODEL"),
        groq_api_key=_env(env, "GROQ_API_KEY"),
        openai_api_key=_env(env, "OPENAI_API_KEY"),
        fish_api_key=_env(env, "FISH_API_KEY"),
        system_prompt=_env(env, "ASSISTANT_SYSTEM_PROMPT"),
        greeting=_env(env, "ASSISTANT_GREETING"),
        max_call_seconds=_env_float(env, "ASSISTANT_MAX_CALL_SECONDS", 1800.0, minimum=10.0),
        max_silent_turns=_env_int(env, "ASSISTANT_MAX_SILENT_TURNS", 3),
        enable_persistent_memory=_env_bool(
            env, "ASSISTANT_ENABLE_PERSISTENT_MEMORY", False
        ),
        supabase_url=_env(env, "SUPABASE_URL"),
        supabase_service_role_key=_env(env, "SUPABASE_SERVICE_ROLE_KEY"),
        mock_mode=mock_mode,
    )

    settings.validate(env)
    return settings
