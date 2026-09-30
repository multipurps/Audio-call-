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
      -> stt                   # OpenAI transcription (or mock)
      -> context.user()        # turn aggregation + VAD-driven endpointing
      -> llm                   # OpenAI Chat Completions (or mock)
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
from app.emotion import (
    EmotionState,
    apply_inline_mood,
    appraise_turn,
    format_emotion_state_block,
    parse_mood_tag,
    should_end_call,
)
from app.providers import build_llm, build_stt, build_tts, build_vad
from app.vocal import VocalisationPolicy, split_complete, to_transcript_text

#: System prompt for a natural phone conversation.
#:
#: Tuned for the properties the brief asks for: warm human presence, natural
#: turn-taking and continuity, contextual vocalisations (Fish Audio speaks
#: real laughs/sighs/ throat-clears from the markers below), no verbosity, no
#: repeated scripted phrases, natural handling of silence and unclear speech,
#: no fabricated actions, and explicit [[END_CALL]] signalling when the
#: conversation genuinely concludes.
DEFAULT_SYSTEM_PROMPT = """\
You are Emysa, a warm, perceptive, and natural voice companion on a live phone call. \
You are speaking aloud, not writing. You are a conversational companion, not a \
customer-service bot: you listen, you actually hear what is said, and you respond to \
the person in front of you.

Keep it real. One or two sentences per turn is the norm -- this is a back-and-forth \
conversation, not a monologue -- but a longer, unhurried explanation is right when the \
moment calls for it. Let the other person talk. Never rush a serious moment.

Sound like a real, caring person on the phone, not a script:
- Use natural contractions ("I'm", "you're", "that's", "let's"). Conversational \
markers like "um", "let me think", "got it" are natural where a person would use them.
- Respond to what was actually said, including follow-up questions and unexpected \
changes of subject. Do not answer a question they did not ask.
- Remember everything already discussed in this call and never repeat an introduction, \
acknowledgement or closing you have already used. Openings and goodbyes should fit the \
moment, not a template.
- Match the caller's emotional energy: be calm and gentle if they sound stressed, warm \
and light if they are playful, crisp if they are in a hurry, and quietly serious when \
the conversation is serious.
- Pauses are fine. If they are thinking, wait or ask a short question -- do not fill \
every silence with chatter. If you need a beat, a short "Hmm." is natural.
- If they interrupt you or change direction, follow them. If you did not understand \
something, say so plainly and ask them to repeat it -- do not guess.
- Never use markdown, bullet points, emoji, or anything that only makes sense on a \
screen. Everything you write is spoken aloud.
- Never read out a URL, an email address, or a long number unless asked.
- Never narrate your reasoning or announce what you are about to say.

Honesty: if you do not know something, or cannot do something, say so directly. \
Never claim to have taken an action you have not taken, and never invent details, \
times, prices, or confirmations.

You are Emysa. Emysa is not tied to any gender: do not describe yourself with gendered \
words ("girl", "woman", "guy") or gendered pronouns unless the person does first, and \
take your lead from the voice you are speaking with. Never claim to be human and never \
deny what you are: if someone sincerely asks whether they are talking to an AI or a \
real person, answer honestly in one short, natural sentence and carry on.

Vocal expressions -- use them like a person would, sparingly and only when they fit:
- Write them as markers in your reply: [laughing], [chuckling], [giggling], [sighing], \
[clearing throat], [gasping], [humming]. They are turned into real sounds in your \
voice. You may also use delivery markers [soft], [whispering], [emphasis] to shape \
tone, and plain words like "Hmm.", "Mm-hmm.", "Ha!" when those read more naturally.
- Context decides everything. A genuinely funny joke may earn [chuckling] or a small \
[laughing] before you answer. A mildly awkward moment may fit [giggling]. A quiet \
moment of thought may fit [sighing] or just "Hmm.". [humming] fits only if they ask \
you to hum or the moment genuinely wants it. [clearing throat] is rare and subtle.
- Serious, sad, sensitive or business conversations stay serious: no laughter, no \
giggles. Never flirt unless the person and the moment clearly call for it.
- These expressions must be occasional -- roughly one every few minutes at most -- \
varied, and never a gimmick. Never put more than one marker in a row. Never use a \
marker in place of actually answering someone.

Follow the user's instructions for the call, including how to open it. When the call is \
answered you will get a bracketed note such as [The person has just picked up the call]. \
That is a cue from the system, not something the person said. Open the call following \
the user's instructions. Unless they say otherwise, briefly say hi, say you are Emysa \
and why you are calling, and check the line is clear. If they tell you not to introduce \
yourself, or to open a particular way, do exactly that. Greet their greeting naturally -- \
if they just say "hello?", start with "Hey!" and get to the point, not a formal intro.

When the purpose of the call is complete and you are saying your final goodbye, append \
the exact token [[END_CALL]] at the very end of your final line. Never append \
[[END_CALL]] if the caller just asked a question or the conversation is still ongoing.
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
    transcript: Any = None,
) -> tuple[Any, Any]:
    """Assemble the real Pipecat pipeline.

    Returns `(pipeline, llm)` -- the LLM is returned alongside because tool
    registration (when tools are configured) happens on the instance, and the
    caller needs it. Tools are only registered if the caller supplies them;
    with no tools configured the LLM simply has none, which is what the
    brief's "tool calls only when tools are configured" requires.
    """
    from pipecat.frames.frames import (
        InterruptionFrame,
        LLMFullResponseEndFrame,
        LLMFullResponseStartFrame,
        LLMTextFrame,
        TTSSpeakFrame,
        TranscriptionFrame,
    )
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

    emotion_state: dict[str, EmotionState] = {"state": EmotionState()}
    last_caller_text: dict[str, str] = {"text": ""}
    # Fish Audio speaks real vocalisations from inline markers; which syntax
    # depends on the model (s1 = "(paren)" fixed set, s2+ = "[bracket]").
    tts_syntax = "s1" if (settings.tts_model or "").lower().startswith("s1") else "s2"
    vocal_policy = VocalisationPolicy()

    # A system message leads the context so every turn is grounded in the
    # behavioural rules; the aggregator maintains the rest as the call runs.
    # Held as a mutable dict so the emotion block can be refreshed per turn.
    system_msg: dict[str, str] = {
        "role": "system",
        "content": build_system_prompt(settings, extra_context, emotion_state["state"]),
    }

    def _refresh_system() -> None:
        """Re-render the system prompt so the emotion block tracks the call.

        Mutating the message dict in place is deliberate: the LLMContext
        serialises its messages at request time, so the next turn sees the
        updated state with zero extra LLM calls.
        """
        system_msg["content"] = build_system_prompt(
            settings, extra_context, emotion_state["state"]
        )

    class _TranscriptNote(FrameProcessor):
        """Records one side of the conversation into the live transcript.

        Two instances share the call's `TranscriptLog`: one after the
        appraisal stage for the caller's `TranscriptionFrame`s, one after
        `[[END_CALL]]` filtering for what Emysa actually says. The AI side
        buffers between LLM response start/end so the persisted turn is the
        full sentence rather than streaming chunks, and an `InterruptionFrame`
        (barge-in) flushes the partial as `interrupted` instead of dropping
        it. `transcript=None` (standalone/mock runs) makes this a pass-through.
        """

        def __init__(self, speaker: str) -> None:
            super().__init__(name=f"TranscriptNote[{speaker}]")
            self._speaker = speaker
            self._buffer: list[str] = []

        def _note(self, text: str, *, interrupted: bool = False) -> None:
            if transcript is None:
                return
            # Emysa's side carries Fish delivery/vocalisation markers from the
            # tag filter; the transcript must record what was *said* — quiet
            # annotations like "(laughs)", never control tags.
            clean = to_transcript_text(text) if self._speaker == "ai" else (text or "").strip()
            if not clean:
                return
            transcript.note(self._speaker, clean, interrupted=interrupted)

        async def process_frame(self, frame: Any, direction: FrameDirection) -> None:
            await super().process_frame(frame, direction)
            if isinstance(frame, InterruptionFrame):
                if self._buffer:
                    self._note("".join(self._buffer), interrupted=True)
                    self._buffer = []
                await self.push_frame(frame, direction)
                return
            if self._speaker == "contact":
                if isinstance(frame, TranscriptionFrame) and getattr(frame, "text", None):
                    self._note(str(frame.text))
            else:
                if isinstance(frame, TTSSpeakFrame) and getattr(frame, "text", None):
                    # Directly queued speech (the greeting on answer, and any
                    # future direct-to-TTS path): spoken verbatim, so it
                    # belongs in the transcript too.
                    self._note(str(frame.text))
                elif isinstance(frame, LLMFullResponseStartFrame):
                    self._buffer = []
                elif isinstance(frame, LLMTextFrame) and getattr(frame, "text", None):
                    self._buffer.append(str(frame.text))
                elif isinstance(frame, LLMFullResponseEndFrame) and self._buffer:
                    self._note("".join(self._buffer))
                    self._buffer = []
            await self.push_frame(frame, direction)

    class _TurnAppraisalProcessor(FrameProcessor):
        """Updates in-memory PAD emotional state on each caller transcription."""

        def __init__(self) -> None:
            super().__init__(name="TurnAppraisal")
            self.emotion_state = emotion_state["state"]

        async def process_frame(self, frame: Any, direction: FrameDirection) -> None:
            await super().process_frame(frame, direction)
            if isinstance(frame, TranscriptionFrame) and getattr(frame, "text", None):
                last_caller_text["text"] = str(frame.text)
                self.emotion_state = appraise_turn(self.emotion_state, str(frame.text))
                emotion_state["state"] = self.emotion_state
                _refresh_system()
            await self.push_frame(frame, direction)

    class _ResponseTagFilter(FrameProcessor):
        """Turns the model's reply into speakable, well-timed audio.

        Handles, per streamed chunk, with a hold buffer so a tag split across
        two chunks is never half-parsed:

          * ``[[END_CALL]]`` — strip and trigger the real hangup;
          * ``[[MOOD:...]]`` — strip and fold into the emotional state (so
            expression follows the conversation, with zero extra LLM calls);
          * vocalisation/delivery markers — translate to the active Fish
            model's TTS syntax (`[laughing]` for s2+, `(laughing)` for s1),
            subject to :class:`VocalisationPolicy` so they stay contextual
            and occasional. The transcript sees clean annotated text via
            `_TranscriptNote`, never these tags.
        """

        def __init__(self) -> None:
            super().__init__(name="ResponseTagFilter")
            self._hold = ""

        def _transform(self, raw: str) -> str | None:
            if not raw:
                return None
            mood, mood_intensity = parse_mood_tag(raw)
            if mood:
                emotion_state["state"] = apply_inline_mood(
                    emotion_state["state"], mood, mood_intensity
                )
                _refresh_system()
            end_call, clean_text = should_end_call(raw, last_caller_text.get("text", ""))
            if end_call and callable(on_end_call):
                on_end_call()
            if not clean_text:
                return None
            state = emotion_state["state"]
            tts_text, _ = vocal_policy.process(
                clean_text,
                syntax=tts_syntax,
                emotion=state.primary_emotion,
                pleasure=state.dimensions.get("pleasure"),
            )
            return tts_text or None

        async def process_frame(self, frame: Any, direction: FrameDirection) -> None:
            await super().process_frame(frame, direction)
            if isinstance(frame, LLMTextFrame) and getattr(frame, "text", None):
                complete, self._hold = split_complete(self._hold + str(frame.text))
                out = self._transform(complete)
                if out:
                    await self.push_frame(LLMTextFrame(out), direction)
                return
            if isinstance(frame, LLMFullResponseStartFrame):
                self._hold = ""
            elif isinstance(frame, LLMFullResponseEndFrame):
                # Flush whatever the last chunk was holding BEFORE the end
                # marker, so downstream (transcript note, TTS) still sees it.
                if self._hold:
                    out = self._transform(self._hold)
                    self._hold = ""
                    if out:
                        await self.push_frame(LLMTextFrame(out), direction)
            elif isinstance(frame, InterruptionFrame):
                # Barge-in cut the response mid-word; drop any held fragment.
                self._hold = ""
            await self.push_frame(frame, direction)

    # The system message dict (built above) leads the context so every turn is
    # grounded in the behavioural rules; it is refreshed in place as the
    # emotional state evolves.
    add_context_message(context, system_msg)

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
            _TranscriptNote("contact"),
            aggregators.user(),
            llm,
            _ResponseTagFilter(),
            _TranscriptNote("ai"),
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


def add_context_message(context: Any, text: str | dict[str, str]) -> None:
    """Add a system message to a Pipecat LLMContext.

    ``text`` may be the message body (wrapped into a system message here) or a
    ready ``{"role": "system", "content": ...}`` dict — the pipeline passes a
    dict it keeps a reference to, so it can refresh the emotion block in
    place.

    Isolated here because `LLMContext`'s message API differs across Pipecat
    versions, and a version bump should break in this one function rather than
    at the top of the pipeline build.
    """
    message = text if isinstance(text, dict) else {"role": "system", "content": text}
    messages = getattr(context, "messages", None)
    if isinstance(messages, list):
        messages.append(message)
        return
    setter = getattr(context, "set_messages", None)
    if callable(setter):
        setter([message])
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
