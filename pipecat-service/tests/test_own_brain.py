"""Luna as the brain of an Inworld call: sentence cutting, the streamed reply, and the settings it reads."""

import types

import pytest

from app import own_brain as ob


def test_sentences_are_cut_only_when_complete_and_long_enough():
    ready, rest = ob.split_ready("Sure thing. I can help with that. And then", ob.MIN_FIRST_CHARS)
    assert ready == ["Sure thing.", "I can help with that."] and rest == "And then"
    # the end of the buffer is not a boundary yet: the next token may continue the number
    assert ob.split_ready("It costs 3.", ob.MIN_FIRST_CHARS) == ([], "It costs 3.")
    assert ob.split_ready("It costs 3.5 dollars. Ok", ob.MIN_FIRST_CHARS)[0] == ["It costs 3.5 dollars."]
    # a fragment shorter than the minimum is kept with the next sentence
    assert ob.split_ready("Hi. How are you doing today? Fine", 12) == (["Hi. How are you doing today?"], "Fine")


def test_text_is_cleaned_for_speech_but_voice_cues_are_kept():
    assert ob.clean_for_speech("**Sure**, here's a `list`:\n\n# Plan  one \U0001F600") == "Sure, here's a list: Plan one"
    assert ob.clean_for_speech("[laughs] That is funny") == "[laughs] That is funny"


class _Chunk:
    def __init__(self, text):
        self.choices = [types.SimpleNamespace(delta=types.SimpleNamespace(content=text))]


class _Stream:
    def __init__(self, parts):
        self._parts, self.closed = parts, False

    def __aiter__(self):
        return self._gen()

    async def _gen(self):
        for p in self._parts:
            yield _Chunk(p)
        yield types.SimpleNamespace(choices=[])  # a usage-only chunk has no choices

    async def close(self):
        self.closed = True


class _Client:
    def __init__(self, parts):
        self.stream, self.calls = _Stream(parts), []
        self.chat = types.SimpleNamespace(completions=types.SimpleNamespace(create=self._create))

    async def _create(self, **kw):
        self.calls.append(kw)
        return self.stream


@pytest.mark.asyncio
async def test_the_reply_is_streamed_as_sentences_with_the_prompt_and_history():
    client = _Client(["Sure thing", ". I can help", " with that", ". Anything else", "?"])
    brain = ob.LlmBrain(api_key="k", model="gpt-6-luna", extra={"reasoning_effort": "none"}, client=client)
    history = [{"role": "user", "content": "hi"}]
    out = [s async for s in brain.stream_sentences("BE BRIEF", history)]
    # the first sentence goes out at once; later short ones are joined so speech is not choppy
    assert out == ["Sure thing.", "I can help with that. Anything else?"]
    call = client.calls[0]
    assert call["model"] == "gpt-6-luna" and call["stream"] is True and call["reasoning_effort"] == "none"
    assert call["messages"] == [{"role": "system", "content": "BE BRIEF"}, {"role": "user", "content": "hi"}]
    assert client.stream.closed


@pytest.mark.asyncio
async def test_only_recent_history_is_sent():
    client = _Client(["ok."])
    brain = ob.LlmBrain(api_key="k", model="m", client=client, max_history=3)
    hist = [{"role": "user", "content": str(i)} for i in range(10)]
    [s async for s in brain.stream_sentences("P", hist)]
    assert [m["content"] for m in client.calls[0]["messages"][1:]] == ["7", "8", "9"]


def test_the_brain_comes_from_the_configured_luna_settings():
    settings = types.SimpleNamespace(
        mock_mode=False, llm_reasoning_effort="none",
        resolved_llm_api_key=lambda: "sk-test", resolved_llm_model=lambda: "gpt-6-luna",
        resolved_llm_base_url=lambda: "https://api.openai.com/v1",
    )
    brain = ob.LlmBrain.from_settings(settings)
    assert brain is not None and brain.model == "gpt-6-luna"
    assert ob.LlmBrain.from_settings(types.SimpleNamespace(**{**vars(settings), "resolved_llm_api_key": lambda: ""})) is None
    assert ob.LlmBrain.from_settings(types.SimpleNamespace(**{**vars(settings), "mock_mode": True})) is None
