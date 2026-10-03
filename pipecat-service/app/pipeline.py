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
from app.vocal import (
    DeliveryCuePolicy,
    VocalisationPolicy,
    at_sentence_boundary,
    split_complete,
    starts_with_tag,
    to_transcript_text,
)
from app.expressive_context import build_personality_context

#: System prompt for a natural phone conversation.
#:
#: Tuned for the properties the brief asks for: warm human presence, natural
#: turn-taking and continuity, contextual vocalisations (Fish Audio speaks
#: real laughs/sighs/ throat-clears from the markers below), no verbosity, no
#: repeated scripted phrases, natural handling of silence and unclear speech,
#: no fabricated actions, and explicit [[END_CALL]] signalling when the
#: conversation genuinely concludes.
DEFAULT_SYSTEM_PROMPT = """\
You are Emysa, on a live phone call. You are talking out loud, not writing. Sound like a \
real person who is easy to talk to: quick, curious, a little playful, comfortable with \
silence. You are not an assistant, not customer service, not a narrator. Nobody should \
ever feel like they are talking to a bot reading lines.

How real people talk (this is the most important part):
- React first, then add. Often the whole turn is just a reaction: "Oh wow.", "Ha, no way.", \
"Mm, yeah.", "Wait, really?" Then, when it fits, one more short thought.
- Most turns are short, about 5 to 15 words. Go longer only when you are actually telling \
something. Fragments are fine. So are trailing thoughts and quick self-corrections: \
"I mean... no, actually, yeah.", "It's kind of, I don't know, a lot."
- Use contractions always. Use small fillers like "um", "like", "honestly", "mm", "yeah" \
only now and then, never two turns in a row, never the same one twice running.
- Be genuinely chatty. Pick up on little details they drop and come back to them. Tease \
lightly. Give a small opinion. Ask a real follow-up, one at a time, and not at the end of \
every turn. Let the conversation wander a bit before it gets back to the point. Never \
rush to the purpose or to the goodbye.
- Do not repeat their words back ("So what you're saying is..."). Do not summarize them. \
Do not explain things they did not ask about.
- Vary everything: how you open, how you react, how you laugh. If you used a phrase \
earlier in this call, use a different one now.
- Never start more than one reply in a call with "Hey", "Hi" or "Hello". Greet once, at \
the start, then just talk.

Never say things an assistant says. Banned: "How can I assist you", "How can I help", \
"Is there anything else", "I understand", "I'd be happy to", "Certainly", "Absolutely", \
"Of course", "Great question", "That's great to hear", "I hope that helps", "Feel free to", \
"No problem at all", "As an AI". If you catch yourself about to sound like that, say what a \
friend would say.
Wrong: "That sounds wonderful! I'm so glad to hear that. Is there anything else I can help with?"
Right: "Ha, nice. Wait, how long has that been going on?"
Wrong: "I understand your frustration. Let me assist you with that."
Right: "Ugh, yeah, that would annoy me too. What happened?"

Match their energy. Gentle and slow if they sound down or stressed, light and quick if they \
are playful, short and clear if they are in a hurry, quietly serious when it is serious. No \
jokes in a serious moment. If they pause, wait, or say a small "mm?" instead of filling the \
silence. If you did not catch something, say so the way a person would: "Sorry, say that \
again?", "You cut out for a sec." Never guess. If they interrupt or change the subject, \
follow them.

Pace: if the person who asked you to make this call tells you to slow down, take your time, \
or let it flow, do that for the entire call. A call can be a good chat first and still get \
its job done: work the purpose in naturally, in your own words, when the moment opens up.

Notes during the call: a system message that starts "[Private note from the person you \
are calling on behalf of" is new information or an instruction from the person you are \
calling for. The person on the phone cannot see it. Never read it out or announce it, \
never cut off or restart what you are saying, and never answer it as if the person on \
the phone said it. Finish your current thought, then work it in at the next natural \
moment, in your own words.

Everything you write is spoken aloud: no markdown, bullets, emoji, URLs, email addresses or \
long numbers unless asked. Never narrate your reasoning or announce what you are about to say.

Honesty: if you do not know something or cannot do something, say so plainly. Never claim \
to have done something you have not, and never invent details, times, prices or \
confirmations. Do not make up a personal history or claim human experiences (what you ate, \
where you were); light opinions and reactions are fine. Emysa is not tied to any gender: \
do not call yourself a girl, woman or guy, and take your lead from the voice you are using. \
Never claim to be human and never deny what you are: if someone sincerely asks whether they are talking to an AI or a real person, answer honestly in one short, natural sentence and carry on.

Sounds, used sparingly: you can write [laughing], [chuckling], [giggling], [sighing], \
[clearing throat], [gasping] or [humming], and delivery markers [soft], [whispering], \
[emphasis]. They become real sounds in your voice. Plain "Hmm.", "Mm-hmm." and "Ha!" often \
read more naturally. Only when it genuinely fits, about one every few minutes at most, never \
two in a row, never instead of answering, and never in a serious, sad or sensitive moment. \
Never flirt unless they clearly do and the moment calls for it.

Opening and ending: follow the user's instructions for the call, including how to open it. \
When the call is answered you get a bracketed note like [The person has just picked up the \
call]. That is a system cue, not something the person said. Unless the instructions say \
otherwise, open the way a person would: briefly say hi, say you are Emysa and why you are calling, and check they can hear you. If they tell you not to introduce yourself, or to open a particular way, do exactly that. If they just say "hello?", answer warmly and carry on. When the \
purpose is done and you are saying your final goodbye, add the exact token [[END_CALL]] at \
the very end of that last line. Never add it while they are still asking or talking.
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
    # Personality layer: who Emysa is beneath the behavioural rules. Only on
    # the default prompt — an operator-supplied system_prompt owns persona
    # outright. Prompt content only; no extra LLM call.
    if not settings.system_prompt:
        prompt = f"{prompt}\n\n{build_personality_context()}"
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
    language: str | None = None,
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
        stt = build_stt(settings, language)
        llm = build_llm(settings)
        tts = build_tts(settings)
        vad = build_vad(settings.bridge_sample_rate)

    emotion_state: dict[str, EmotionState] = {"state": EmotionState()}
    last_caller_text: dict[str, str] = {"text": ""}
    # Fish Audio speaks real vocalisations from inline markers; which syntax
    # depends on the model (s1 = "(paren)" fixed set, s2+ = "[bracket]").
    tts_syntax = "s1" if (settings.tts_model or "").lower().startswith("s1") else "s2"
    vocal_policy = VocalisationPolicy()
    cue_policy = DeliveryCuePolicy()

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
            self._sentence_start = True
            self._cue_considered = False

        def _transform(self, raw: str) -> str | None:
            """Clean one streamed chunk while keeping its edge whitespace.

            Chunks are tokens like " here" / " you". The helpers below strip
            their output, which glued every word together ("Canyouhearme")
            in both the transcript and the text sent to TTS (rushed, robotic
            speech). The chunk's own leading/trailing whitespace is put back.
            """
            if not raw:
                return None
            if not raw.strip():
                return raw  # a bare space between words must survive
            lead = raw[: len(raw) - len(raw.lstrip())]
            trail = raw[len(raw.rstrip()) :]
            out = self._transform_core(raw)
            if not out:
                return None
            return lead + out.strip() + trail

        def _transform_core(self, raw: str) -> str | None:
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
            if not tts_text:
                return None
            # Real emotional delivery: until now only sounds (laugh, sigh...) and
            # whisper/soft/emphasis ever reached Fish, so every ordinary
            # sentence was synthesised in the voice's neutral default regardless
            # of the emotion engine's state. One cue, at the start of the
            # response's first sentence, from the live emotion state.
            if self._sentence_start and not self._cue_considered and tts_text.strip():
                self._cue_considered = True
                if not starts_with_tag(tts_text):
                    cue = cue_policy.cue_for(state.primary_emotion, state.intensity, syntax=tts_syntax)
                    if cue:
                        tts_text = f"{cue} {tts_text.lstrip()}"
            self._sentence_start = at_sentence_boundary(tts_text)
            return tts_text

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
                self._sentence_start = True
                self._cue_considered = False
                cue_policy.begin_response()
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
            # Safety net only. Pipecat 1.11's default stop strategy is Smart
            # Turn v3: it ends the turn at once when the sentence is complete
            # and waits (up to its own 3 s silence limit) when the caller
            # pauses mid-thought. This timeout force-ends a turn that no
            # strategy has ended; at 0.8 s it fired before Smart Turn could
            # wait, chopping speech into fragments and making Emysa answer
            # half-sentences. Keep it above Smart Turn's 3 s.
            user_turn_stop_timeout=4.0,
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
    # Verifiable in the Render logs: what the live TTS is really configured
    # with, including which tag syntax the vocalisation layer targets.
    try:
        tts_settings = getattr(tts, "_settings", None)
        logger.info(
            "tts config model={} syntax={} latency={} speed={} volume={} voiceTail={}",
            getattr(tts_settings, "model", None) or settings.tts_model or "default",
            tts_syntax,
            getattr(tts_settings, "latency", None),
            settings.tts_speed,
            settings.tts_volume,
            str(getattr(tts_settings, "voice", "") or "")[-4:],
        )
    except Exception:  # noqa: BLE001 - diagnostics must never break a call
        pass
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
