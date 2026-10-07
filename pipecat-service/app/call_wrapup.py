"""When a call should wrap up and hang up, decided from what was said (no I/O).

Two independent reasons the assistant ends a call by itself:

1. **A time budget** the user set ("brief him and round it up within a minute").
   :func:`parse_time_budget` reads it from the call's instructions/objective;
   :class:`WrapUpPlan` turns it into stages measured from the real answer:
   ``soft`` (start wrapping up), ``hard`` (time is up, say goodbye now) and
   ``force`` (hang up even if the model has not).
2. **The conversation is clearly finished.** :class:`FarewellTracker` notices
   goodbyes on both sides and, once they have been exchanged and nobody has
   spoken since, says it is time to hang up. This is the backstop for a model
   that says goodbye but never calls the ``end_call`` tool, which would
   otherwise leave the line open until the maximum call length.

The service injects the stage cues into the live model and performs the hangup;
this module only decides.
"""

from __future__ import annotations

import re

#: Shortest/longest budget that is believable. Anything else is ignored (a parsing
#: accident must never cut a call off after two seconds).
MIN_BUDGET_SECS = 20
MAX_BUDGET_SECS = 3600

#: Cue lead times before the budget runs out.
SOFT_LEAD_SECS = 20
FORCE_GRACE_SECS = 15

_NUMBER_WORDS = {
    "a": 1, "an": 1, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6,
    "seven": 7, "eight": 8, "nine": 9, "ten": 10, "fifteen": 15, "twenty": 20,
    "thirty": 30, "forty five": 45, "forty-five": 45, "sixty": 60,
}
_NUM = r"(\d{1,3}|a|an|one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty|thirty|forty[- ]five|sixty)"
_UNIT = r"(seconds?|secs?|minutes?|mins?)"
_LEAD = (
    r"(?:within|in|under|inside|less than|no more than|not more than|no longer than|"
    r"up to|at most|max(?:imum)?(?: of)?|for|keep it (?:to|under|within)|"
    r"keep (?:it|the call) (?:to|under|within)|round (?:it )?up (?:in|within)|"
    r"wrap (?:it )?up (?:in|within)|done (?:in|within)|finish (?:in|within))"
)

_PATTERNS = [
    # "within 2 minutes", "in a minute", "under 90 seconds", "keep it to five minutes"
    re.compile(rf"\b{_LEAD}\s+(?:about |around |roughly )?{_NUM}\s*{_UNIT}\b", re.I),
    # "a 2 minute call", "a two-minute chat", "a 30 second call"
    re.compile(rf"\b{_NUM}[- ]{_UNIT.replace('seconds?', 'second').replace('minutes?', 'minute')}\s+(?:call|chat|conversation|brief|briefing)\b", re.I),
    # "5 minutes max", "a minute at most", "two minutes tops"
    re.compile(rf"\b{_NUM}\s*{_UNIT}\s+(?:max|maximum|tops|at most|or less|at the most)\b", re.I),
]
_HALF_MINUTE = re.compile(r"\b(?:within|in|under|inside)\s+(?:half a minute|30 seconds)\b", re.I)
_COUPLE = re.compile(r"\b(?:within|in|under|inside|for|keep it to)\s+(?:a )?couple (?:of )?minutes\b", re.I)


def _to_number(token: str) -> int | None:
    token = token.strip().lower().replace("-", " ")
    if token.isdigit():
        return int(token)
    return _NUMBER_WORDS.get(token) or _NUMBER_WORDS.get(token.replace(" ", "-"))


def parse_time_budget(text: str | None) -> int | None:
    """Seconds the user allowed for the call, or None when they gave no limit.

    "brief him and round it up within a minute" -> 60, "keep it to 5 minutes" -> 300,
    "under 90 seconds" -> 90. When several limits appear, the tightest wins.
    """
    if not text:
        return None
    found: list[int] = []
    if _HALF_MINUTE.search(text):
        found.append(30)
    if _COUPLE.search(text):
        found.append(120)
    for pattern in _PATTERNS:
        for match in pattern.finditer(text):
            amount = _to_number(match.group(1))
            if amount is None:
                continue
            unit = match.group(2).lower()
            secs = amount * (60 if unit.startswith("min") else 1)
            found.append(secs)
    found = [s for s in found if MIN_BUDGET_SECS <= s <= MAX_BUDGET_SECS]
    return min(found) if found else None


# --------------------------------------------------------------------------- farewells

_FAREWELL = re.compile(
    r"\b(?:good ?bye|bye(?:[- ]bye)?|bye for now|take care|talk (?:to you )?(?:soon|later)|"
    r"speak (?:to you )?(?:soon|later)|see you (?:soon|later|then|tomorrow|around|next time)|catch you later|"
    r"have a (?:good|great|nice|lovely|wonderful) (?:day|one|evening|night|weekend)|"
    r"until (?:next time|then)|cheers|ciao)\b",
    re.I,
)
#: A farewell inside a long statement ("she never said goodbye to me and ...") is not a goodbye.
_MAX_FAREWELL_WORDS = 12
#: A long closing sentence still counts when the goodbye is at its very end.
_TAIL_WORDS = 5


def is_farewell(text: str | None) -> bool:
    """True when the utterance is a goodbye, not merely a sentence that mentions one."""
    if not text:
        return False
    words = re.findall(r"[\w']+", text)
    if not words:
        return False
    if len(words) > _MAX_FAREWELL_WORDS:
        # Only a goodbye that closes a long utterance counts ("... I'll send it over. Take care, bye!").
        tail = " ".join(words[-_TAIL_WORDS:])
        return bool(_FAREWELL.search(tail)) and not text.rstrip().endswith("?")
    if "?" in text and not re.search(r"\b(?:bye|goodbye)\b[^?]*\?$", text, re.I):
        return False  # a question is rarely the goodbye ("can you call me later?")
    return bool(_FAREWELL.search(text))


class FarewellTracker:
    """Decides, from the turn stream, that the conversation is over.

    Hang up when goodbyes have been exchanged (each side said one, in either
    order, within ``pair_window`` seconds) and nobody has spoken for
    ``settle_secs`` since the later one. Or when the assistant said goodbye and
    the other person stayed quiet for ``lone_ai_secs`` (they may have already
    hung up their side, or simply have nothing to add). Any new speech after a
    farewell cancels the pending hangup: people say "bye ... oh, one more thing".
    """

    def __init__(
        self,
        *,
        settle_secs: float = 3.5,
        lone_ai_secs: float = 9.0,
        pair_window: float = 30.0,
    ) -> None:
        self.settle_secs = settle_secs
        self.lone_ai_secs = lone_ai_secs
        self.pair_window = pair_window
        self._last_contact_farewell: float | None = None
        self._last_ai_farewell: float | None = None
        self._last_turn_at: float = 0.0

    def on_turn(self, speaker: str, text: str, now: float) -> None:
        self._last_turn_at = now
        if is_farewell(text):
            if speaker == "ai":
                self._last_ai_farewell = now
            else:
                self._last_contact_farewell = now
            return
        # Real speech after a farewell: the conversation is not over.
        if speaker == "ai":
            self._last_ai_farewell = None
        else:
            self._last_contact_farewell = None
            # ...and the assistant's earlier goodbye no longer closes the call either.
            self._last_ai_farewell = None

    def should_hang_up(self, now: float) -> tuple[bool, str]:
        c, a = self._last_contact_farewell, self._last_ai_farewell
        if c is not None and a is not None and abs(c - a) <= self.pair_window:
            if now - max(c, a, self._last_turn_at) >= self.settle_secs:
                return True, "goodbyes-exchanged"
        if a is not None and c is None and now - max(a, self._last_turn_at) >= self.lone_ai_secs:
            return True, "assistant-said-goodbye"
        return False, ""


# --------------------------------------------------------------------------- time budget plan

class WrapUpPlan:
    """Stages for a time budget, measured in talk seconds since the answer."""

    def __init__(self, budget_secs: int | None) -> None:
        self.budget_secs = budget_secs
        self._sent: set[str] = set()

    @property
    def soft_at(self) -> float | None:
        if not self.budget_secs:
            return None
        return max(self.budget_secs - SOFT_LEAD_SECS, self.budget_secs * 0.6)

    def next_stage(self, talk_secs: float) -> str | None:
        """The next stage to act on ("soft" | "hard" | "force"), each returned once."""
        if not self.budget_secs:
            return None
        if talk_secs >= self.budget_secs + FORCE_GRACE_SECS and "force" not in self._sent:
            self._sent.update({"soft", "hard", "force"})
            return "force"
        if talk_secs >= self.budget_secs and "hard" not in self._sent:
            self._sent.update({"soft", "hard"})
            return "hard"
        if talk_secs >= (self.soft_at or 0) and "soft" not in self._sent:
            self._sent.add("soft")
            return "soft"
        return None


def wrapup_cue(stage: str, budget_secs: int) -> str:
    """The instruction handed to the model at a stage (spoken-call wording, never read out)."""
    minutes = budget_secs / 60
    allowed = f"{int(minutes)} minute{'s' if int(minutes) != 1 else ''}" if budget_secs % 60 == 0 else f"{budget_secs} seconds"
    if stage == "soft":
        return (
            f"Time check: the person you work for asked you to keep this call to about {allowed}, "
            "and that time is almost up. Finish the point you are on, cover anything essential "
            "that is still unsaid in a sentence, then start closing the call."
        )
    return (
        f"Time is up: the person you work for asked you to keep this call to about {allowed}. "
        "Wrap up right now: one brief closing sentence, say goodbye warmly, and then hand the "
        "backend the end_call action. Do not start any new topic."
    )
