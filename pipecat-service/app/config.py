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
    (`FISH_API_KEY`, `OPENAI_API_KEY`, `LUNA_API_KEY`, `SUPABASE_URL`,
    `SUPABASE_SERVICE_ROLE_KEY`) rather than introducing a second name for the
    same credential. Groq support was removed entirely; there is deliberately
    no `GROQ_API_KEY` handling anywhere in this service.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from typing import Mapping

# --------------------------------------------------------------------------
# Provider vocabularies. A provider is only listed here if an implementation
# actually exists in app/providers.py -- this list is not aspirational.
# --------------------------------------------------------------------------

STT_PROVIDERS = ("openai", "mock")
LLM_PROVIDERS = ("luna", "openai", "mock")
TTS_PROVIDERS = ("fish", "mock")

DEFAULT_STT_PROVIDER = "openai"
DEFAULT_LLM_PROVIDER = "openai"
DEFAULT_TTS_PROVIDER = "fish"

#: "luna" and "openai" both resolve to OpenAI's Chat Completions API -- only
#: the model and which key the operator prefers differ. (Groq used to be a
#: third entry here; it was removed along with the rest of the Groq support.)
OPENAI_COMPATIBLE_BASE_URLS = {
    "luna": "https://api.openai.com/v1",
    "openai": "https://api.openai.com/v1",
}

#: Verified OpenAI model ids (https://developers.openai.com/api/docs/models):
#: gpt-4o-mini-transcribe is OpenAI's current speech-to-text model with a
#: better WER than whisper-1 at ~$0.003/min of audio. whisper-1 remains a
#: manual fallback via ASSISTANT_STT_MODEL=whisper-1 if ever needed.
#: gpt-6-luna is OpenAI's current general-purpose chat model.
DEFAULT_STT_MODEL = "gpt-4o-mini-transcribe"
DEFAULT_LLM_MODEL = "gpt-6-luna"

#: Call engines. "live" = OpenAI GPT-Live (one speech-to-speech model: it listens,
#: thinks, speaks and writes the transcript). "classic" = STT -> LLM -> Fish TTS.
#: "auto" (default) = GPT-Live, except a call that carries the user's cloned voice
#: (hello.voiceId) stays on "classic", because only Fish can speak a clone.
CALL_ENGINES = ("auto", "live", "classic")
DEFAULT_CALL_ENGINE = "auto"
DEFAULT_LIVE_MODEL = "gpt-live-1"
DEFAULT_LIVE_VOICE = "gleam"

#: GPT-Live built-in voices, copied from OpenAI's "Managing GPT-Live sessions" guide
#: (developers.openai.com/api/docs/guides/live-conversations, voice options table).
#: Set at session start as audio.output.voice. Mirrored in lib/liveVoices.js; a test
#: keeps the two lists identical. Do not add a voice here that the guide does not list.
LIVE_VOICES = (
    {"id": "quartz", "name": "Quartz", "language": "English", "accent": "Australian", "gender": "feminine"},
    {"id": "ripple", "name": "Ripple", "language": "English", "accent": "Australian", "gender": "masculine"},
    {"id": "vesper", "name": "Vesper", "language": "English", "accent": "British", "gender": "masculine"},
    {"id": "willow", "name": "Willow", "language": "English", "accent": "Irish", "gender": "feminine"},
    {"id": "stone", "name": "Stone", "language": "English", "accent": "Irish", "gender": "masculine"},
    {"id": "gleam", "name": "Gleam", "language": "English", "accent": "North American", "gender": "feminine"},
    {"id": "meridian", "name": "Meridian", "language": "English", "accent": "North American", "gender": "masculine"},
    {"id": "bossa", "name": "Bossa", "language": "Portuguese", "accent": "Brazilian", "gender": "feminine"},
    {"id": "tempo", "name": "Tempo", "language": "Portuguese", "accent": "Brazilian", "gender": "masculine"},
    {"id": "beacon", "name": "Beacon", "language": "English", "accent": "Filipino", "gender": "masculine"},
    {"id": "delta", "name": "Delta", "language": "English", "accent": "Southern U.S.", "gender": "feminine"},
    {"id": "cinder", "name": "Cinder", "language": "English", "accent": "Southern U.S.", "gender": "masculine"},
)
LIVE_VOICE_IDS = frozenset(v["id"] for v in LIVE_VOICES)


def normalise_live_voice(value: object) -> str | None:
    """A catalogued GPT-Live voice id, or None. Never forwards an unknown name."""
    if not isinstance(value, str):
        return None
    value = value.strip().lower()
    return value if value in LIVE_VOICE_IDS else None
DEFAULT_LIVE_BASE_URL = "wss://api.openai.com/v1/live/sessions"


def _clamp_float(raw, default, lo, hi):
    try:
        value = float(raw) if raw not in (None, '') else float(default)
    except (TypeError, ValueError):
        value = float(default)
    return max(lo, min(hi, value))


class ConfigError(RuntimeError):
    """Raised for invalid or missing configuration. Always fatal at startup."""


def _normalise_stt_provider(value: str | None) -> str:
    """Deepgram was removed. A deployment that still says "deepgram" keeps working on
    OpenAI STT instead of refusing to boot (a stale env var must not take calls down)."""
    provider = (value or DEFAULT_STT_PROVIDER).strip().lower()
    if provider == "deepgram":
        from loguru import logger

        logger.warning("ASSISTANT_STT_PROVIDER=deepgram is no longer supported; using openai")
        return "openai"
    return provider or DEFAULT_STT_PROVIDER


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
    #: How far ahead of real time outbound audio is released (seconds). A
    #: larger cushion rides out CPU/network jitter without audible skipping.
    send_lead_secs: float = 0.2
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
    #: reasoning_effort sent to OpenAI reasoning models (gpt-5+/gpt-6). "none"
    #: keeps voice turns fast; "" disables sending it (e.g. non-reasoning models).
    llm_reasoning_effort: str = "none"
    #: auto | live | classic -- see CALL_ENGINES.
    call_engine: str = DEFAULT_CALL_ENGINE
    live_model: str = DEFAULT_LIVE_MODEL
    live_voice: str = DEFAULT_LIVE_VOICE
    #: Where live_voice came from for THIS call: "user" (their saved Live voice) or
    #: "env-default" (they have not chosen one; ASSISTANT_LIVE_VOICE / built-in default).
    live_voice_source: str = "env-default"
    live_base_url: str = DEFAULT_LIVE_BASE_URL
    #: Text model GPT-Live hands tools / lookups / reasoning to. Defaults to the
    #: same Luna model the classic path uses (ASSISTANT_LLM_MODEL).
    live_backend_model: str | None = None
    #: How long after the callee answers a GPT-Live session may take to start before
    #: the call falls back to the classic engine.
    live_start_timeout_secs: float = 8.0
    tts_provider: str = DEFAULT_TTS_PROVIDER
    tts_voice_id: str | None = None
    #: True when tts_voice_id came from THIS call's hello (the user's own cloned
    #: voice) rather than the ASSISTANT_TTS_VOICE_ID default. Only a clone forces
    #: the classic engine, because only Fish can speak it.
    tts_voice_is_per_call: bool = False
    #: Fish speech speed (0.5-2.0) and volume in dB (-20..20). Calmer and
    #: quieter than Fish's defaults, which sounded rushed and loud on calls.
    tts_speed: float = 1.0
    tts_volume: int = 0
    # Fish sampling/latency knobs. None = the provider's own default.
    tts_latency: str | None = None
    tts_temperature: float | None = None
    tts_top_p: float | None = None
    tts_model: str | None = None

    # -- credentials -----------------------------------------------------
    openai_api_key: str | None = None
    luna_api_key: str | None = None
    fish_api_key: str | None = None

    # -- conversational behaviour ---------------------------------------
    system_prompt: str | None = None
    greeting: str | None = None
    #: Wall-clock ceiling on a single call, so a stuck call cannot hold a
    #: Render instance open indefinitely.
    max_call_seconds: float = 1800.0
    #: Consecutive silent turns before the assistant closes the call out.
    max_silent_turns: int = 3
    #: Whether the FIRST inbound audio frame counts as "the callee answered".
    #: Off by default: the provider's own answer event (ACAF `call_active`)
    #: is the source of truth — WaCalls and mp-relay both send it — and
    #: treating early audio as an answer starts the conversation timer while
    #: the phone is still ringing. Turn this on only for a legacy relay that
    #: cannot signal the answer.
    answer_on_first_audio: bool = False

    # -- optional persistent memory (explicitly feature-flagged) ----------
    #: Off by default. The brief calls for persistent user memory to sit
    #: behind an explicit flag, because it stores user data across calls.
    enable_persistent_memory: bool = False
    supabase_url: str | None = None
    supabase_service_role_key: str | None = None

    # -- app-database integration (call context + live transcript) --------
    #: How long to wait for the app's `calls` row to appear at call start
    #: (Vercel writes it just before the carrier dials). Bounded so a lost
    #: row delays the greeting by seconds, not minutes.
    context_timeout_secs: float = 20.0
    #: Public base URL of the app (Vercel) — used to report a call's end
    #: back through /api/social-calling so the shared summary runs when the
    #: carrier's own outcome callback never arrived. Optional: without it,
    #: end-of-call falls back to a direct status write (no summary trigger).
    public_app_url: str | None = None
    #: Noise-guidance prompt for the transcription API (optional).
    stt_prompt: str | None = None

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
            self.openai_api_key,
            self.luna_api_key,
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
        if self.call_engine not in CALL_ENGINES:
            raise ConfigError(
                f"ASSISTANT_CALL_ENGINE must be one of {CALL_ENGINES}, "
                f"got {self.call_engine!r}"
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

        if self.stt_provider == "openai" and not (
            self.openai_api_key or self.luna_api_key
        ):
            raise ConfigError(
                "OPENAI_API_KEY (or LUNA_API_KEY) is required when "
                "ASSISTANT_STT_PROVIDER=openai. Groq STT was removed; there "
                "is no other provider to fall back to."
            )
        if self.llm_provider in ("openai", "luna") and not (
            self.luna_api_key or self.openai_api_key
        ):
            raise ConfigError(
                f"LUNA_API_KEY or OPENAI_API_KEY is required when "
                f"ASSISTANT_LLM_PROVIDER={self.llm_provider}"
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
            "llmModel": self.resolved_llm_model(),
            "llmBaseUrl": self.resolved_llm_base_url(),
            "ttsProvider": self.tts_provider,
            "ttsVoiceId": self.tts_voice_id or "<default>",
            "fishKey": "<set>" if self.fish_api_key else "<unset>",
            "openaiKey": "<set>" if self.openai_api_key else "<unset>",
            "lunaKey": "<set>" if self.luna_api_key else "<unset>",
            "persistentMemory": self.enable_persistent_memory,
            "contextTimeoutSecs": self.context_timeout_secs,
            "publicAppUrl": bool(self.public_app_url),
            "mockMode": self.mock_mode,
        }

    def resolved_live_backend_model(self) -> str:
        return self.live_backend_model or self.resolved_llm_model()

    def live_api_key(self) -> str | None:
        return self.openai_api_key or self.luna_api_key

    def engine_for_call(self) -> str:
        """Which engine runs a call: "live" or "classic".

        A cloned voice (Fish) can only be spoken by the classic path, so an
        "auto" call that carries one stays classic. "live" forces GPT-Live
        even then (the clone is ignored); "classic" is the kill switch back
        to the old pipeline. Mock mode is always classic.
        """
        if self.mock_mode or self.call_engine == "classic":
            return "classic"
        if self.call_engine == "live":
            return "live"
        if self.tts_voice_is_per_call:
            return "classic"
        return "live" if self.live_api_key() else "classic"

    def resolved_llm_base_url(self) -> str:
        return (
            self.llm_base_url
            or OPENAI_COMPATIBLE_BASE_URLS.get(self.llm_provider, "")
        )

    def resolved_stt_model(self) -> str:
        return self.stt_model or DEFAULT_STT_MODEL

    def resolved_llm_model(self) -> str:
        if self.llm_model:
            return self.llm_model
        # luna and openai both run on OpenAI; the default model is the same.
        return DEFAULT_LLM_MODEL

    def resolved_llm_api_key(self) -> str:
        if self.llm_provider == "luna":
            return self.luna_api_key or self.openai_api_key or ""
        if self.llm_provider == "openai":
            return self.openai_api_key or self.luna_api_key or ""
        return ""


def load_settings(env: Mapping[str, str] | None = None) -> Settings:
    """Build Settings from the environment and validate them."""
    env = env if env is not None else os.environ

    mock_mode = _env_bool(env, "ASSISTANT_MOCK_MODE", False)

    luna_key = _env(env, "LUNA_API_KEY") or _env(env, "LLM_API_KEY")
    default_llm_prov = "luna" if luna_key and not _env(env, "ASSISTANT_LLM_PROVIDER") else DEFAULT_LLM_PROVIDER

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
        send_lead_secs=_env_float(env, "ASSISTANT_SEND_LEAD_SECS", 0.2, minimum=0.02),
        max_frame_bytes=_env_int(env, "ASSISTANT_MAX_FRAME_BYTES", 64 * 1024, minimum=64),
        stt_provider=_normalise_stt_provider(_env(env, "ASSISTANT_STT_PROVIDER", DEFAULT_STT_PROVIDER)),
        # A Deepgram model name (e.g. nova-3-general) means nothing to OpenAI STT.
        stt_model=None
        if (_env(env, "ASSISTANT_STT_PROVIDER") or "").lower() == "deepgram"
        else _env(env, "ASSISTANT_STT_MODEL"),
        llm_provider=_env(env, "ASSISTANT_LLM_PROVIDER", default_llm_prov)
        or default_llm_prov,
        llm_model=_env(env, "ASSISTANT_LLM_MODEL") or _env(env, "LUNA_MODEL") or _env(env, "LLM_MODEL"),
        llm_base_url=_env(env, "ASSISTANT_LLM_BASE_URL") or _env(env, "LUNA_BASE_URL") or _env(env, "LLM_BASE_URL"),
        llm_temperature=_env_float(env, "ASSISTANT_LLM_TEMPERATURE", 0.7),
        llm_max_tokens=_env_int(env, "ASSISTANT_LLM_MAX_TOKENS", 200, minimum=1),
        llm_reasoning_effort=(_env(env, "ASSISTANT_LLM_REASONING_EFFORT") or "none").strip().lower(),
        call_engine=(_env(env, "ASSISTANT_CALL_ENGINE") or DEFAULT_CALL_ENGINE).strip().lower(),
        live_model=_env(env, "ASSISTANT_LIVE_MODEL", DEFAULT_LIVE_MODEL) or DEFAULT_LIVE_MODEL,
        live_voice=(_env(env, "ASSISTANT_LIVE_VOICE", DEFAULT_LIVE_VOICE) or DEFAULT_LIVE_VOICE).strip().lower(),
        live_base_url=_env(env, "ASSISTANT_LIVE_BASE_URL", DEFAULT_LIVE_BASE_URL) or DEFAULT_LIVE_BASE_URL,
        live_backend_model=_env(env, "ASSISTANT_LIVE_BACKEND_MODEL"),
        live_start_timeout_secs=_clamp_float(_env(env, "ASSISTANT_LIVE_START_TIMEOUT_SECS"), 8.0, 2.0, 30.0),
        tts_provider=_env(env, "ASSISTANT_TTS_PROVIDER", DEFAULT_TTS_PROVIDER)
        or DEFAULT_TTS_PROVIDER,
        tts_voice_id=_env(env, "ASSISTANT_TTS_VOICE_ID"),
        tts_speed=_clamp_float(_env(env, "ASSISTANT_TTS_SPEED"), 1.0, 0.5, 2.0),
        tts_volume=int(_clamp_float(_env(env, "ASSISTANT_TTS_VOLUME"), 0, -20, 20)),
        # Pipecat's Fish service defaults to "balanced" (lower quality, a few
        # hundred ms faster). Natural prosody matters more on a call than that
        # saving, so default to "normal"; ASSISTANT_TTS_LATENCY=balanced opts out.
        tts_latency=(_env(env, "ASSISTANT_TTS_LATENCY") or "").lower() if (_env(env, "ASSISTANT_TTS_LATENCY") or "").lower() in ("normal", "balanced") else "normal",
        tts_temperature=_clamp_float(_env(env, "ASSISTANT_TTS_TEMPERATURE"), -1, 0.0, 1.0) if _env(env, "ASSISTANT_TTS_TEMPERATURE") else None,
        tts_top_p=_clamp_float(_env(env, "ASSISTANT_TTS_TOP_P"), -1, 0.0, 1.0) if _env(env, "ASSISTANT_TTS_TOP_P") else None,
        tts_model=_env(env, "ASSISTANT_TTS_MODEL"),
        openai_api_key=_env(env, "OPENAI_API_KEY"),
        luna_api_key=luna_key,
        fish_api_key=_env(env, "FISH_API_KEY"),
        system_prompt=_env(env, "ASSISTANT_SYSTEM_PROMPT"),
        greeting=_env(env, "ASSISTANT_GREETING"),
        max_call_seconds=_env_float(env, "ASSISTANT_MAX_CALL_SECONDS", 1800.0, minimum=10.0),
        max_silent_turns=_env_int(env, "ASSISTANT_MAX_SILENT_TURNS", 3),
        answer_on_first_audio=_env_bool(env, "ASSISTANT_ANSWER_ON_FIRST_AUDIO", False),
        enable_persistent_memory=_env_bool(
            env, "ASSISTANT_ENABLE_PERSISTENT_MEMORY", False
        ),
        supabase_url=_env(env, "SUPABASE_URL"),
        supabase_service_role_key=_env(env, "SUPABASE_SERVICE_ROLE_KEY"),
        context_timeout_secs=_env_float(env, "ASSISTANT_CONTEXT_TIMEOUT_SECS", 20.0, minimum=1.0),
        public_app_url=_env(env, "PUBLIC_APP_URL"),
        stt_prompt=_env(env, "ASSISTANT_STT_PROMPT"),
        mock_mode=mock_mode,
    )

    settings.validate(env)
    return settings


#: Fish Audio reference ids are opaque hex-ish tokens. Anything else (spaces,
#: slashes, quotes) is refused rather than forwarded to the TTS vendor, since
#: the id arrives over the bridge and ends up in an outbound API request.
_VOICE_ID_RE = re.compile(r"^[A-Za-z0-9_-]{8,64}$")


def sanitize_voice_id(value: object) -> str | None:
    """Return a safe per-call TTS voice id, or None to use the default voice."""
    if not isinstance(value, str):
        return None
    value = value.strip()
    return value if _VOICE_ID_RE.match(value) else None


_REASONING_MODEL_RE = re.compile(r"^(o[1-9]|gpt-[5-9])", re.IGNORECASE)
_VALID_EFFORTS = frozenset({"none", "low", "medium", "high", "xhigh", "max"})


def llm_reasoning_extra(model: str, effort: str) -> dict[str, str]:
    """Extra request params for OpenAI reasoning models; {} for everything else.

    gpt-6 defaults to a slow medium reasoning effort, which shows up on a phone
    call as seconds of dead air. Non-reasoning models (gpt-4o-mini...) reject
    the parameter, so it is only sent when the model name is a reasoning model.
    """
    bare = (model or "").split("/", 1)[-1]
    if not _REASONING_MODEL_RE.match(bare):
        return {}
    effort = (effort or "").strip().lower()
    return {"reasoning_effort": effort} if effort in _VALID_EFFORTS else {}
