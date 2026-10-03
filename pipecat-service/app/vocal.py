"""Contextual vocalisations and delivery markers for Emysa's speech.

Fish Audio — the TTS this service uses — genuinely supports non-verbal
vocalisations and delivery control through inline tags, so Emysa can laugh,
chuckle, giggle, sigh, clear her throat or hum as *audio*, not as bracketed
text that gets read out loud. Verified against Fish Audio's emotion-control
documentation (docs.fish.audio/developer-guide/core-features/emotions):

  * **S2-Pro / S2.1-Pro** (current models): ``[bracket]`` cues —
    ``[laughing]``, ``[chuckling]``, ``[giggling]``, ``[sighing]``,
    ``[clearing throat]``, ``[gasping]``, ``[soft]``, ``[whispering]``,
    ``[emphasis]``, ``[break]`` — plus free-form descriptors.
  * **S1** (legacy, what the app's HTTP ``/v1/tts`` path requests): a fixed
    tag set in ``(parentheses)`` — ``(laughing)``, ``(chuckling)``,
    ``(sighing)``, ``(clear throat)``, ``(gasping)``, ``(break)``. Anything
    outside the fixed set is NOT a tag on S1 and may be read out as literal
    text, so unknown markers are dropped rather than forwarded.

The model writes a single canonical vocabulary (``[laughing]`` etc.) into its
reply; this module:

  1. **translates** markers to the active TTS model's syntax before speech,
  2. **converts** markers to quiet parenthetical annotations (``(laughs)``)
     for the transcript, so no control tag ever lands in the transcript,
  3. **enforces timing**: vocalisations must be contextual, varied and
     OCCASIONAL. A :class:`VocalisationPolicy` rate-limits them and drops
     laughter in serious emotional contexts — even if the model over-fires.
     No extra LLM call is involved anywhere.

Streaming safety: LLM tokens arrive in chunks and a marker can straddle two
chunks ("[laugh" + "ing]"). :func:`split_complete` withholds a trailing
partial marker so the TTS never sees half of one (which would be spoken as
literal text).
"""

from __future__ import annotations

import re
import time
from dataclasses import dataclass, field

#: canonical marker -> (fish S2 bracket tag, fish S1 paren tag, transcript annotation)
#: S1 values of None mean "no verified S1 tag exists; drop the marker".
_MARKERS: dict[str, tuple[str | None, str | None, str | None]] = {
    "laughing": ("[laughing]", "(laughing)", "(laughs)"),
    "laugh": ("[laughing]", "(laughing)", "(laughs)"),
    "chuckling": ("[chuckling]", "(chuckling)", "(chuckles)"),
    "chuckle": ("[chuckling]", "(chuckling)", "(chuckles)"),
    "giggling": ("[giggling]", "(chuckling)", "(giggles)"),
    "giggle": ("[giggling]", "(chuckling)", "(giggles)"),
    "sighing": ("[sighing]", "(sighing)", "(sighs)"),
    "sigh": ("[sighing]", "(sighing)", "(sighs)"),
    "clearing throat": ("[clearing throat]", "(clear throat)", "(clears throat)"),
    "clear throat": ("[clearing throat]", "(clear throat)", "(clears throat)"),
    "gasping": ("[gasping]", "(gasping)", "(gasps)"),
    "gasp": ("[gasping]", "(gasping)", "(gasps)"),
    # No verified S1 audio tag for humming: the marker is dropped on S1 and
    # the spoken "Hmm." the prompt asks for alongside it carries the moment.
    "humming": ("[humming]", None, "(hums)"),
    "hum": ("[humming]", None, "(hums)"),
    # Delivery-only markers: shape the speech, never annotated in the
    # transcript, and forwarded only where the model understands them.
    "soft": ("[soft]", "(soft tone)", None),
    "whispering": ("[whispering]", "(whispering)", None),
    "emphasis": ("[emphasis]", None, None),
    "break": ("[break]", "(break)", None),
    "pause": ("[break]", "(break)", None),
}

#: Marker kinds that are laughter/playful — suppressed in serious contexts.
_LAUGHTER_KINDS = frozenset({"laughing", "laugh", "chuckling", "chuckle", "giggling", "giggle"})
_HUM_KINDS = frozenset({"humming", "hum"})

#: Delivery-only markers: they shape tone and never add a sound, so the
#: rate limiter does not apply to them.
_DELIVERY_KINDS = frozenset({"soft", "whispering", "emphasis", "break", "pause"})

#: Emotions in which laughter must not fire (the brief: never force laughter
#: into serious conversations).
_SERIOUS_EMOTIONS = frozenset({"concerned", "sad", "empathetic", "focused"})

# Any canonical marker: [tag] (permissive on brackets — unknown ones are
# stripped, never leaked) or (tag) (restricted to names we could have emitted
# — real prose may contain parentheses). [[END_CALL]]-style double-bracket
# control tags are handled by app.emotion, not here.
_PAREN_NAMES = sorted(
    {
        *(name for name in _MARKERS),
        *(s1.strip("()") for _s2, s1, _t in _MARKERS.values() if s1),
    },
    key=len,
    reverse=True,
)
_MARKER_RE = re.compile(
    r"\[\s*([a-z][a-z \-]{0,30}?)\s*\]"
    r"|\(\s*(" + "|".join(re.escape(name) for name in _PAREN_NAMES) + r")\s*\)",
    re.I,
)

#: Trailing fragment that may be the start of a marker ("[laugh", "(si").
#: Trailing fragment that may be the start of a marker or control tag:
#: "[laugh", "[[END", "[[MOOD:am", "(si" ... Held back until the next chunk.
_PARTIAL_MARKER_RE = re.compile(r"(\[\[?[^][\]()]*|\([^][\]()]*)$")


def split_complete(text: str) -> tuple[str, str]:
    """Split streaming text into (definitely-complete, hold-for-next-chunk).

    Withholds a trailing fragment that looks like the start of a marker or a
    ``[[...]]`` control tag so it can be re-joined with the next chunk before
    parsing — a marker straddling two LLM chunks ("[laugh" + "ing]") must
    never be half-parsed into literal speech. The held tail is at most one
    marker.
    """
    if not text:
        return "", ""
    match = _PARTIAL_MARKER_RE.search(text)
    if match:
        return text[: match.start()], match.group(1)
    return text, ""


def _canon(name: str) -> str:
    return re.sub(r"\s+", " ", name.strip().lower())


def marker_annotations(text: str) -> list[str]:
    """Transcript-form annotations for the markers in ``text``, in order."""
    out: list[str] = []
    for match in _MARKER_RE.finditer(text):
        name = _canon(match.group(1) or match.group(2) or "")
        entry = _MARKERS.get(name)
        if entry and entry[2]:
            out.append(entry[2])
    return out


def to_transcript_text(text: str) -> str:
    """Text safe for the persisted transcript: no control tags, quiet notes.

    Known markers become parenthetical annotations (or vanish for
    delivery-only ones). Unknown ``[...]`` / ``(...)`` fragments are stripped
    rather than leaked. ``[[END_CALL]]`` / ``[[MOOD:...]]`` are removed too,
    as a belt-and-braces (the pipeline strips them earlier).
    """
    if not text:
        return ""

    def repl(match: re.Match[str]) -> str:
        name = _canon(match.group(1) or match.group(2) or "")
        entry = _MARKERS.get(name)
        if entry is not None:
            return entry[2] or ""
        return ""

    out = _MARKER_RE.sub(repl, text)
    out = re.sub(r"\[\[\s*(?:END_CALL|MOOD|FEEL)\s*[^\]]*\]\]", "", out, flags=re.I)
    return re.sub(r"[ \t]{2,}", " ", out).strip()


def to_tts_text(text: str, *, syntax: str = "s2") -> str:
    """Translate canonical markers into the active Fish model's syntax.

    ``syntax`` is ``"s1"`` (parentheses, fixed tag set) or ``"s2"``
    (brackets; also the default for unknown/newer models). Unknown markers
    and all ``[[...]]`` control tags are dropped — an unrecognised tag read
    out loud by the TTS would corrupt the speech.
    """
    if not text:
        return ""

    def repl(match: re.Match[str]) -> str:
        name = _canon(match.group(1) or match.group(2) or "")
        entry = _MARKERS.get(name)
        if entry is None:
            return ""
        tag = entry[1] if syntax == "s1" else entry[0]
        return tag or ""

    out = _MARKER_RE.sub(repl, text)
    out = re.sub(r"\[\[\s*(?:END_CALL|MOOD|FEEL)\s*[^\]]*\]\]", "", out, flags=re.I)
    # Collapse whitespace left by dropped markers, but keep sentence spacing.
    out = re.sub(r"[ \t]{2,}", " ", out)
    out = re.sub(r"\s+([,.;!?])", r"\1", out)
    return out.strip()


@dataclass
class VocalisationPolicy:
    """Keeps vocalisations contextual, varied and occasional.

    Stateless w.r.t. the LLM: it only ever *removes* markers the model
    over-produced. Enforced rules:

      * at most one vocalisation per ``min_gap_secs`` (default 25 s) and
        ``max_per_window`` per rolling hour — "occasional", by construction.
        The gap is GLOBAL across vocalisation kinds: a chuckle straight after
        a laugh is not "varied and occasional", it is manic. Sighs, gasps and
        throat-clears count too — anything audible is a vocalisation;
      * laughter/giggles/humming are dropped when the emotional state is
        serious (low pleasure / concerned / sad) — no forced laughter;
      * delivery markers ([soft], [emphasis], [break]) are always allowed —
        they shape tone rather than inject sounds.
    """

    min_gap_secs: float = 25.0
    max_per_window: int = 24
    window_secs: float = 3600.0
    _last_vocalisation_at: float | None = field(default=None)
    _history: list[float] = field(default_factory=list)

    def allow(self, kind: str, *, emotion: str | None = None, pleasure: float | None = None, now: float | None = None) -> bool:
        now = now if now is not None else time.time()
        kind = _canon(kind)
        if kind in _DELIVERY_KINDS or (kind not in _LAUGHTER_KINDS and kind not in _HUM_KINDS and kind not in _MARKERS):
            return True  # delivery markers pass; unknown markers are dropped elsewhere
        if kind in _LAUGHTER_KINDS or kind in _HUM_KINDS:
            if emotion and _canon(emotion) in _SERIOUS_EMOTIONS:
                return False
            if pleasure is not None and pleasure < -0.25:
                return False
        last = self._last_vocalisation_at
        if last is not None and (now - last) < self.min_gap_secs:
            return False
        recent = [t for t in self._history if (now - t) < self.window_secs]
        if len(recent) >= self.max_per_window:
            return False
        return True

    def process(
        self,
        text: str,
        *,
        syntax: str = "s2",
        emotion: str | None = None,
        pleasure: float | None = None,
        now: float | None = None,
    ) -> tuple[str, str]:
        """Return ``(tts_text, transcript_text)`` with policy applied.

        Disallowed vocalisation markers are removed from BOTH outputs (the
        words around them stay). Allowed ones are recorded so the next call
        to ``allow`` can rate-limit.
        """
        now = now if now is not None else time.time()
        if not text:
            return "", ""
        kept: list[tuple[int, int, str]] = []
        removed: list[tuple[int, int]] = []
        for match in _MARKER_RE.finditer(text):
            name = _canon(match.group(1) or match.group(2) or "")
            entry = _MARKERS.get(name)
            if entry is None:
                removed.append(match.span())
                continue
            if name not in _DELIVERY_KINDS:
                if not self.allow(name, emotion=emotion, pleasure=pleasure, now=now):
                    removed.append(match.span())
                    continue
                self._last_vocalisation_at = now
                self._history = [t for t in self._history if (now - t) < self.window_secs]
                self._history.append(now)
            kept.append((match.start(), match.end(), name))

        def rebuild(syntax_for: str | None, annotation: bool) -> str:
            out: list[str] = []
            cursor = 0
            spans = kept + [(s, e, "") for s, e in removed]
            spans.sort(key=lambda item: item[0])
            for start, end, name in spans:
                out.append(text[cursor:start])
                if name:
                    entry = _MARKERS[name]
                    if annotation:
                        out.append(entry[2] or "")
                    else:
                        tag = entry[1] if syntax_for == "s1" else entry[0]
                        out.append(tag or "")
                cursor = end
            out.append(text[cursor:])
            return re.sub(r"[ \t]{2,}", " ", "".join(out)).strip()

        tts_text = rebuild(syntax, annotation=False)
        if syntax != "s1":
            tts_text = re.sub(r"\s+([,.;!?])", r"\1", tts_text)
        transcript_text = rebuild(None, annotation=True)
        transcript_text = re.sub(
            r"\[\[\s*(?:END_CALL|MOOD|FEEL)\s*[^\]]*\]\]", "", transcript_text, flags=re.I
        )
        return tts_text, transcript_text


# ---------------------------------------------------------------------------
# Emotion -> delivery cue
# ---------------------------------------------------------------------------
#: Tone cues Fish S2 documents as built-ins ("[excited]", "[sad]", "[surprised]",
#: "[low voice]"). S2 reads bracket tags as natural-language instructions and
#: puts the cue at the start of the sentence it should colour. They shape HOW
#: a sentence is said and add no sound, so they are never written to the
#: transcript (to_transcript_text strips them).
#:
#: Only emotions that call for a change from the voice's natural default are
#: mapped. warm / calm / curious / focused / encouraging get no cue: untagged S2
#: speech is already conversational, and tagging every sentence is the
#: "theatrical" failure Fish's own guide warns about.
_EMOTION_CUES: dict[str, tuple[str, float]] = {
    # emotion: (S2 cue, minimum intensity before it is worth using)
    "joyful": ("[excited]", 0.55),
    "amused": ("[excited]", 0.62),
    "concerned": ("[low voice]", 0.5),
    "empathetic": ("[low voice]", 0.5),
}


@dataclass
class DeliveryCuePolicy:
    """Chooses at most one tone cue per response, from the live emotion state.

    No LLM call: it reads the emotion engine's state that already exists.
    Variation rule: the response straight after a cued one gets none, so the
    delivery breathes instead of being tinted every single turn.
    """

    _last_cued_response: int = field(default=-10)
    _response_index: int = field(default=0)

    def begin_response(self) -> None:
        self._response_index += 1

    def cue_for(self, emotion: str | None, intensity: float | None, *, syntax: str) -> str | None:
        if syntax == "s1":
            return None  # S1's fixed tag set has no equivalent verified cue
        entry = _EMOTION_CUES.get(_canon(emotion or ""))
        if not entry:
            return None
        cue, floor = entry
        if (intensity if intensity is not None else 0.0) < floor:
            return None
        if self._response_index - self._last_cued_response <= 1:
            return None
        self._last_cued_response = self._response_index
        return cue


_SENTENCE_END_RE = re.compile(r"[.!?\u2026][\"')\]]*\s*$")


def at_sentence_boundary(emitted: str) -> bool:
    """True when ``emitted`` ends a sentence (so the next word starts one)."""
    return bool(_SENTENCE_END_RE.search(emitted or ""))


def starts_with_tag(text: str) -> bool:
    return bool(re.match(r"\s*(\[|\()", text or ""))
