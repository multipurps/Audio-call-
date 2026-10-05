"""GPT-Live call engine (OpenAI `gpt-live-1`, speech to speech).

One model listens, thinks, speaks and writes the transcript, so this path has no
STT, no TTS, no VAD and no turn detection of its own:

    transport.input()            # ACAF frames -> InputAudioRawFrame
      -> context.user()          # turns an LLMRunFrame into the context that starts the session
      -> LiveTranscriptNote      # records the caller's side (final transcript per turn)
      -> llm (OpenAILiveLLMService)
      -> LiveTranscriptNote      # records what was actually said by the assistant
      -> transport.output()      # 24 kHz speech audio -> ACAF frames (resampled by the serializer)
      -> context.assistant()

What stays the same as the classic path: the bridge/transport, the paced audio
sender, the app's `calls` row and live transcript, the end-of-call report, the
operator notes, and the persona (the classic system prompt, minus everything that
only makes sense for Fish TTS or text output).

What is different, deliberately:
  * Fish voice clones cannot be spoken by GPT-Live. A call that carries a cloned
    voice stays on the classic engine (see Settings.engine_for_call).
  * Ending the call is the `end_call` tool, handled by the backend text model
    (Luna by default) that GPT-Live delegates to. The classic `[[END_CALL]]` token
    would simply be read aloud by a speech model.
  * The emotion engine's per-turn prompt rewrite is not used: a live session's
    instructions are fixed once it starts, and the model reads the room itself.
"""

from __future__ import annotations

import time
from typing import Any

from loguru import logger

from app.config import Settings
from app.expressive_context import build_personality_context
from app.pipeline import DEFAULT_SYSTEM_PROMPT

END_CALL_TOOL = "end_call"

# --------------------------------------------------------------------------
# Prompt: derived from the classic prompt so the persona cannot drift apart.
# --------------------------------------------------------------------------

_DROP_PREFIXES = ("Sounds, used sparingly:",)

_LIVE_PRIVATE_NOTES_OLD = 'a system message that starts "[Private note"'
_LIVE_PRIVATE_NOTES_NEW = 'private context that starts "[Private note"'

_LIVE_SPOKEN_OUTPUT = (
    "You are speaking, not writing. Say numbers, dates and addresses the way a person "
    "says them out loud, and never read out symbols, markup, URLs or long strings of "
    "digits unless asked. Never narrate your reasoning or announce what you are about "
    "to say."
)

_LIVE_OPENING_AND_ENDING = (
    "Opening and ending: when the call is answered you are told the person has picked "
    "up. That is a cue, not something they said. Open the way you would if you had just "
    "rung someone: a short, natural hello, maybe a \"how are you\", then let the call "
    "find its own pace. Do not introduce yourself unless your brief says to, and never "
    "use a product, system or assistant name. If they ask who this is, say your name "
    "plainly. If your brief says to open a particular way, do exactly that. If they "
    "just say \"hello?\", answer warmly and carry on. When the purpose is done and you "
    f"have said your final goodbye, hand the backend the {END_CALL_TOOL} action to hang "
    "up. Never do that while they are still asking or talking."
)

_LIVE_POLICIES = f"""\
Backchannel policy: Use light, occasional backchannels ("mm", "yeah") while they are \
telling you something. Never talk over the point they are making.

Interruption policy: Stop speaking when they interrupt. Listen to what they say, then \
follow them.

Delegation policy:
Backend tools:
- {END_CALL_TOOL}: hangs up the phone call.

Delegate to the backend when:
- The purpose of the call is done, you have said your final goodbye, and the call \
should end now.
- They clearly ask you to end the call or hang up.

Do not delegate to the backend when:
- They are still talking, asking something, or you are mid-conversation.
- You can answer from the conversation or the call context.
- You need a brief clarification.

Never guess the result of backend work while waiting."""


def _live_persona() -> str:
    """The classic prompt with the Fish/text-only parts replaced for a speech model."""
    out: list[str] = []
    seen_opening = seen_spoken = seen_notes = False
    for para in DEFAULT_SYSTEM_PROMPT.strip().split("\n\n"):
        head = para.lstrip()
        if head.startswith(_DROP_PREFIXES):
            continue
        if head.startswith("Everything you write is spoken aloud"):
            out.append(_LIVE_SPOKEN_OUTPUT)
            seen_spoken = True
            continue
        if head.startswith("Opening and ending:"):
            out.append(_LIVE_OPENING_AND_ENDING)
            seen_opening = True
            continue
        if _LIVE_PRIVATE_NOTES_OLD in para:
            para = para.replace(_LIVE_PRIVATE_NOTES_OLD, _LIVE_PRIVATE_NOTES_NEW)
            seen_notes = True
        out.append(para)
    # If the classic prompt is reworded, fail loudly in tests instead of silently
    # sending a prompt that still contains text-only instructions.
    if not (seen_opening and seen_spoken and seen_notes):
        raise RuntimeError(
            "DEFAULT_SYSTEM_PROMPT changed: update app/live.py::_live_persona to match"
        )
    return "\n\n".join(out)


def build_live_system_prompt(settings: Settings, extra_context: str | None = None) -> str:
    """Instructions for a GPT-Live session. Fixed for the session's lifetime."""
    if settings.system_prompt:
        # An operator-supplied prompt owns the persona outright (same rule as classic).
        prompt = settings.system_prompt
    else:
        prompt = f"{_live_persona()}\n\n{build_personality_context()}"
    prompt = f"{prompt}\n\n{_LIVE_POLICIES}"
    if extra_context:
        prompt = f"{prompt}\n\nContext for this call:\n{extra_context}"
    return prompt


BACKEND_INSTRUCTIONS = (
    "You are the backend for a live phone call, working for the speaker. Your only "
    f"action is {END_CALL_TOOL}, which hangs up the call. Call it only when the "
    "conversation is finished and a goodbye has been said, or when the speaker clearly "
    "asked to end the call. Otherwise reply in one short plain sentence."
)

#: What the model is told when the call is answered. The live service delivers a
#: trailing developer message as speakable context, so the model opens the call
#: itself, in its own words.
OPENING_CUE = (
    "The person you are calling has just picked up. Open the call now, in your own "
    "voice, the way your instructions describe."
)


def opening_cue(greeting: str | None = None) -> str:
    text = (greeting or "").strip()
    if not text:
        return OPENING_CUE
    return f"{OPENING_CUE} Open with something close to: {text}"


# --------------------------------------------------------------------------
# Call state shared between the pipeline and the conversation
# --------------------------------------------------------------------------


class LiveCallState:
    """What the conversation needs to know about the live session."""

    def __init__(self) -> None:
        self.last_ai_text_at: float = 0.0
        self.ai_speaking_text: bool = False
        self.end_requested: bool = False
        self.session_started: bool = False
        self.session_error: str | None = None

    def ai_idle_secs(self, now: float | None = None) -> float:
        if self.ai_speaking_text:
            return 0.0
        if not self.last_ai_text_at:
            return float("inf")
        return (now if now is not None else time.monotonic()) - self.last_ai_text_at


# --------------------------------------------------------------------------
# Service + pipeline
# --------------------------------------------------------------------------


def build_end_call_tools() -> Any:
    from pipecat.adapters.schemas.function_schema import FunctionSchema
    from pipecat.adapters.schemas.tools_schema import ToolsSchema

    return ToolsSchema(
        standard_tools=[
            FunctionSchema(
                name=END_CALL_TOOL,
                description=(
                    "Hang up the phone call. Use only after the final goodbye has been "
                    "said, or when the speaker clearly asked to end the call."
                ),
                properties={},
                required=[],
            )
        ]
    )


def build_live_context() -> Any:
    """Fresh per-call context holding only the tool. The prompt is NOT put here: the
    Live service takes it from Settings.system_instruction (a context system message
    is dropped when both exist, and the service composes its own addenda into it)."""
    from pipecat.processors.aggregators.llm_context import LLMContext

    return LLMContext(tools=build_end_call_tools())


def build_live_service(
    settings: Settings,
    *,
    system_instruction: str,
    on_end_call: Any,
    state: LiveCallState | None = None,
) -> Any:
    """The GPT-Live service with Responses delegation to the Luna backend."""
    from pipecat.services.openai.live.llm import OpenAILiveLLMService
    from pipecat.services.openai.responses.llm import (
        OpenAIResponsesLLMService,
        OpenAIResponsesReasoningConfig,
    )

    key = settings.live_api_key()
    if not key:
        raise RuntimeError("OPENAI_API_KEY (or LUNA_API_KEY) is required for GPT-Live calls")

    backend_kwargs: dict[str, Any] = {
        "model": settings.resolved_live_backend_model(),
        "system_instruction": BACKEND_INSTRUCTIONS,
        "max_completion_tokens": 200,
    }
    effort = (settings.llm_reasoning_effort or "").strip().lower()
    if effort in {"none", "low", "medium", "high", "xhigh", "max"}:
        # Same knob the classic path uses: "none" keeps the backend quick.
        backend_kwargs["reasoning"] = OpenAIResponsesReasoningConfig(effort=effort)

    llm = OpenAILiveLLMService(
        api_key=key,
        base_url=settings.live_base_url,
        settings=OpenAILiveLLMService.Settings(
            model=settings.live_model,
            voice=settings.live_voice,
            system_instruction=system_instruction,
        ),
        delegation=OpenAILiveLLMService.ResponsesDelegation(
            settings=OpenAIResponsesLLMService.Settings(**backend_kwargs),
        ),
    )

    async def _end_call(params: Any) -> None:
        if state is not None:
            state.end_requested = True
        logger.info("backend requested end_call")
        await params.result_callback(
            {"ok": True, "note": "The call is ending. If you have not already, say a brief goodbye."}
        )
        if callable(on_end_call):
            on_end_call()

    # Registered as a plain (non-async) tool: the Live service never cancels on
    # interruption anyway, and "async" tools make Pipecat append a paragraph to the
    # instructions about results arriving later, which is noise for a hang-up action.
    llm.register_function(END_CALL_TOOL, _end_call, cancel_on_interruption=True)

    if state is not None:

        @llm.event_handler("on_session_started")
        async def _started(_service: Any, _session: Any) -> None:
            state.session_started = True
            logger.info("gpt-live session started")

    return llm


def build_live_pipeline(
    *,
    settings: Settings,
    transport: Any,
    context: Any,
    system_instruction: str,
    transcript: Any = None,
    state: LiveCallState | None = None,
    on_end_call: Any = None,
    llm: Any = None,
) -> tuple[Any, Any]:
    """Assemble the GPT-Live pipeline. Returns `(pipeline, llm)`."""
    from pipecat.frames.frames import (
        InterruptionFrame,
        LLMFullResponseEndFrame,
        LLMFullResponseStartFrame,
        LLMTextFrame,
        TranscriptionFrame,
    )
    from pipecat.pipeline.pipeline import Pipeline
    from pipecat.processors.aggregators.llm_response_universal import (
        LLMContextAggregatorPair,
        LLMUserAggregatorParams,
    )
    from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
    from pipecat.turns.user_turn_strategies import ExternalUserTurnStrategies

    st = state if state is not None else LiveCallState()
    if llm is None:
        llm = build_live_service(
            settings, system_instruction=system_instruction, on_end_call=on_end_call, state=st
        )

    class LiveTranscriptNote(FrameProcessor):
        """Records one side of the call into the app's live transcript.

        The caller's final transcript arrives as a `TranscriptionFrame` pushed
        *upstream* from the live service, so that note sits just before it in the
        pipeline. The assistant's words stream between LLMFullResponseStart/End.
        """

        def __init__(self, speaker: str) -> None:
            super().__init__(name=f"LiveTranscriptNote[{speaker}]")
            self._speaker = speaker
            self._buffer: list[str] = []

        def _note(self, text: str, *, interrupted: bool = False) -> None:
            clean = (text or "").strip()
            if clean and transcript is not None:
                transcript.note(self._speaker, clean, interrupted=interrupted)

        async def process_frame(self, frame: Any, direction: FrameDirection) -> None:
            await super().process_frame(frame, direction)
            if self._speaker == "contact":
                if isinstance(frame, TranscriptionFrame) and getattr(frame, "text", None):
                    self._note(str(frame.text))
            else:
                if isinstance(frame, LLMFullResponseStartFrame):
                    self._buffer = []
                    st.ai_speaking_text = True
                elif isinstance(frame, LLMTextFrame) and getattr(frame, "text", None):
                    self._buffer.append(str(frame.text))
                    st.last_ai_text_at = time.monotonic()
                elif isinstance(frame, LLMFullResponseEndFrame):
                    if self._buffer:
                        self._note("".join(self._buffer))
                        self._buffer = []
                    st.ai_speaking_text = False
                    st.last_ai_text_at = time.monotonic()
                elif isinstance(frame, InterruptionFrame) and self._buffer:
                    self._note("".join(self._buffer), interrupted=True)
                    self._buffer = []
            await self.push_frame(frame, direction)

    aggregators = LLMContextAggregatorPair(
        context,
        # The model decides when the caller's turn starts and stops, and handles
        # being talked over itself, so the aggregator must not broadcast interruptions.
        user_params=LLMUserAggregatorParams(
            user_turn_strategies=ExternalUserTurnStrategies(enable_interruptions=False),
        ),
    )

    pipeline = Pipeline(
        [
            transport.input(),
            aggregators.user(),
            LiveTranscriptNote("contact"),
            llm,
            LiveTranscriptNote("ai"),
            transport.output(),
            aggregators.assistant(),
        ]
    )
    logger.info(
        "live pipeline assembled",
        extra={
            "model": settings.live_model,
            "voice": settings.live_voice,
            "backend": settings.resolved_live_backend_model(),
        },
    )
    return pipeline, llm


async def send_private_note(llm: Any, text: str) -> bool:
    """Give a running live session silent context (an operator note).

    Sent on the model's private "thinking" channel, which it can draw on without
    reading it aloud. Over-long text is chunked by the service's own helper.
    """
    from pipecat.services.openai.live import events
    from pipecat.services.openai.live.llm import MAX_CONTEXT_APPEND_TOKENS, _chunk_text

    clean = " ".join((text or "").split())
    if not clean:
        return False
    for chunk in _chunk_text(clean, MAX_CONTEXT_APPEND_TOKENS):
        await llm.send_client_event(events.SessionThinkingAppendEvent(delegation_id=None, content=chunk))
    return True
