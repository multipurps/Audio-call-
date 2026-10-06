"""Caller interaction state for live calls (Phase 2).

Tracks how the *caller* is coming across during the call and turns that into a
small, debounced state machine whose changes are handed to GPT-Live as private
behavioural guidance. It is deliberately NOT a conversational model:

    caller audio + caller transcript
        -> CallerStateDetector   (cheap evidence -> a distribution over 7 states)
        -> CallerStateTracker    (smoothing, debounce, hysteresis, trajectory)
        -> behaviour_note()      (fixed guidance text per state)
        -> GPT-Live private note (the model decides what, if anything, to say)

Nothing here generates speech, calls an LLM, or touches the TTS / cloned voice.

Concepts adapted from the two reference projects, not copied:

* Real-Time-Voice-and-Emotion-Processing: cheap signal-derived features
  (RMS energy, zero-crossing rate), normalised and fused with hand-set weights
  into a probability distribution with a confidence. We keep that idea but drop
  librosa / Whisper (heavy dependencies, and GPT-Live already transcribes), use
  loudness *relative to this caller's own baseline* instead of absolute levels,
  and add lexical and turn-taking cues, which are far stronger evidence for
  frustration / confusion on a phone line than pitch features.
* HumanVoiceAI: a sliding window over a stream feeding a classifier, with the
  classifier's output kept separate from a policy that maps it to an action.
  We keep the separation (detector vs. tracker vs. behaviour policy) but not its
  trained CNN-LSTM model, which would need torch and labelled training data.

Honest limits are listed in the README section for this module; the main one:
the acoustic features are weak on their own, so the lexical cues carry most of
the signal, and they are English-only for now.
"""

from __future__ import annotations

import math
import re
import sys
import time
from array import array
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable

STATES: tuple[str, ...] = (
    "calm",
    "confused",
    "frustrated",
    "impatient",
    "upset",
    "reassured",
    "disengaged",
)

#: How bad a state is for the interaction. "lowest_state" is the highest
#: severity reached. calm and reassured are both fine (0).
SEVERITY: dict[str, int] = {
    "calm": 0,
    "reassured": 0,
    "confused": 1,
    "disengaged": 1,
    "impatient": 2,
    "frustrated": 3,
    "upset": 4,
}

NEGATIVE_STATES = frozenset(s for s, v in SEVERITY.items() if v > 0)
MAX_TRAJECTORY = 60


def _utc_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


# --------------------------------------------------------------------------
# Behaviour policy: what GPT-Live is told on a state change
# --------------------------------------------------------------------------

BEHAVIOUR: dict[str, str] = {
    "frustrated": (
        "FRUSTRATED: Be concise, calm and specific. Do not over-explain. "
        "Move toward solving the immediate problem."
    ),
    "confused": (
        "CONFUSED: Simplify the explanation. Slow down conceptually. "
        "Ask one precise question instead of several."
    ),
    "impatient": (
        "IMPATIENT: Get to the point. Avoid pleasantries and unnecessary explanation."
    ),
    "upset": (
        "UPSET: Remain calm. Do not mirror hostility. Acknowledge the actual issue "
        "when appropriate. Move toward resolution."
    ),
    "disengaged": (
        "DISENGAGED: Stop over-explaining. Use shorter responses. "
        "Move toward a clear next step."
    ),
    "reassured": (
        "REASSURED: Gradually return toward normal conversational behaviour."
    ),
    "calm": (
        "CALM: Normal conversational behaviour. Drop any earlier guidance about being brief or careful."
    ),
}

NOTE_PREFIX = (
    "[Private guidance about how the caller seems right now. The caller cannot see or hear "
    "this. Never read it out, never mention it, never say you have noticed their mood or "
    "state, and do not restart or interrupt what you are saying. Let it shape only how you "
    "respond from here on.]\n"
)


def behaviour_note(state: str) -> str:
    """The private note sent to GPT-Live when the caller's state changes."""
    return NOTE_PREFIX + BEHAVIOUR.get(state, BEHAVIOUR["calm"])


# --------------------------------------------------------------------------
# Detector: evidence -> distribution over states
# --------------------------------------------------------------------------

_PROFANITY = r"(?:f+u+c+k\w*|sh[i1]t\w*|damn\w*|bullshit|bastard|asshole|crap\w*|pissed)"

#: (state, weight, regex). Weight is the evidence a single hit adds to a state.
_CUES: list[tuple[str, float, re.Pattern[str]]] = [
    (s, w, re.compile(p, re.I))
    for s, w, p in [
        # upset: strong anger / distress language
        ("upset", 0.55, _PROFANITY),
        ("upset", 0.5, r"\b(?:ridiculous|unacceptable|outrageous|disgusting|a joke|furious|livid|fed up|sick of (?:this|it|you))\b"),
        ("upset", 0.35, r"\b(?:i(?:'m| am) (?:so |really |very )?(?:upset|angry|mad|hurt|disappointed)|this is (?:terrible|awful|horrible))\b"),
        # frustrated: repetition, things not working, exasperation
        ("frustrated", 0.5, r"\b(?:i (?:already|just) (?:told|said|explained)|how many times|i said|as i said|i keep (?:telling|saying))\b"),
        ("frustrated", 0.4, r"\b(?:not working|doesn'?t work|didn'?t work|still (?:not|no|can'?t|doesn'?t)|that'?s not (?:what|helping)|useless|pointless|waste of)\b"),
        ("frustrated", 0.3, r"\b(?:seriously|come on|again\?|for god'?s sake|oh my god|ugh+|are you (?:even )?listening)\b"),
        # impatient: wants speed
        ("impatient", 0.5, r"\b(?:hurry|quickly|get to the point|just tell me|i don'?t have (?:much )?time|make it quick|skip (?:that|this)|cut to)\b"),
        ("impatient", 0.35, r"(?:^so what[?.!]*$|\bcan we move on\b|\banyway\b|^go on[.!]*$|\bhello\?|\bare you there\b|\bwhat'?s taking\b)"),
        # confused: did not understand
        ("confused", 0.5, r"\b(?:i don'?t (?:understand|get it|follow)|(?:i'?m )?confused|you lost me|doesn'?t make sense|what do you mean|i'?m not sure what you)\b"),
        ("confused", 0.35, r"^(?:what\??|huh\??|sorry\??|pardon\??|come again\??|wait\b.*)$"),
        ("confused", 0.25, r"\b(?:what (?:is|was|does) that|which one|i(?:'m| am) lost)\b"),
        # reassured: positive resolution cues (only count while recovering)
        ("reassured", 0.5, r"\b(?:that helps|that makes sense|that'?s (?:great|perfect|fine|better|clear)|got it|i see,? (?:thanks|thank you)|okay,? (?:thanks|thank you|good|great|perfect)|ok,? (?:thanks|good|great))\b"),
        ("reassured", 0.35, r"\b(?:thank(?:s| you)(?: so much| very much)?|appreciate|perfect|brilliant|wonderful|no worries|all good|that works)\b"),
    ]
]

_FILLER = re.compile(r"^(?:um+|uh+|hm+|mm+|yeah|yep|ok(?:ay)?|sure|fine|whatever|right|i guess|k|uh huh|mhm)[.!?\s]*$", re.I)


@dataclass
class Observation:
    """One utterance's worth of evidence, normalised to a state distribution."""

    scores: dict[str, float]
    top: str
    confidence: float
    cues: list[str] = field(default_factory=list)
    features: dict[str, float] = field(default_factory=dict)


class CallerStateDetector:
    """Cheap, per-utterance evidence fusion. Pure Python, no extra LLM call.

    Feed raw caller audio with :meth:`feed_audio` (cheap RMS / zero-crossing
    stats, only while audible), then call :meth:`end_utterance` with the final
    transcript. Acoustic features are judged against the caller's own running
    baseline, so a naturally loud or quiet speaker is not misread.
    """

    AUDIBLE_RMS = 0.015
    BASELINE_ALPHA = 0.3

    def __init__(self, clock: Callable[[], float] = time.monotonic) -> None:
        self._clock = clock
        self._reset_utterance()
        self._baseline_rms: float | None = None
        self._utterances = 0
        self._last_ai_end: float | None = None
        self._recent_short = deque(maxlen=3)

    def _reset_utterance(self) -> None:
        self._sum_sq = 0.0
        self._samples = 0
        self._crossings = 0
        self._audible_secs = 0.0
        self._talked_over_secs = 0.0

    # -- audio ---------------------------------------------------------------

    def feed_audio(self, pcm16: bytes, sample_rate: int, *, ai_speaking: bool = False) -> None:
        if not pcm16 or sample_rate <= 0:
            return
        samples = array("h")
        samples.frombytes(pcm16[: len(pcm16) - (len(pcm16) % 2)])
        if sys.byteorder == "big":
            samples.byteswap()
        n = len(samples)
        if n == 0:
            return
        sq = 0
        crossings = 0
        prev = samples[0]
        for s in samples:
            sq += s * s
            if (s >= 0) != (prev >= 0):
                crossings += 1
            prev = s
        rms = math.sqrt(sq / n) / 32768.0
        if rms < self.AUDIBLE_RMS:
            return
        secs = n / sample_rate
        self._sum_sq += sq / (32768.0 ** 2)
        self._samples += n
        self._crossings += crossings
        self._audible_secs += secs
        if ai_speaking:
            self._talked_over_secs += secs

    def note_ai_finished(self) -> None:
        self._last_ai_end = self._clock()

    # -- utterance -----------------------------------------------------------

    def end_utterance(self, text: str | None) -> Observation:
        now = self._clock()
        clean = " ".join((text or "").split())
        lowered = clean.lower()
        words = len(clean.split()) if clean else 0

        rms = math.sqrt(self._sum_sq / self._samples) if self._samples else 0.0
        zcr = (self._crossings / self._samples) if self._samples else 0.0
        secs = self._audible_secs
        talked_over = self._talked_over_secs >= 0.4
        features: dict[str, float] = {
            "rms": round(rms, 4),
            "zcr": round(zcr, 4),
            "speech_secs": round(secs, 2),
            "words": float(words),
        }

        raw = {s: 0.0 for s in STATES}
        raw["calm"] = 0.30
        cues: list[str] = []

        # Lexical cues (strongest evidence). Diminishing returns per state.
        for state, weight, pattern in _CUES:
            if pattern.search(lowered):
                gain = weight * (0.6 if raw[state] > 0.5 else 1.0)
                raw[state] += gain
                cues.append(f"{state}:{pattern.pattern[:24]}")

        # Short filler answers, especially several in a row -> disengaged.
        is_filler = bool(clean) and bool(_FILLER.match(clean))
        self._recent_short.append(is_filler or words <= 2)
        if is_filler:
            raw["disengaged"] += 0.18
            cues.append("filler")
        if len(self._recent_short) == self._recent_short.maxlen and all(self._recent_short):
            raw["disengaged"] += 0.3
            cues.append("short-run")

        # Long gap before the caller answered -> mild disengagement.
        if self._last_ai_end is not None:
            gap = now - self._last_ai_end - secs
            if gap > 8.0:
                raw["disengaged"] += 0.12
                cues.append("slow-reply")

        # Talking over the assistant -> impatience.
        if talked_over:
            raw["impatient"] += 0.25
            cues.append("talked-over")

        # Acoustic arousal relative to this caller's own baseline.
        ratio = 1.0
        if rms > 0:
            if self._baseline_rms and self._utterances >= 2:
                ratio = rms / self._baseline_rms
            features["loudness_ratio"] = round(ratio, 2)
            if ratio >= 1.6:
                for s in ("frustrated", "upset", "impatient"):
                    raw[s] += 0.10
                cues.append("louder")
            elif ratio <= 0.55 and words <= 4:
                raw["disengaged"] += 0.10
                cues.append("quieter")
            if zcr > 0.16 and ratio >= 1.3:
                raw["frustrated"] += 0.06
            if secs > 0.5 and words / secs >= 3.8:
                raw["impatient"] += 0.10
                cues.append("fast")
            # Update the baseline only from ordinary-level speech so a shouting
            # match does not become the new normal.
            if ratio < 1.6:
                self._baseline_rms = rms if self._baseline_rms is None else (
                    self.BASELINE_ALPHA * rms + (1 - self.BASELINE_ALPHA) * self._baseline_rms
                )
        self._utterances += 1
        self._reset_utterance()

        total = sum(raw.values())
        scores = {s: raw[s] / total for s in STATES}
        top = max(scores, key=scores.get)  # type: ignore[arg-type]
        # No evidence beyond the calm prior is a weak, not a confident, "calm".
        evidence = total - 0.30
        confidence = scores[top] if evidence > 0.05 else min(scores[top], 0.6)
        return Observation(scores=scores, top=top, confidence=round(confidence, 3), cues=cues, features=features)


# --------------------------------------------------------------------------
# Tracker: smoothing, debounce, hysteresis, trajectory
# --------------------------------------------------------------------------


@dataclass
class Transition:
    previous_state: str
    state: str
    confidence: float
    trigger: str
    recovery: bool = False


class CallerStateTracker:
    """The interaction-state model for one call.

    A state only changes when the smoothed evidence has pointed at the same new
    state for ``confirm_obs`` consecutive utterances, with a margin over the
    current state, after a minimum dwell. Leaving a negative state needs a
    bigger margin (hysteresis) so the model does not flap. One odd utterance
    therefore never changes anything.
    """

    def __init__(
        self,
        *,
        clock: Callable[[], float] = time.monotonic,
        wall: Callable[[], str] = _utc_iso,
        alpha: float = 0.5,
        confirm_obs: int = 2,
        min_dwell_secs: float = 4.0,
        enter_threshold: float = 0.40,
        enter_margin: float = 0.08,
        exit_margin: float = 0.16,
        settle_obs: int = 3,
    ) -> None:
        self._clock = clock
        self._wall = wall
        self.alpha = alpha
        self.confirm_obs = confirm_obs
        self.min_dwell_secs = min_dwell_secs
        self.enter_threshold = enter_threshold
        self.enter_margin = enter_margin
        self.exit_margin = exit_margin
        self.settle_obs = settle_obs

        self._t0 = clock()
        self.current_state = "calm"
        self.confidence = 0.5
        self.previous_state: str | None = None
        self.state_started_at = self._wall()
        self._state_started_mono = self._t0
        self.lowest_state = "calm"
        self.recovery_detected = False
        self.recoveries = 0
        self.observations = 0
        self.trajectory: list[dict[str, Any]] = []
        self._smoothed = {s: (1.0 if s == "calm" else 0.0) for s in STATES}
        self._pending: str | None = None
        self._pending_count = 0
        self._calm_streak = 0
        self._record(self.current_state, 0.5, None, "start")

    # -- internals -----------------------------------------------------------

    def _record(self, state: str, confidence: float, previous: str | None, trigger: str) -> None:
        self.trajectory.append(
            {
                "state": state,
                "previous_state": previous,
                "at": self._wall(),
                "t_offset_s": round(self._clock() - self._t0, 1),
                "confidence": round(confidence, 2),
                "trigger": trigger[:80],
            }
        )
        if len(self.trajectory) > MAX_TRAJECTORY:
            # Keep the opening and the most recent history.
            self.trajectory = self.trajectory[:1] + self.trajectory[-(MAX_TRAJECTORY - 1):]

    def _candidate(self) -> str:
        cur = self.current_state
        # "reassured" is only meaningful as a recovery from something negative.
        eligible = {s: v for s, v in self._smoothed.items() if s != "reassured" or cur in NEGATIVE_STATES}
        return max(eligible, key=eligible.get)  # type: ignore[arg-type]

    # -- public --------------------------------------------------------------

    def update(self, obs: Observation) -> Transition | None:
        """Fold in one observation. Returns a Transition only on a committed change."""
        self.observations += 1
        a = self.alpha
        for s in STATES:
            self._smoothed[s] = a * obs.scores.get(s, 0.0) + (1 - a) * self._smoothed[s]

        cur = self.current_state
        cand = self._candidate()

        # reassured is transient: after a few calm-looking observations, settle to calm.
        if cur == "reassured":
            if obs.top in ("calm", "reassured") and cand in ("calm", "reassured"):
                self._calm_streak += 1
            else:
                self._calm_streak = 0
            if self._calm_streak >= self.settle_obs:
                return self._commit("calm", max(obs.confidence, 0.5), "settled", recovery=False)

        if cand == cur:
            self._pending, self._pending_count = None, 0
            self.confidence = round(max(self.confidence * 0.7 + obs.confidence * 0.3, 0.0), 3)
            return None

        # The raw observation must agree with the smoothed candidate: a single
        # noisy utterance cannot drag the average over on its own.
        if obs.top != cand:
            self._pending, self._pending_count = None, 0
            return None

        margin = self._smoothed[cand] - self._smoothed[cur]
        needed = self.exit_margin if (cur in NEGATIVE_STATES and cand not in NEGATIVE_STATES) else self.enter_margin
        if self._smoothed[cand] < self.enter_threshold or margin < needed:
            self._pending, self._pending_count = None, 0
            return None

        if cand == self._pending:
            self._pending_count += 1
        else:
            self._pending, self._pending_count = cand, 1
        if self._pending_count < self.confirm_obs:
            return None
        if self._clock() - self._state_started_mono < self.min_dwell_secs:
            return None

        trigger = ",".join(obs.cues[:3]) or "acoustic"
        return self._commit(cand, obs.confidence, trigger)

    def _commit(self, state: str, confidence: float, trigger: str, *, recovery: bool | None = None) -> Transition:
        prev = self.current_state
        self.previous_state = prev
        self.current_state = state
        self.confidence = round(confidence, 3)
        self.state_started_at = self._wall()
        self._state_started_mono = self._clock()
        self._pending, self._pending_count, self._calm_streak = None, 0, 0

        if SEVERITY[state] > SEVERITY[self.lowest_state]:
            self.lowest_state = state

        is_recovery = False
        if state in NEGATIVE_STATES:
            if self.recovery_detected:
                self.recovery_detected = False  # relapse
        elif prev in NEGATIVE_STATES and SEVERITY[self.lowest_state] > 0:
            is_recovery = True
            self.recovery_detected = True
            self.recoveries += 1
        self._record(state, confidence, prev, trigger)
        return Transition(prev, state, self.confidence, trigger, recovery=is_recovery)

    def summary(self) -> dict[str, Any]:
        """Stored on the call row after the call; also safe to read mid-call."""
        never_negative = SEVERITY[self.lowest_state] == 0
        if never_negative:
            recovery = "not_needed"
        elif self.current_state in NEGATIVE_STATES:
            recovery = "unresolved"
        elif self.recovery_detected:
            recovery = "successful"
        else:
            recovery = "unresolved"
        return {
            "version": 1,
            "starting_state": self.trajectory[0]["state"] if self.trajectory else "calm",
            "lowest_state": self.lowest_state,
            "final_state": self.current_state,
            "final_confidence": self.confidence,
            "recovery": recovery,
            "recovery_detected": self.recovery_detected,
            "transitions": max(0, len(self.trajectory) - 1),
            "observations": self.observations,
            "current_state": self.current_state,
            "previous_state": self.previous_state,
            "state_started_at": self.state_started_at,
            "trajectory": list(self.trajectory),
        }


# --------------------------------------------------------------------------
# Monitor: the thin, never-raising glue the pipeline talks to
# --------------------------------------------------------------------------


class CallerStateMonitor:
    """Owns a detector + tracker for one call and delivers state changes.

    The pipeline processor only forwards frames here. This class is pure
    Python so the whole path (transcript in -> private note out) is testable
    without Pipecat. A failure in here must never affect the call: every entry
    point swallows its own errors.
    """

    def __init__(
        self,
        *,
        send_note: Callable[[str], Any] | None = None,
        log: Callable[..., None] | None = None,
        detector: CallerStateDetector | None = None,
        tracker: CallerStateTracker | None = None,
    ) -> None:
        self.detector = detector or CallerStateDetector()
        self.tracker = tracker or CallerStateTracker()
        self._send_note = send_note
        self._log = log or (lambda *a, **k: None)
        self.notes_sent = 0
        self.note_failures = 0

    @property
    def state(self) -> str:
        return self.tracker.current_state

    def on_audio(self, pcm16: bytes, sample_rate: int, *, ai_speaking: bool = False) -> None:
        try:
            self.detector.feed_audio(pcm16, sample_rate, ai_speaking=ai_speaking)
        except Exception:  # noqa: BLE001
            pass

    def on_ai_finished(self) -> None:
        try:
            self.detector.note_ai_finished()
        except Exception:  # noqa: BLE001
            pass

    def on_caller_transcript(self, text: str | None) -> Transition | None:
        try:
            obs = self.detector.end_utterance(text)
            transition = self.tracker.update(obs)
            self._log(
                "caller_state_observation", "DEBUG",
                top=obs.top, conf=obs.confidence, state=self.tracker.current_state,
                cues="|".join(obs.cues) or "-",
                loud=obs.features.get("loudness_ratio", "-"),
            )
            if transition is not None:
                self._log(
                    "caller_state_change", "INFO",
                    previous=transition.previous_state, state=transition.state,
                    conf=transition.confidence, trigger=transition.trigger,
                    recovery=transition.recovery, lowest=self.tracker.lowest_state,
                )
                self._deliver(behaviour_note(transition.state))
            return transition
        except Exception as exc:  # noqa: BLE001 - never hurt the call
            self._log("caller_state_error", "WARNING", error=type(exc).__name__)
            return None

    def _deliver(self, note: str) -> None:
        if self._send_note is None:
            return
        import asyncio

        async def _run() -> None:
            try:
                await self._send_note(note)  # type: ignore[misc]
                self.notes_sent += 1
            except Exception as exc:  # noqa: BLE001
                self.note_failures += 1
                self._log("caller_state_note_failed", "WARNING", error=type(exc).__name__)

        try:
            asyncio.get_running_loop().create_task(_run())
        except RuntimeError:
            pass  # no running loop (sync test / shutdown): drop, never raise

    def summary(self) -> dict[str, Any]:
        out = self.tracker.summary()
        out["notes_sent"] = self.notes_sent
        return out
