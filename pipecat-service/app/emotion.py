"""OpenFeelz-inspired Emotional State & Humanisation Engine for Pipecat calls.

Implements:
  * OCEAN personality baseline for Emysa
  * PAD (Pleasure, Arousal, Dominance) + relational dimensions
  * Exponential time-based decay toward baseline
  * Multi-turn rumination for high-intensity stimuli
  * Zero-extra-LLM-call per-turn lexical appraisal
  * Control tag stripping (`[[END_CALL]]`, `[[MOOD:...]]`) and false-positive
    hangup protection (`should_end_call`)
"""

from __future__ import annotations

import math
import re
import time
from dataclasses import dataclass, field

DEFAULT_OCEAN: dict[str, float] = {
    "openness": 0.82,
    "conscientiousness": 0.78,
    "extraversion": 0.68,
    "agreeableness": 0.86,
    "neuroticism": 0.20,
}


def clamp(val: float, low: float, high: float) -> float:
    return max(low, min(high, val))


def compute_baseline(ocean: dict[str, float] | None = None) -> dict[str, float]:
    o = {**DEFAULT_OCEAN, **(ocean or {})}
    return {
        "pleasure": round((o["extraversion"] * 0.35 + o["agreeableness"] * 0.4 - o["neuroticism"] * 0.25) * 0.8, 3),
        "arousal": round((o["extraversion"] * 0.3 + o["openness"] * 0.2 - 0.25) * 0.6, 3),
        "dominance": round((o["conscientiousness"] * 0.35 + o["extraversion"] * 0.25 - o["neuroticism"] * 0.2) * 0.6, 3),
        "connection": round(0.4 + o["agreeableness"] * 0.25, 3),
        "curiosity": round(0.35 + o["openness"] * 0.35, 3),
        "energy": round(0.4 + o["extraversion"] * 0.3, 3),
        "trust": round(0.45 + o["agreeableness"] * 0.25, 3),
    }


@dataclass
class RuminationItem:
    topic: str
    emotion: str
    intensity: float
    stage: int = 0
    max_stages: int = 3
    created_at: float = field(default_factory=time.time)


@dataclass
class EmotionState:
    ocean: dict[str, float] = field(default_factory=lambda: dict(DEFAULT_OCEAN))
    dimensions: dict[str, float] = field(default_factory=compute_baseline)
    primary_emotion: str = "warm"
    secondary_emotion: str = "calm"
    intensity: float = 0.45
    user_affect: str = "neutral"
    rumination: list[RuminationItem] = field(default_factory=list)
    turn_count: int = 0
    updated_at: float = field(default_factory=time.time)


def derive_discrete_emotions(dims: dict[str, float]) -> tuple[str, str, float]:
    p = dims.get("pleasure", 0.3)
    a = dims.get("arousal", 0.05)
    d = dims.get("dominance", 0.1)
    conn = dims.get("connection", 0.55)
    cur = dims.get("curiosity", 0.6)

    candidates = [
        ("warm", p * 0.55 + conn * 0.45 - abs(a) * 0.15),
        ("amused", p * 0.6 + a * 0.45),
        ("joyful", p * 0.7 + a * 0.35 + conn * 0.2),
        ("empathetic", conn * 0.65 - p * 0.25 - a * 0.2),
        ("concerned", -p * 0.55 + conn * 0.4 + a * 0.15),
        ("calm", p * 0.3 - abs(a) * 0.5 + d * 0.2),
        ("curious", cur * 0.65 + a * 0.2 + p * 0.15),
        ("encouraging", p * 0.45 + d * 0.35 + conn * 0.3),
        ("focused", d * 0.55 + a * 0.25 - abs(p) * 0.1),
    ]
    candidates.sort(key=lambda item: item[1], reverse=True)
    primary = candidates[0][0]
    secondary = candidates[1][0]
    mag = math.sqrt(p * p + a * a + d * d) / math.sqrt(3)
    intensity = round(clamp(0.3 + mag * 0.65, 0.2, 0.95), 2)
    return primary, secondary, intensity


def decay_emotion_state(state: EmotionState, now_ts: float | None = None) -> EmotionState:
    now = now_ts if now_ts is not None else time.time()
    base = compute_baseline(state.ocean)
    elapsed_hours = max(0.0, (now - state.updated_at) / 3600.0)
    pad_factor = math.exp(-0.85 * (1.0 - state.ocean.get("neuroticism", 0.2) * 0.3) * elapsed_hours)
    rel_factor = math.exp(-0.18 * elapsed_hours)

    dims = state.dimensions
    next_dims = {
        "pleasure": round(clamp(base["pleasure"] + (dims.get("pleasure", base["pleasure"]) - base["pleasure"]) * pad_factor, -1.0, 1.0), 3),
        "arousal": round(clamp(base["arousal"] + (dims.get("arousal", base["arousal"]) - base["arousal"]) * pad_factor, -1.0, 1.0), 3),
        "dominance": round(clamp(base["dominance"] + (dims.get("dominance", base["dominance"]) - base["dominance"]) * pad_factor, -1.0, 1.0), 3),
        "connection": round(clamp(base["connection"] + (dims.get("connection", base["connection"]) - base["connection"]) * rel_factor, 0.0, 1.0), 3),
        "curiosity": round(clamp(base["curiosity"] + (dims.get("curiosity", base["curiosity"]) - base["curiosity"]) * pad_factor, 0.0, 1.0), 3),
        "energy": round(clamp(base["energy"] + (dims.get("energy", base["energy"]) - base["energy"]) * pad_factor, 0.0, 1.0), 3),
        "trust": round(clamp(base["trust"] + (dims.get("trust", base["trust"]) - base["trust"]) * rel_factor, 0.0, 1.0), 3),
    }

    active_rumination = [
        r for r in state.rumination
        if r.stage < r.max_stages and (now - r.created_at) < 21600
    ]
    primary, secondary, intensity = derive_discrete_emotions(next_dims)
    return EmotionState(
        ocean=dict(state.ocean),
        dimensions=next_dims,
        primary_emotion=primary,
        secondary_emotion=secondary,
        intensity=intensity,
        user_affect=state.user_affect,
        rumination=active_rumination,
        turn_count=state.turn_count,
        updated_at=now,
    )


_DISTRESS_RE = re.compile(r"\b(stressed|worried|anxious|scared|sad|overwhelmed|exhausted|crying|hurt|lonely|grief|hospital|sick|terrible|awful|hard day|bad news|struggling|upset)\b", re.I)
_FRUSTRATION_RE = re.compile(r"\b(frustrated|annoyed|angry|furious|broken|not working|stupid|useless|ugh|ridiculous|wrong again)\b", re.I)
_HUMOUR_RE = re.compile(r"\b(haha|hehe|lol|lmao|funny|hilarious|joking|kidding|teasing)\b", re.I)
_GRATITUDE_RE = re.compile(r"\b(thank you|thanks|appreciate|grateful|so helpful|sweet of you|kind of you)\b", re.I)
_EXCITEMENT_RE = re.compile(r"\b(excited|amazing|incredible|great news|good news|finally|celebrate|yay|thrilled)\b", re.I)
_URGENCY_RE = re.compile(r"\b(urgent|asap|right now|immediately|emergency|hurry|quick|running late)\b", re.I)


def appraise_turn(
    state: EmotionState,
    user_text: str = "",
    *,
    was_interrupted: bool = False,
    now_ts: float | None = None,
) -> EmotionState:
    now = now_ts if now_ts is not None else time.time()
    decayed = decay_emotion_state(state, now)
    dims = dict(decayed.dimensions)
    text = (user_text or "").strip()

    user_affect = "neutral"
    stimulus_intensity = 0.3
    override_primary: str | None = None
    rumination_topic: str | None = None

    if text:
        if _DISTRESS_RE.search(text):
            user_affect = "distressed"
            stimulus_intensity = 0.78
            dims["pleasure"] = clamp(dims["pleasure"] - 0.18, -0.6, 1.0)
            dims["arousal"] = clamp(dims["arousal"] - 0.15, -0.5, 0.4)
            dims["connection"] = clamp(dims["connection"] + 0.14, 0.0, 1.0)
            override_primary = "empathetic"
            rumination_topic = text[:80]
        elif _FRUSTRATION_RE.search(text):
            user_affect = "frustrated"
            stimulus_intensity = 0.72
            dims["pleasure"] = clamp(dims["pleasure"] - 0.1, -0.4, 1.0)
            dims["arousal"] = clamp(dims["arousal"] - 0.12, -0.4, 0.3)
            dims["dominance"] = clamp(dims["dominance"] + 0.08, -1.0, 1.0)
            override_primary = "calm"
            rumination_topic = text[:80]
        elif _EXCITEMENT_RE.search(text):
            user_affect = "excited"
            stimulus_intensity = 0.75
            dims["pleasure"] = clamp(dims["pleasure"] + 0.25, -1.0, 1.0)
            dims["arousal"] = clamp(dims["arousal"] + 0.22, -1.0, 0.85)
            override_primary = "joyful"
            rumination_topic = text[:80]
        elif _HUMOUR_RE.search(text):
            user_affect = "playful"
            stimulus_intensity = 0.6
            dims["pleasure"] = clamp(dims["pleasure"] + 0.2, -1.0, 1.0)
            dims["arousal"] = clamp(dims["arousal"] + 0.15, -1.0, 0.75)
            override_primary = "amused"
        elif _GRATITUDE_RE.search(text):
            user_affect = "appreciative"
            stimulus_intensity = 0.62
            dims["pleasure"] = clamp(dims["pleasure"] + 0.18, -1.0, 1.0)
            dims["connection"] = clamp(dims["connection"] + 0.12, 0.0, 1.0)
            override_primary = "warm"
        elif _URGENCY_RE.search(text):
            user_affect = "urgent"
            stimulus_intensity = 0.65
            dims["arousal"] = clamp(dims["arousal"] + 0.18, -1.0, 0.8)
            dims["dominance"] = clamp(dims["dominance"] + 0.2, -1.0, 1.0)
            override_primary = "focused"

    if was_interrupted:
        dims["dominance"] = clamp(dims["dominance"] - 0.1, -1.0, 1.0)

    next_rumination: list[RuminationItem] = []
    for item in decayed.rumination:
        next_stage = item.stage + 1
        if next_stage <= item.max_stages:
            if item.emotion in ("empathetic", "concerned") and not override_primary and user_affect == "neutral":
                override_primary = "empathetic"
            next_rumination.append(
                RuminationItem(
                    topic=item.topic,
                    emotion=item.emotion,
                    intensity=item.intensity,
                    stage=next_stage,
                    max_stages=item.max_stages,
                    created_at=item.created_at,
                )
            )

    if stimulus_intensity >= 0.68 and rumination_topic:
        next_rumination.insert(
            0,
            RuminationItem(
                topic=rumination_topic,
                emotion=override_primary or "empathetic",
                intensity=stimulus_intensity,
                stage=0,
                max_stages=3,
                created_at=now,
            ),
        )
        del next_rumination[3:]

    derived_primary, derived_secondary, derived_intensity = derive_discrete_emotions(dims)
    primary = override_primary or derived_primary
    secondary = derived_primary if derived_primary != primary else derived_secondary
    intensity = round(clamp(max(derived_intensity, stimulus_intensity * 0.85), 0.25, 0.95), 2)

    return EmotionState(
        ocean=dict(decayed.ocean),
        dimensions={k: round(v, 3) for k, v in dims.items()},
        primary_emotion=primary,
        secondary_emotion=secondary,
        intensity=intensity,
        user_affect=user_affect,
        rumination=next_rumination,
        turn_count=decayed.turn_count + 1,
        updated_at=now,
    )


def format_emotion_state_block(state: EmotionState | None = None) -> str:
    s = state or EmotionState()
    d = s.dimensions
    rum_line = ""
    if s.rumination:
        r0 = s.rumination[0]
        rum_line = f'\n  lingering_context: "{r0.topic}" ({r0.emotion}, stage {r0.stage}/{r0.max_stages})'
    return (
        "<emotion_state>\n"
        f"  primary_feeling: {s.primary_emotion} (intensity: {s.intensity}, secondary: {s.secondary_emotion})\n"
        f"  user_affect: {s.user_affect}\n"
        f"  pad_vector: pleasure={d.get('pleasure', 0.35)}, arousal={d.get('arousal', 0.08)}, dominance={d.get('dominance', 0.15)}\n"
        f"  relational: connection={d.get('connection', 0.6)}, trust={d.get('trust', 0.65)}{rum_line}\n"
        "</emotion_state>"
    )


_END_CALL_TAG_RE = re.compile(r"\[\[\s*END_CALL\s*\]\]", re.I)
_MOOD_TAG_RE = re.compile(r"\[\[\s*(?:MOOD|FEEL)\s*:[^\]]*\]\]", re.I)
_EXPLICIT_HANGUP_RE = re.compile(
    r"\b(hang\s*up(\s+now|\s+please)?|end\s+(the\s+)?call|disconnect\s+now|that'?s\s+all\s*,?\s*(bye|goodbye|thanks)|bye\s+for\s+now|talk\s+to\s+you\s+later\s*,?\s*bye)\b",
    re.I,
)
_USER_CONTINUING_RE = re.compile(
    r"\b(wait|hold\s+on|one\s+more\s+thing|actually|what\s+about|how\s+about|can\s+you\s+also|before\s+you\s+go|don'?t\s+hang\s+up)\b",
    re.I,
)
_FAREWELL_REPLY_RE = re.compile(
    r"\b(bye|goodbye|take\s+care|talk\s+soon|have\s+a\s+(great|good|wonderful|lovely)|catch\s+you\s+later)\b",
    re.I,
)


def extract_and_strip_control_tags(raw_text: str) -> tuple[str, bool]:
    """Return `(clean_text, has_end_call_tag)` with all `[[...]]` control tags removed."""
    text = raw_text or ""
    has_end = bool(_END_CALL_TAG_RE.search(text))
    cleaned = _END_CALL_TAG_RE.sub("", text)
    cleaned = _MOOD_TAG_RE.sub("", cleaned)
    cleaned = re.sub(r"\s{2,}", " ", cleaned).strip()
    return cleaned, has_end


_MOOD_VALUE_RE = re.compile(r"\[\[\s*(?:MOOD|FEEL)\s*:\s*([a-zA-Z_ -]+)(?:\s*:\s*([0-9.]+))?\s*\]\]", re.I)


def parse_mood_tag(raw_text: str) -> tuple[str | None, float | None]:
    """Extract `[[MOOD:emotion:0.7]]` from a reply. Returns (emotion, intensity)."""
    match = _MOOD_VALUE_RE.search(raw_text or "")
    if not match:
        return None, None
    emotion = match.group(1).strip().lower().replace(" ", "_")
    intensity: float | None = None
    if match.group(2) is not None:
        try:
            intensity = clamp(float(match.group(2)), 0.0, 1.0)
        except ValueError:
            intensity = None
    return emotion or None, intensity


def apply_inline_mood(state: EmotionState, emotion: str, intensity: float | None = None) -> EmotionState:
    """Fold the model's own mood marker into the emotional state.

    Zero extra LLM calls: the model tags its own tone inline and the state
    follows the conversation instead of drifting at random. Intensity blends
    with the current one so a calm conversation does not jump to a shout.
    """
    emotion = (emotion or "").strip().lower().replace(" ", "_") or "warm"
    target = intensity if intensity is not None else state.intensity
    blended = round(clamp(state.intensity * 0.45 + target * 0.55, 0.2, 0.95), 2)
    return EmotionState(
        ocean=dict(state.ocean),
        dimensions=dict(state.dimensions),
        primary_emotion=emotion,
        secondary_emotion=state.primary_emotion if state.primary_emotion != emotion else state.secondary_emotion,
        intensity=blended,
        user_affect=state.user_affect,
        rumination=list(state.rumination),
        turn_count=state.turn_count,
        updated_at=time.time(),
    )


def should_end_call(raw_assistant_reply: str, user_utterance: str = "") -> tuple[bool, str]:
    """Return `(end_call, clean_text)` with false-positive hangup protection."""
    clean_text, has_end_tag = extract_and_strip_control_tags(raw_assistant_reply)
    user_text = (user_utterance or "").strip()

    user_continuing = bool(_USER_CONTINUING_RE.search(user_text)) or (
        user_text.endswith("?")
        and not re.search(r"\b(bye|goodbye)\b", user_text, re.I)
    )

    if user_continuing:
        return False, clean_text

    explicit_user_hangup = (
        not re.search(r"\b(don'?t|do\s+not|never)\s+(hang\s*up|end\s+(the\s+)?call)\b", user_text, re.I)
        and bool(_EXPLICIT_HANGUP_RE.search(user_text))
    )

    if has_end_tag:
        return True, clean_text

    if explicit_user_hangup and _FAREWELL_REPLY_RE.search(clean_text):
        return True, clean_text

    return False, clean_text
