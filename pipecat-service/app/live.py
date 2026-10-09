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

import array
import time
from typing import Any

from loguru import logger

from app.config import Settings
from app.conversation_policy import (
    audit_reply,
    build_structured_live_prompt,
    instructions_fingerprint,
    validate_live_instructions,
)
from app.expressive_context import build_personality_context
from app.pipeline import DEFAULT_SYSTEM_PROMPT

END_CALL_TOOL = "end_call"

# --------------------------------------------------------------------------
# Prompt: derived from the classic prompt so the persona cannot drift apart.
# --------------------------------------------------------------------------

_DROP_PREFIXES = (
    "Sounds, used sparingly:",
    # Replaced by the conversation policy (app/conversation_policy.py): the "react
    # first, often the whole turn is just a reaction" guidance produced the
    # automatic acknowledgements this policy exists to stop.
    "How real people talk",
    "Never say things an assistant says.",
)

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
    "up. That is a cue, not something they said. Open from the real purpose of the call: "
    "a short, natural hello, then why you are calling, in your own words. Never open with "
    "\"What's on your mind?\", \"What's going on?\" or \"How can I help?\", and do not "
    "start with a generic \"how are you\". Do not introduce yourself unless your brief "
    "says to, and never use a product, system or assistant name. If they ask who this is, "
    "say your name plainly. If your brief says to open a particular way, do exactly that. "
    "If they just say \"hello?\", answer warmly and carry on. When the purpose is done and "
    f"you have said your final goodbye, hand the backend the {END_CALL_TOOL} action to hang "
    "up. Never do that while they are still asking or talking."
)

_LIVE_POLICIES = f"""\
Backchannel policy: Stay quiet while they are telling you something. Make no \
acknowledgement sounds at all: no "hmm", "mm-hmm", "yeah", "right", "I see", "got it", \
"good", "great", "perfect" or "that's correct", and never cycle through different ones to \
seem varied. When they finish, answer directly, pause, disagree, ask one specific question, \
or continue with what you were saying. Never talk over the point they are making.

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

Backend work is silent. Do not announce it, do not say you are checking or waiting, \
and do not fill the time with a phrase. Never guess the result of backend work while \
waiting."""


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
            seen_opening = True  # owned by the OPENING STYLE section
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


def build_live_system_prompt(settings: Settings, extra_context: str | None = None, call_context: Any = None) -> str:
    """Instructions for a GPT-Live session. Fixed for the session's lifetime.

    Assembled in the fixed section order of app/conversation_policy.py unless an
    operator supplies the whole prompt (which then owns the persona outright).
    """
    # An operator-supplied prompt replaces the persona only. The private behaviour
    # rules, forbidden claims and opening style always apply, so it can never
    # switch the conversation policy off.
    persona = settings.system_prompt or _live_persona()
    personality = "" if settings.system_prompt else build_personality_context()
    return build_structured_live_prompt(
        persona=persona,
        personality=personality,
        policies=_LIVE_POLICIES,
        end_call_tool=END_CALL_TOOL,
        call_context=call_context,
        extra_context=extra_context,
    )


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
        self.session_id: str = "-"
        self.created_at: float = time.monotonic()
        self.session_started_at: float | None = None
        self.first_audio_ms: int | None = None
        self.turn_latencies_ms: list[int] = []
        self.audible_frames: int = 0
        self.end_call_requests: int = 0
        #: Caller interaction-state monitor (None when disabled). Its summary is
        #: stored on the call row when the call ends.
        self.caller_state: Any = None

    def ai_idle_secs(self, now: float | None = None) -> float:
        if self.ai_speaking_text:
            return 0.0
        if not self.last_ai_text_at:
            return float("inf")
        return (now if now is not None else time.monotonic()) - self.last_ai_text_at


# --------------------------------------------------------------------------
# Service + pipeline
# --------------------------------------------------------------------------


def live_log(session_id: str, event: str, level: str = "INFO", **fields: Any) -> None:
    """Production log line for GPT-Live: `[call <id>] [GPT-LIVE] <event> k=v`."""
    parts = " ".join(f"{k}={v}" for k, v in fields.items())
    logger.log(level, f"[call {session_id}] [GPT-LIVE] {event}" + (f" {parts}" if parts else ""))


def pcm16_is_audible(audio: bytes, threshold: int = 600) -> bool:
    """True when a PCM16 chunk carries real sound (the live stream sends silence too)."""
    n = len(audio) // 2
    if n == 0:
        return False
    samples = array.array("h")
    samples.frombytes(audio[: n * 2])
    return max(max(samples), -min(samples)) >= threshold


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


# --------------------------------------------------------------------------
# Instruction integrity
# --------------------------------------------------------------------------


def lock_live_instructions(llm: Any, instructions: str, session_id: str = "-") -> Any:
    """Make the session's instructions impossible to replace silently.

    ``instructions`` is validated (required sections present, no legacy
    directives). A later ``system_instruction`` settings update is dropped, and
    whatever is about to be sent as the session's instructions is checked to still
    contain the locked text; if it does not, the locked text is put back. Each
    intervention is logged with a fingerprint, never the content.
    """
    problems = validate_live_instructions(instructions)
    if problems:
        live_log(session_id, "instructions failed validation", level="ERROR", problems="; ".join(problems))
        raise RuntimeError("GPT-Live instructions are missing required policy: " + "; ".join(problems))
    fingerprint = instructions_fingerprint(instructions)
    llm._emysa_instruction_fingerprint = fingerprint  # noqa: SLF001 - read by tests and the session-start log
    llm._emysa_instructions = instructions  # noqa: SLF001

    original_update = getattr(llm, "_update_settings", None)
    if callable(original_update):

        async def _guarded_update(delta: Any) -> Any:
            from pipecat.services.settings import NOT_GIVEN, is_given

            incoming = getattr(delta, "system_instruction", NOT_GIVEN)
            if is_given(incoming) and incoming != instructions:
                live_log(
                    session_id,
                    "ignored a settings update that tried to replace the instructions",
                    level="WARNING",
                    lockedFingerprint=fingerprint,
                    attemptedFingerprint=instructions_fingerprint(str(incoming)),
                )
                delta.system_instruction = NOT_GIVEN
            return await original_update(delta)

        llm._update_settings = _guarded_update  # noqa: SLF001

    original_params = getattr(llm, "_invocation_params", None)
    if callable(original_params):

        def _guarded_params() -> Any:
            params = original_params()
            sent = params.get("instructions") if hasattr(params, "get") else None
            if instructions not in str(sent or ""):
                live_log(
                    session_id,
                    "session instructions diverged from the locked text; restored",
                    level="ERROR",
                    lockedFingerprint=fingerprint,
                    sentFingerprint=instructions_fingerprint(str(sent or "")),
                )
                params["instructions"] = instructions
            return params

        llm._invocation_params = _guarded_params  # noqa: SLF001
    return llm


def audit_spoken_reply(session_id: str, reply: str) -> list[str]:
    """Log (never rewrite) a spoken reply that breaks the conversation policy."""
    found = audit_reply(reply)
    if found:
        live_log(session_id, "reply broke the conversation policy", level="WARNING", violations=",".join(found))
    return found


def build_live_service(
    settings: Settings,
    *,
    system_instruction: str,
    on_end_call: Any,
    state: LiveCallState | None = None,
    session_id: str | None = None,
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

    sid = session_id or (state.session_id if state is not None else "-")
    lock_live_instructions(llm, system_instruction, sid)

    async def _end_call(params: Any) -> None:
        if state is not None:
            state.end_requested = True
            state.end_call_requests += 1
        live_log(sid, "delegation=end_call backend=luna (hang-up only; Luna is not the conversational LLM)")
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
            state.session_started_at = time.monotonic()
            live_log(sid, "session.created", id=getattr(_session, "id", "?"), instructions=getattr(llm, "_emysa_instruction_fingerprint", "?"))
            live_log(sid, f"model={settings.live_model}")
            live_log(
                sid,
                f"voice={settings.live_voice}",
                source=settings.live_voice_source,
                sentAs="audio.output.voice",
            )
            live_log(
                sid,
                "startup_ms_since_answer=%d" % int((state.session_started_at - state.created_at) * 1000),
            )

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
    session_id: str | None = None,
) -> tuple[Any, Any]:
    """Assemble the GPT-Live pipeline. Returns `(pipeline, llm)`."""
    from pipecat.frames.frames import (
        InputAudioRawFrame,
        InterruptionFrame,
        LLMFullResponseEndFrame,
        LLMFullResponseStartFrame,
        LLMTextFrame,
        ProposedUserStoppedSpeakingFrame,
        SpeechOutputAudioRawFrame,
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
    if session_id:
        st.session_id = session_id
    if llm is None:
        llm = build_live_service(
            settings,
            system_instruction=system_instruction,
            on_end_call=on_end_call,
            state=st,
            session_id=st.session_id,
        )

    class LiveLatencyProbe(FrameProcessor):
        """Measures real audible assistant audio, not just 'a frame was sent'.

        first_audio_ms: session started -> first audible output (the opening).
        turn_latency_ms: caller's turn ended -> first audible reply audio.
        """

        def __init__(self) -> None:
            super().__init__(name="LiveLatencyProbe")
            self._user_end: float | None = None
            self._awaiting = False
            self._last_audible = 0.0

        async def process_frame(self, frame: Any, direction: FrameDirection) -> None:
            await super().process_frame(frame, direction)
            now = time.monotonic()
            if isinstance(frame, ProposedUserStoppedSpeakingFrame):
                self._user_end = now
                # If the model was still talking, this is not a fresh reply to time.
                self._awaiting = (now - self._last_audible) > 0.4
            elif isinstance(frame, SpeechOutputAudioRawFrame) and pcm16_is_audible(frame.audio):
                st.audible_frames += 1
                if st.first_audio_ms is None and st.session_started_at is not None:
                    st.first_audio_ms = int((now - st.session_started_at) * 1000)
                    live_log(st.session_id, f"first_audio_ms={st.first_audio_ms}", audio="from gpt-live")
                if self._awaiting and self._user_end is not None:
                    ms = int((now - self._user_end) * 1000)
                    st.turn_latencies_ms.append(ms)
                    live_log(st.session_id, f"turn_latency_ms={ms}", note="caller speech end -> first audible gpt-live audio")
                    self._awaiting = False
                self._last_audible = now
            await self.push_frame(frame, direction)

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
            if clean and self._speaker == "ai":
                audit_spoken_reply(st.session_id, clean)  # flags only; never rewrites speech

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

    class CallerStateProbe(FrameProcessor):
        """Feeds caller audio + final caller transcripts to the state monitor.

        Observes only: every frame is passed on untouched. It never generates
        speech and never changes the pipeline; a state change becomes a private
        note on the live session via the monitor.
        """

        def __init__(self, monitor: Any) -> None:
            super().__init__(name="CallerStateProbe")
            self._monitor = monitor

        async def process_frame(self, frame: Any, direction: FrameDirection) -> None:
            await super().process_frame(frame, direction)
            if isinstance(frame, InputAudioRawFrame):
                self._monitor.on_audio(frame.audio, frame.sample_rate, ai_speaking=st.ai_speaking_text)
            elif isinstance(frame, TranscriptionFrame) and getattr(frame, "text", None):
                self._monitor.on_caller_transcript(str(frame.text))
            elif isinstance(frame, LLMFullResponseEndFrame):
                self._monitor.on_ai_finished()
            await self.push_frame(frame, direction)

    monitor = None
    if settings.caller_state_enabled:
        from app.caller_state import CallerStateMonitor

        async def _send_state_note(note: str) -> None:
            await send_private_note(llm, note)

        monitor = CallerStateMonitor(
            send_note=_send_state_note,
            log=lambda event, level="INFO", **kw: live_log(st.session_id, event, level, **kw),
        )
        st.caller_state = monitor

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
            *([CallerStateProbe(monitor)] if monitor is not None else []),
            LiveTranscriptNote("contact"),
            llm,
            LiveLatencyProbe(),
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
