"""Our own language model (Luna) as the brain of a speech-to-speech call.

The speech-to-speech provider (Inworld) keeps the parts it is good at: hearing the caller, taking
turns, the transcript, and speaking in the caller's cloned voice. It is not asked to think. When the
caller finishes a turn, the transcript comes here, Luna writes the reply, and the reply goes back to
the provider to be spoken verbatim (Inworld's `response.speak`). So the provider's own model, and
whether a given plan allows it, never matters.

The reply is streamed and cut into sentences as it arrives, so the first sentence can be spoken while
the rest is still being written.
"""

from __future__ import annotations

import re
from collections.abc import AsyncIterator
from typing import Any

from app.config import Settings, llm_reasoning_extra

#: A short first sentence starts the audio sooner; later ones are kept longer so speech is not choppy.
MIN_FIRST_CHARS = 8
MIN_NEXT_CHARS = 24
#: Only the most recent turns are sent, so a long call does not grow the request (and the cost) forever.
MAX_HISTORY_MESSAGES = 40

# A sentence ends at . ! ? or an ellipsis, optionally followed by a closing quote or bracket, and then
# whitespace. Requiring the whitespace keeps "3.5" and "e.g.x" whole while the text is still arriving.
_BOUNDARY = re.compile(r"(?<=[.!?\u2026])[\"')\]]*\s+")
_EMOJI = re.compile(
    "[\U0001F300-\U0001FAFF\u2600-\u27BF\uFE0F\u200D]",
)
_MARKDOWN = re.compile(r"[*_`#~]+")


def split_ready(buffer: str, min_chars: int) -> tuple[list[str], str]:
    """The complete sentences at the front of `buffer` (each at least `min_chars` long), and the rest."""
    ready: list[str] = []
    start = 0
    for match in _BOUNDARY.finditer(buffer):
        piece = buffer[start : match.end()].strip()
        if len(piece) >= min_chars:
            ready.append(piece)
            start = match.end()
    return ready, buffer[start:]


def clean_for_speech(text: str) -> str:
    """Text as it should be spoken: no markdown marks or emoji, one space between words.

    Square-bracket tags such as [laughs] are left alone: the voice reads those as delivery cues."""
    text = _MARKDOWN.sub("", text)
    text = _EMOJI.sub("", text)
    return re.sub(r"\s+", " ", text).strip()


class LlmBrain:
    """Streams one reply from an OpenAI-compatible chat model, as speakable sentences."""

    def __init__(
        self,
        *,
        api_key: str,
        model: str,
        base_url: str | None = None,
        extra: dict[str, Any] | None = None,
        client: Any = None,
        max_history: int = MAX_HISTORY_MESSAGES,
    ) -> None:
        self.model = model
        self._extra = dict(extra or {})
        self._max_history = max_history
        if client is None:
            from openai import AsyncOpenAI

            client = AsyncOpenAI(api_key=api_key, base_url=base_url or None, timeout=30.0, max_retries=0)
        self._client = client

    @classmethod
    def from_settings(cls, settings: Settings) -> LlmBrain | None:
        """The brain for this deployment's configured model (Luna), or None if no key is set."""
        key = getattr(settings, "resolved_llm_api_key", lambda: "")()
        if not key or getattr(settings, "mock_mode", False):
            return None
        model = settings.resolved_llm_model()
        return cls(
            api_key=key,
            model=model,
            base_url=settings.resolved_llm_base_url(),
            extra=llm_reasoning_extra(model, settings.llm_reasoning_effort),
        )

    async def stream_sentences(self, system_prompt: str, history: list[dict[str, str]]) -> AsyncIterator[str]:
        messages = [{"role": "system", "content": system_prompt}, *history[-self._max_history :]]
        stream = await self._client.chat.completions.create(
            model=self.model, messages=messages, stream=True, **self._extra,
        )
        buffer = ""
        first = True
        try:
            async for chunk in stream:
                choices = getattr(chunk, "choices", None)
                delta = choices[0].delta.content if choices else None
                if not delta:
                    continue
                buffer += delta
                ready, buffer = split_ready(buffer, MIN_FIRST_CHARS if first else MIN_NEXT_CHARS)
                for sentence in ready:
                    spoken = clean_for_speech(sentence)
                    if spoken:
                        first = False
                        yield spoken
            tail = clean_for_speech(buffer)
            if tail:
                yield tail
        finally:
            close = getattr(stream, "close", None)
            if close is not None:
                try:
                    await close()
                except Exception:  # noqa: BLE001 - closing a finished or cancelled stream
                    pass
