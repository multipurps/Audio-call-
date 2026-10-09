"""Verified call-attempt facts for the per-call GPT-Live context.

Three kinds of state used to be mixed into one blob of text that the model read:

  * the account-link state (is the OWNER's WhatsApp linked?),
  * the call-attempt state (what did the provider report for THIS attempt?),
  * conversational / contact memory (what do we know about the recipient?).

This module only handles the second. It turns the ``calls`` rows of one retry
chain into a short list of facts, each of which is either supported by a recorded
provider event or marked unknown. It never reads account-link state, and it never
produces a sentence that explains *why* an earlier attempt did not connect: the
provider rarely knows, and a wrong explanation ("their WhatsApp isn't set up",
"it never rang") spoken to the recipient is worse than silence.

Event vocabulary (``calls.attempt_events``, appended by the app):
    requested, initiated, ringing, answered, ended, failed, unknown
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

ATTEMPT_STATES = ("requested", "initiated", "ringing", "answered", "ended", "failed", "unknown")

#: How far back an earlier attempt still counts as part of the same request.
ATTEMPT_WINDOW_SECS = 6 * 3600

#: Row statuses that mean the recipient was never reached. They say nothing about
#: why, and nothing about whether the recipient's phone rang.
_UNREACHED_STATUSES = {"no_answer", "busy", "rejected", "canceled", "failed"}

#: Text that is an internal diagnostic or an owner-side connection problem. It must
#: never be carried into what the recipient hears, in a summary or anywhere else.
_DIAGNOSTIC = re.compile(
    r"couldn'?t connect|did not connect|never rang|link it in profile|reconnect|not connected"
    r"|session expired|relay|wacalls|mp-relay|provider|check that they have|no summary"
    r"|call was never answered|not on whatsapp|isn'?t on whatsapp",
    re.IGNORECASE,
)

#: A message that only asks for a repeat. It is a command to the app, never part of
#: what the recipient's call is about.
_RETRY_COMMAND = re.compile(
    r"^\W*(?:please\s+)?(?:(?:try|call|ring|dial|redial|do it|go)(?:\s+(?:it|him|her|them|that|again|back))*\s*(?:again|back)?"
    r"|retry|try once more|one more (?:try|time)|again)\W*$",
    re.IGNORECASE,
)


def is_retry_command(text: str | None) -> bool:
    return bool(text and _RETRY_COMMAND.match(text.strip()))


def is_diagnostic_text(text: str | None) -> bool:
    return bool(text and _DIAGNOSTIC.search(text))


def _parse_ts(value: Any) -> float | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def _digits(value: object) -> str:
    return "".join(ch for ch in str(value or "") if ch.isdigit())


@dataclass(frozen=True)
class AttemptFact:
    """What is actually known about one call attempt."""

    call_id: str
    attempt_number: int
    status: str
    #: Provider states recorded for THIS attempt only, in order, de-duplicated.
    states: tuple[str, ...] = ()
    age_secs: float | None = None
    #: True only when the recipient answered (a recorded 'answered' event, or a
    #: status/duration that can only exist after an answer). Never inferred from
    #: the absence of an event.
    answered: bool = False

    @property
    def rang(self) -> bool | None:
        """True when a 'ringing' event was recorded. None (unknown) otherwise: a
        missing event is not evidence that the phone did not ring."""
        return True if "ringing" in self.states else None

    @property
    def outcome(self) -> str:
        """The outcome a recipient-facing prompt may rely on: answered, declined,
        busy, unanswered or unknown. Failures with no provider detail are unknown."""
        if self.answered:
            return "answered"
        if self.status == "rejected":
            return "declined"
        if self.status == "busy":
            return "busy"
        if self.status == "no_answer" and self.rang:
            return "unanswered"
        return "unknown"


def derive_attempts(rows: list[dict[str, Any]], *, current_id: str, now: float | None = None) -> list[AttemptFact]:
    """Facts for the attempts that came BEFORE the current call, newest first.

    ``rows`` are calls of one retry chain. The current call is excluded: an earlier
    attempt is history, never "the current call". Each row contributes only its own
    events, so a late event from attempt 1 cannot appear on attempt 2.
    """
    now = now if now is not None else datetime.now(timezone.utc).timestamp()
    out: list[AttemptFact] = []
    for row in rows:
        if str(row.get("id")) == str(current_id):
            continue
        events = row.get("attempt_events") if isinstance(row.get("attempt_events"), list) else []
        states: list[str] = []
        for ev in events:
            state = ev.get("state") if isinstance(ev, dict) else None
            if state in ATTEMPT_STATES and state not in states:
                states.append(state)
        answered = (
            "answered" in states
            or bool(row.get("answered_at"))
            or (row.get("status") == "completed" and int(row.get("duration_seconds") or 0) > 0)
        )
        created = _parse_ts(row.get("created_at"))
        out.append(
            AttemptFact(
                call_id=str(row.get("id")),
                attempt_number=int(row.get("attempt_number") or 1),
                status=str(row.get("status") or ""),
                states=tuple(states),
                age_secs=(now - created) if created is not None else None,
                answered=answered,
            )
        )
    out.sort(key=lambda a: a.attempt_number, reverse=True)
    return out


def in_chain(row: dict[str, Any], *, root_id: str | None, current_id: str) -> bool:
    """Is this row part of the same retry chain as the current call?"""
    if not root_id:
        return False
    rid = str(row.get("id"))
    return rid != str(current_id) and (rid == root_id or str(row.get("retry_of") or "") == root_id)


def render_attempt_lines(attempt_number: int, previous: list[AttemptFact]) -> list[str]:
    """Spoken-prompt lines about the call's attempt history. Neutral on purpose.

    Says that earlier attempts exist and the one thing the provider established
    about the latest one, never a reason. Explicitly marks the rest as unknown.
    """
    if attempt_number <= 1 and not previous:
        return []
    lines = [
        f"This is attempt {max(attempt_number, 2)} of the same call. It is a fresh call: open it the way you would open a first one."
    ]
    if previous:
        last = previous[0]
        outcome = {
            "answered": "it was answered, then ended",
            "declined": "it was declined",
            "busy": "the line was busy",
            "unanswered": "it rang and was not picked up",
            "unknown": "how it ended is not known",
        }[last.outcome]
        lines.append(f"The most recent earlier attempt: {outcome}.")
    lines.append(
        "You do not know why an earlier attempt did not connect, and you must not guess. "
        "Do not mention it unless they do. Never say a call did not ring, and never ask "
        "whether they have or have set up the app you are calling on. If they say they "
        "missed a call or did not hear it ring, say you are not sure and carry on."
    )
    return lines


@dataclass
class AttemptContext:
    """Attempt facts attached to the per-call context object."""

    attempt_number: int = 1
    retry_of: str | None = None
    previous: list[AttemptFact] = field(default_factory=list)

    @property
    def lines(self) -> list[str]:
        return render_attempt_lines(self.attempt_number, self.previous)
