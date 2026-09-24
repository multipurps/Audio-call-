"""Provider factories: STT, LLM, TTS, and the mock implementations.

Every provider is selected by environment variable (see app/config.py), so
swapping vendors is a config change rather than a code change. This module is
the single place that maps a provider name to an implementation, which is
what makes that promise true rather than aspirational.

**Mock mode** exists so the whole service -- transport, session lifecycle,
pipeline assembly, ACAF protocol -- can run and be tested with no Telegram
account, no Twilio account, and no provider keys. The brief asks for it
explicitly, and it is also the only way to test the pipeline deterministically
in CI without burning API credit or depending on a vendor's uptime.

The mocks are deliberately *not* trivial stubs that return empty audio: they
generate real PCM at the declared rate, and the mock LLM produces
deterministic, varied, short sentences. A mock that returns silence would let
a broken audio path pass every test.
"""

from __future__ import annotations

import math
import struct
import time
from typing import Any

from loguru import logger

from app.config import Settings

# --------------------------------------------------------------------------
# Mock audio
# --------------------------------------------------------------------------


def synthesize_tone(
    text: str,
    *,
    sample_rate: int,
    duration_ms: int | None = None,
    channels: int = 1,
) -> bytes:
    """Deterministic speech-like PCM16 for a piece of text.

    Not real speech: a low fundamental with two formant-ish harmonics whose
    frequencies are derived from a hash of the text. It is audible (so a human
    can hear the call working), deterministic (so tests can assert on it), and
    never silent (so a broken mixer cannot pass by accident).
    """
    digest = sum(ord(c) * (i + 1) for i, c in enumerate(text)) if text else 1
    fundamental = 90 + (digest % 60)  # 90-150 Hz, a plausible voice range
    if duration_ms is None:
        # Roughly conversational pace: ~14 characters per second of speech.
        duration_ms = max(300, int(len(text) / 14.0 * 1000))

    frames = int(sample_rate * duration_ms / 1000)
    out = bytearray()
    for i in range(frames):
        t = i / sample_rate
        # Fade in/out so concatenated utterances do not click at the seams.
        edge = min(i, frames - 1 - i) / max(1, int(sample_rate * 0.01))
        envelope = min(1.0, edge)
        value = (
            0.6 * math.sin(2 * math.pi * fundamental * t)
            + 0.25 * math.sin(2 * math.pi * fundamental * 2.1 * t)
            + 0.1 * math.sin(2 * math.pi * fundamental * 3.3 * t)
        )
        sample = int(max(-1.0, min(1.0, value * envelope * 0.7)) * 32767)
        for _ in range(channels):
            out += struct.pack("<h", sample)
    return bytes(out)


# --------------------------------------------------------------------------
# Mock LLM
# --------------------------------------------------------------------------

#: Short, natural, non-committal phone replies. Kept to one sentence each
#: deliberately: the brief requires the assistant not be verbose, and a mock
#: that produces paragraphs would hide latency and pacing problems in the
#: audio path.
MOCK_REPLIES = (
    "Sure, let me take a look.",
    "Got it, one moment.",
    "Okay, that makes sense.",
    "Right, I see what you mean.",
    "Hmm, let me think about that.",
    "Sorry, could you say that again?",
    "Alright, I'll check on that.",
    "Yep, I'm with you.",
)

MOCK_UNCLEAR_REPLIES = (
    "Sorry, I didn't catch that.",
    "Could you repeat that? It was a bit muffled.",
)


class MockLLM:
    """Deterministic stand-in for a conversational LLM.

    Rotates through replies by turn count so successive turns differ (which
    makes it obvious in a recording whether turn-taking works), and returns an
    "I didn't catch that" reply when the transcript is empty, which is the
    silence case the brief calls out.
    """

    def __init__(self, *, sample_rate: int = 16000) -> None:
        self.sample_rate = sample_rate
        self.turn_count = 0
        self.history: list[dict[str, str]] = []

    def respond(self, user_text: str) -> str:
        self.history.append({"role": "user", "content": user_text})
        if not user_text.strip():
            reply = MOCK_UNCLEAR_REPLIES[self.turn_count % len(MOCK_UNCLEAR_REPLIES)]
        else:
            reply = MOCK_REPLIES[self.turn_count % len(MOCK_REPLIES)]
        self.turn_count += 1
        self.history.append({"role": "assistant", "content": reply})
        return reply

    def reset(self) -> None:
        self.turn_count = 0
        self.history.clear()


class MockSTT:
    """Returns a fixed transcript so pipeline flow is testable end to end."""

    def __init__(self, transcript: str = "hello there") -> None:
        self.transcript = transcript
        self.calls = 0

    def transcribe(self, pcm: bytes) -> str:
        self.calls += 1
        return self.transcript


class MockTTS:
    """Generates real PCM via `synthesize_tone`, chunked into frames."""

    def __init__(self, *, sample_rate: int = 16000, frame_ms: int = 20) -> None:
        self.sample_rate = sample_rate
        self.frame_ms = frame_ms
        self.requests = 0

    def synthesize(self, text: str) -> bytes:
        self.requests += 1
        return synthesize_tone(text, sample_rate=self.sample_rate)

    def frames(self, text: str) -> list[bytes]:
        """Produce telephony-style fixed-size frames for the given text."""
        from app.audio import chunk_pcm16, pcm16_frame_bytes

        pcm = self.synthesize(text)
        size = pcm16_frame_bytes(self.sample_rate, self.frame_ms)
        return chunk_pcm16(pcm, size)


# --------------------------------------------------------------------------
# Provider factories
# --------------------------------------------------------------------------


def build_stt(settings: Settings) -> Any:
    """Construct the STT service, or a mock when in mock mode."""
    if settings.mock_mode or settings.stt_provider == "mock":
        logger.info("using mock STT")
        return MockSTT()

    if settings.stt_provider == "groq":
        from pipecat.services.groq.stt import GroqSTTService

        # Groq Whisper is batch, not streaming -- it cannot emit partial
        # results. This is a known limitation, recorded here because the
        # brief asks for partials "where supported" and this provider does
        # not support them. See docs/AI-VOICE-ASSISTANT-REPORT.md.
        return GroqSTTService(
            api_key=settings.groq_api_key,
            model=settings.resolved_stt_model(),
        )

    raise ValueError(f"unsupported STT provider {settings.stt_provider!r}")


def build_llm(settings: Settings) -> Any:
    """Construct the LLM service, or a mock when in mock mode."""
    if settings.mock_mode or settings.llm_provider == "mock":
        logger.info("using mock LLM")
        return MockLLM()

    if settings.llm_provider == "groq":
        from pipecat.services.groq.llm import GroqLLMService

        return GroqLLMService(
            api_key=settings.groq_api_key,
            model=settings.resolved_llm_model(),
        )

    if settings.llm_provider == "openai":
        from pipecat.services.openai.llm import OpenAILLMService

        return OpenAILLMService(
            api_key=settings.openai_api_key,
            model=settings.resolved_llm_model(),
        )

    raise ValueError(f"unsupported LLM provider {settings.llm_provider!r}")


def build_tts(settings: Settings) -> Any:
    """Construct the TTS service, or a mock when in mock mode.

    Fish Audio uses Pipecat's first-class `FishAudioTTSService`, which speaks
    Fish's WebSocket streaming API -- so streaming TTS is the default rather
    than something hand-rolled on top of the HTTP endpoint the rest of this
    repo currently uses.

    `output_format="pcm"` is chosen on purpose. Fish Audio can emit opus, mp3
    and wav, but PCM is Pipecat's native format and the serializer converts to
    the bridge's declared rate itself. Asking for a compressed format would add
    a decode step and a codec dependency for no benefit on a link that is
    already PCM.
    """
    if settings.mock_mode or settings.tts_provider == "mock":
        logger.info("using mock TTS")
        return MockTTS(sample_rate=settings.bridge_sample_rate)

    if settings.tts_provider == "fish":
        from pipecat.services.fish.tts import FishAudioTTSService

        kwargs: dict[str, Any] = {
            "api_key": settings.fish_api_key,
            "output_format": "pcm",
            "sample_rate": settings.bridge_sample_rate,
        }
        if settings.tts_voice_id:
            kwargs["reference_id"] = settings.tts_voice_id
        if settings.tts_model:
            kwargs["model_id"] = settings.tts_model
        return FishAudioTTSService(**kwargs)

    raise ValueError(f"unsupported TTS provider {settings.tts_provider!r}")


def build_vad(sample_rate: int) -> Any:
    """Construct the Silero VAD analyzer, or None if unavailable.

    Returning None rather than raising is deliberate: without a VAD the
    pipeline still works using its timeout-based turn detection, it is just
    slower to notice the caller has stopped. A missing optional native
    dependency should degrade latency, not prevent calls.
    """
    try:
        from pipecat.audio.vad.silero import SileroVADAnalyzer

        return SileroVADAnalyzer(sample_rate=sample_rate)
    except Exception as exc:  # noqa: BLE001 - optional native dependency
        logger.warning(
            "Silero VAD unavailable; falling back to timeout-based turn "
            "detection. Install with: pip install 'pipecat-ai[silero]'",
            extra={"error": type(exc).__name__},
        )
        return None


def provider_summary(settings: Settings) -> dict[str, Any]:
    """Names of the active providers, for /readyz. Contains no secrets."""
    return {
        "stt": "mock" if settings.mock_mode else settings.stt_provider,
        "sttModel": settings.resolved_stt_model(),
        "llm": "mock" if settings.mock_mode else settings.llm_provider,
        "llmModel": settings.resolved_llm_model(),
        "tts": "mock" if settings.mock_mode else settings.tts_provider,
        "mockMode": settings.mock_mode,
    }
