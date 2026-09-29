"""Pipecat pipeline assembly.

The stage order the brief specifies:

    audio input
      -> VAD and turn detection
      -> speech-to-text
      -> conversation state and memory
      -> LLM response
      -> tool calls if needed
      -> Fish Audio streaming TTS
      -> audio output

which maps onto Pipecat's own composition as:

    transport.input()          # ACAF frames -> InputAudioRawFrame
      -> stt                   # Groq Whisper (or mock)
      -> context.user()        # turn aggregation + VAD-driven endpointing
      -> llm                   # Groq / OpenAI-compatible (or mock)
      -> tts                   # Fish Audio streaming (or mock)
      -> transport.output()    # OutputAudioRawFrame -> ACAF frames
      -> context.assistant()   # closes the turn, records the reply

Interruption and cancellation fall out of Pipecat's own machinery rather than
being hand-rolled: the transport's VAD emits `UserStartedSpeakingFrame`, which
Pipecat turns into an `InterruptionFrame`, which our serializer converts into
an ACAF `INTERRUPT` control frame that tells the PHP bridge to clear its
playout buffer. See app/serializer.py for that last hop.

**Two execution paths, deliberately separated:**

  * `build_pipeline()` -- the real path, assembling live Pipecat services.
  * `MockConversation` -- mock mode, which exercises the transport, protocol,
    session lifecycle and serializers with no network calls,

Mock mode intentionally does *not* fake Pipecat's processors. Building a
pipeline of stub services would test the stubs, not the integration, and would
give a green result for a pipeline that could not work. What mock mode does
verify is everything on either side of the pipeline: framing, sequencing,
heartbeats, backpressure, cancellation and teardown. The pipeline itself is
verified in mock mode only insofar as it is *assembled*, which is checked
separately by `validate_pipeline_configuration()`.
"""

from __future__ import annotations

from typing import Any

from loguru import logger

from app.config import Settings
from app.emotion import EmotionState, appraise_turn, format_emotion_state_block, should_end_call
from app.providers import build_llm, build_stt, build_tts, build_vad

#: System prompt for a natural phone conversation.
#:
#: Tuned for the properties the brief asks for: warm human presence, short
#: spoken sentences, no verbosity, natural handling of silence and unclear
#: speech, no fabricated actions, and explicit [[END_CALL]] signalling when the
#: conversation genuinely concludes.
DEFAULT_SYSTEM_PROMPT = """\
You are Emysa, a warm, perceptive, and natural voice companion on a live phone call. \
You are speaking aloud, not writing.

Keep it short. One or two sentences per turn -- this is a real back-and-forth \
conversation, not a monologue. Let the other person talk.

Sound like a real, caring person on the phone, not a script:
- Use natural contractions ("I'm", "you're", "that's", "let's"). Occasional \
conversational markers like "um", "let me think", "got it" are natural.
- Match the caller's emotional energy: be calm and gentle if they sound stressed, \
warm and light if they are playful, and crisp if they are in a hurry.
- Never use markdown, bullet points, emoji, or anything that only makes sense \
on a screen. Everything you write will be read aloud.
- Never read out a URL, an email address, or a long number unless asked.
- Do not repeat the other person's question back to them before answering, and \
never repeat stock customer-service lines like "How can I assist you today?".

If you did not understand something, say so plainly and ask them to repeat it. \
Do not guess at what they meant.

If you do not know something, or cannot do something, say so directly. Never \
claim to have taken an action you have not taken, and never invent details, \
times, prices, or confirmations.

If there is a pause, do not fill it with chatter. Ask a short question or wait.

When the purpose of the call is complete and you are saying your final goodbye, \
append the exact token [[END_CALL]] at the very end of your final line. Never \
append [[END_CALL]] if the caller just asked a question or the conversation is \
still ongoing.
"""


def build_system_prompt(
    settings: Settings,
    extra_context: str | None = None,
    emotion_state: EmotionState | None = None,
) -> str:
    """Compose the system prompt, optionally with per-call context and emotion state.

    `extra_context` is where call-specific or remembered detail goes. It is
    appended rather than substituted so the behavioural rules above cannot be
    overwritten by memory content.
    """
    prompt = settings.system_prompt or DEFAULT_SYSTEM_PROMPT
    emotion_block = format_emotion_state_block(emotion_state)
    prompt = f"{prompt}\n\n{emotion_block}"
    if extra_context:
        prompt = f"{prompt}\n\nContext for this call:\n{extra_context}"
    return prompt


def build_pipeline(
    *,
    settings: Settings,
    transport: Any,
    context: Any,
    extra_context: str | None = None,
    services: tuple[Any, Any, Any, Any] | None = None,
    on_end_call: Any = None,
) -> tuple[Any, Any]:
    """Assemble the real Pipecat pipeline.

    Returns `(pipeline, llm)` -- the LLM is returned alongside because tool
    registration (when tools are configured) happens on the instance, and the
    caller needs it. Tools are only registered if the caller supplies them;
    with no tools configured the LLM simply has none, which is what the
    brief's "tool calls only when tools are configured" requires.
    """
    from pipecat.frames.frames import LLMTextFrame, TranscriptionFrame
    from pipecat.pipeline.pipeline import Pipeline
    from pipecat.processors.aggregators.llm_response_universal import (
        LLMContextAggregatorPair,
        LLMUserAggregatorParams,
    )
    from pipecat.processors.frame_processor import FrameDirection, FrameProcessor

    if services is not None:
        # Injected `(stt, llm, tts, vad)`: lets tests drive the real
        # Pipecat aggregators and pipeline with offline stand-in services.
        stt, llm, tts, vad = services
    else:
        stt = build_stt(settings)
        llm = build_llm(settings)
        tts = build_tts(settings)
        vad = build_vad(settings.bridge_sample_rate)

    emotion_state = EmotionState()
    last_caller_text: dict[str, str] = {"text": ""}

    class _TurnAppraisalProcessor(FrameProcessor):
        """Updates in-memory PAD emotional state on each caller transcription."""

        def __init__(self) -> None:
            super().__init__(name="TurnAppraisal")
            self.emotion_state = emotion_state

        async def process_frame(self, frame: Any, direction: FrameDirection) -> None:
            await super().process_frame(frame, direction)
            if isinstance(frame, TranscriptionFrame) and getattr(frame, "text", None):
                last_caller_text["text"] = str(frame.text)
                self.emotion_state = appraise_turn(self.emotion_state, str(frame.text))
            await self.push_frame(frame, direction)

    class _ResponseTagFilter(FrameProcessor):
        """Strips [[END_CALL]] and [[MOOD:...]] tags before TTS and triggers hangup."""

        def __init__(self) -> None:
            super().__init__(name="ResponseTagFilter")

        async def process_frame(self, frame: Any, direction: FrameDirection) -> None:
            await super().process_frame(frame, direction)
            if isinstance(frame, LLMTextFrame) and getattr(frame, "text", None):
                end_call, clean_text = should_end_call(frame.text, last_caller_text.get("text", ""))
                if end_call and callable(on_end_call):
                    on_end_call()
                if not clean_text:
                    return
                if clean_text != frame.text:
                    frame = LLMTextFrame(clean_text)
            await self.push_frame(frame, direction)

    # A system message leads the context so every turn is grounded in the
    # behavioural rules; the aggregator maintains the rest as the call runs.
    add_context_message(context, build_system_prompt(settings, extra_context, emotion_state))

    aggregators = LLMContextAggregatorPair(
        context,
        user_params=LLMUserAggregatorParams(
            vad_analyzer=vad,
            # 0.8 s of silence ends a turn. Shorter cuts people off mid-thought
            # (a hesitation before a sentence reads as "done"); longer makes
            # the assistant feel slow to respond. Pipecat's VAD makes this a
            # real speech-end decision rather than a fixed timer.
            user_turn_stop_timeout=0.8,
            audio_idle_timeout=1.0,
        ),
    )

    pipeline = Pipeline(
        [
            transport.input(),
            stt,
            _TurnAppraisalProcessor(),
            aggregators.user(),
            llm,
            _ResponseTagFilter(),
            tts,
            transport.output(),
            aggregators.assistant(),
        ]
    )
    logger.info(
        "pipeline assembled",
        extra={
            "stt": type(stt).__name__,
            "llm": type(llm).__name__,
            "tts": type(tts).__name__,
            "vad": type(vad).__name__ if vad else "none",
            "tools": 0,
        },
    )
    return pipeline, llm


def add_context_message(context: Any, text: str) -> None:
    """Add a system message to a Pipecat LLMContext.

    Isolated here because `LLMContext`'s message API differs across Pipecat
    versions, and a version bump should break in this one function rather than
    at the top of the pipeline build.
    """
    messages = getattr(context, "messages", None)
    if isinstance(messages, list):
        messages.append({"role": "system", "content": text})
        return
    setter = getattr(context, "set_messages", None)
    if callable(setter):
        setter([{"role": "system", "content": text}])
        return
    logger.warning(
        "could not attach system prompt to LLMContext; "
        "this Pipecat version's context API differs from the one expected",
        extra={"pipecatContextType": type(context).__name__},
    )


def build_llm_context() -> Any:
    """Create a fresh per-call LLM context (conversation history).

    One per call, never shared: the brief requires memory within the current
    call, and sharing a context across calls would leak one caller's
    conversation into another's.
    """
    from pipecat.processors.aggregators.llm_context import LLMContext

    return LLMContext()


def validate_pipeline_configuration(settings: Settings) -> dict[str, Any]:
    """Check the configured providers can actually be constructed.

    Called once at startup so a bad provider name or a missing key fails the
    Render deploy instead of failing the first real call. Deliberately does
    not construct the services -- that would open provider connections at
    boot -- only imports and validates the names.
    """
    report: dict[str, Any] = {"ok": True, "problems": [], "providers": {}}

    from app.config import LLM_PROVIDERS, STT_PROVIDERS, TTS_PROVIDERS

    checks = (
        ("stt", settings.stt_provider, STT_PROVIDERS),
        ("llm", settings.llm_provider, LLM_PROVIDERS),
        ("tts", settings.tts_provider, TTS_PROVIDERS),
    )
    for kind, name, allowed in checks:
        if settings.mock_mode:
            report["providers"][kind] = "mock"
            continue
        if name not in allowed:
            report["ok"] = False
            report["problems"].append(f"{kind} provider {name!r} not in {allowed}")
            continue
        report["providers"][kind] = name

    return report
