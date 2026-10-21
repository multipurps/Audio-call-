"""The agent voices (Custom = Inworld + Luna, Live presets = Grok) hang up by themselves.

Before this, an agent call had no way to end: Luna had no tool or token, Grok had no tool, and the
wrap-up supervisor (time budget, goodbyes exchanged) was never started for agent calls. These tests
drive the real GrokAgentConversation and the real CallConversation wiring with fake sockets.
"""

import asyncio
import json
import types

import pytest

from app import grok_conversation as gc
from app import own_brain as ob
from app.call_wrapup import FarewellTracker, is_hard_cue, wrapup_cue
from app.grok_realtime import (
    END_CALL_TOOL,
    HANGUP_RULES as GROK_HANGUP_RULES,
    GrokRealtimeClient,
    RealtimeEvent,
    build_session_update,
)
from tests.test_conversation import make_conversation


async def settle(n=60):
    for _ in range(n):
        await asyncio.sleep(0)


# --------------------------------------------------------------------------------------- fakes


class FakeClient:
    """Stands in for the Inworld and the Grok socket: records what is sent, replays pushed events."""

    def __init__(self, session_update):
        self.session_update = session_update
        self.spoken, self.cancels, self.results, self.response_creates = [], 0, [], 0
        self.q: asyncio.Queue = asyncio.Queue()

    async def start(self): ...
    async def send_caller_audio(self, pcm): ...
    async def send_speak(self, text): self.spoken.append(text)
    async def send_greeting(self, text): self.spoken.append(text)
    async def send_cancel(self): self.cancels += 1
    async def send_function_result(self, call_id, output): self.results.append((call_id, output))
    async def send_response_create(self): self.response_creates += 1
    async def close(self): ...

    async def events(self):
        while True:
            ev = await self.q.get()
            if ev is None:
                return
            yield ev

    def push(self, kind, **kw):
        self.q.put_nowait(RealtimeEvent(kind, **kw))


class FakeSender:
    def __init__(self, **_):
        self.speaking = False

    def start(self): ...
    async def enqueue(self, pcm, rate, channels=1): ...
    async def interrupt(self): return 0
    async def stop(self): ...
    def stats(self): return {}


class FakeBrain:
    model = "gpt-6-luna"

    def __init__(self, replies):
        self.replies, self.prompts, self.histories = list(replies), [], []

    async def stream_sentences(self, prompt, history):
        self.prompts.append(prompt)
        self.histories.append([dict(m) for m in history])
        for sentence in self.replies.pop(0):
            yield sentence


class Notes:
    def __init__(self): self.lines = []
    def note(self, who, text, *, interrupted=False): self.lines.append((who, text))


@pytest.fixture
def rig(monkeypatch):
    made = {}

    def make_client(*, api_key, session_update, **_):
        made["client"] = FakeClient(session_update)
        return made["client"]

    async def key(_settings): return "key"

    monkeypatch.setattr(gc, "InworldRealtimeClient", make_client)
    monkeypatch.setattr(gc, "GrokRealtimeClient", make_client)
    monkeypatch.setattr(gc, "resolve_inworld_key", key)
    monkeypatch.setattr(gc, "resolve_xai_key", key)
    monkeypatch.setattr(gc, "PacedAudioSender", FakeSender)
    return made


def make(provider, *, brain=None, ends=None, greeting=None, transcript=None):
    settings = types.SimpleNamespace(bridge_sample_rate=16000, mock_mode=False, inworld_model=None,
                                     xai_api_key="k", supabase_url=None, supabase_service_role_key=None)
    return gc.GrokAgentConversation(
        settings=settings, session_id="call-1", serializer=None, send_audio=None, send_control=None,
        on_ended=None, prompt="THE INSTRUCTIONS", greeting=greeting, voice_id="v1",
        transcript=transcript, provider=provider, brain=brain,
        on_end_call=(lambda: ends.append(1)) if ends is not None else None,
    )


# ------------------------------------------------------------ Custom voice: Inworld + Luna


@pytest.mark.asyncio
async def test_luna_ends_the_call_with_the_token_after_the_goodbye_has_been_spoken(rig):
    ends = []
    conv = make("inworld", brain=FakeBrain([["Take care, goodbye!", "[[END_CALL]]"]]), ends=ends)
    await conv.start()
    client = rig["client"]
    client.push("user_transcript", text="Okay that's everything, thanks")
    await settle()
    assert client.spoken == ["Take care, goodbye!"]      # the token is never spoken
    assert ends == []                                      # and the call stays up while the goodbye is playing
    client.push("response_done")                           # the goodbye has been spoken in full
    await settle()
    assert ends == [1]
    await conv.stop()


@pytest.mark.asyncio
async def test_the_token_stuck_to_the_goodbye_is_stripped_and_still_hangs_up(rig):
    ends = []
    conv = make("inworld", brain=FakeBrain([["Talk soon, bye![[END_CALL]]"]]), ends=ends)
    await conv.start()
    client = rig["client"]
    client.push("user_transcript", text="Alright then")
    await settle()
    assert client.spoken == ["Talk soon, bye!"]
    client.push("response_done")
    await settle()
    assert ends == [1]
    await conv.stop()


@pytest.mark.asyncio
async def test_a_reply_without_the_token_never_hangs_up(rig):
    ends = []
    conv = make("inworld", brain=FakeBrain([["Sure, I can do that.", "Anything else you need?"]]), ends=ends)
    await conv.start()
    client = rig["client"]
    client.push("user_transcript", text="Can you book it for Friday")
    await settle()
    client.push("response_done")
    await settle()
    client.push("response_done")
    await settle()
    assert ends == []
    await conv.stop()


@pytest.mark.asyncio
async def test_the_token_is_ignored_while_the_caller_is_still_asking(rig):
    ends = []
    conv = make("inworld", brain=FakeBrain([["Of course, goodbye for now. [[END_CALL]]"]]), ends=ends)
    await conv.start()
    client = rig["client"]
    client.push("user_transcript", text="Wait, can you also call me tomorrow?")
    await settle()
    client.push("response_done")
    await settle()
    assert client.spoken == ["Of course, goodbye for now."]    # still never read aloud
    assert ends == []                                            # but the caller was not done: no hangup
    await conv.stop()


@pytest.mark.asyncio
async def test_asked_to_hang_up_a_goodbye_alone_ends_the_call(rig):
    ends = []
    conv = make("inworld", brain=FakeBrain([["Okay, goodbye!"]]), ends=ends)   # Luna forgot the token
    await conv.start()
    client = rig["client"]
    client.push("user_transcript", text="Please hang up now")
    await settle()
    client.push("response_done")
    await settle()
    assert ends == [1]
    await conv.stop()


@pytest.mark.asyncio
async def test_the_caller_talking_over_the_goodbye_cancels_the_hangup(rig):
    ends = []
    brain = FakeBrain([["Goodbye then. [[END_CALL]]"], ["Sure, go ahead."]])
    conv = make("inworld", brain=brain, ends=ends)
    await conv.start()
    client = rig["client"]
    client.push("user_transcript", text="Okay thanks")
    await settle()
    assert ends == []
    client.push("interrupted")                      # "bye... oh, one more thing"
    client.push("user_transcript", text="Oh, one more thing")
    await settle()
    client.push("response_done")
    client.push("response_done")
    await settle()
    assert ends == []
    assert client.spoken[-1] == "Sure, go ahead."
    await conv.stop()


@pytest.mark.asyncio
async def test_what_emysa_says_reaches_the_transcript_so_the_goodbye_backstop_can_see_it(rig):
    notes = Notes()
    conv = make("inworld", brain=FakeBrain([["Take care, goodbye!"]]), greeting="Hi, Emysa here.", transcript=notes)
    await conv.start()
    client = rig["client"]
    client.push("response_done")                                    # the greeting finished playing
    client.push("user_transcript", text="That's all, bye")
    await settle()
    assert ("ai", "Hi, Emysa here.") in notes.lines and ("ai", "Take care, goodbye!") in notes.lines
    client.push("agent_transcript", text="Take care, goodbye!")     # the provider's own copy is not added twice
    await settle()
    assert notes.lines.count(("ai", "Take care, goodbye!")) == 1
    await conv.stop()


def test_luna_is_told_how_to_hang_up_and_to_ignore_the_backend_action():
    assert "[[END_CALL]]" in ob.HANGUP_RULES and "end_call" in ob.HANGUP_RULES
    prompt = make("inworld", brain=FakeBrain([[]]))._brain_prompt([])
    assert prompt.startswith("THE INSTRUCTIONS") and ob.HANGUP_RULES in prompt


def test_the_end_token_survives_the_speech_cleaner_in_every_spelling():
    for raw in ("Bye! [[END_CALL]]", "Bye! [[ end call ]]", "Bye! [[ENDCALL]]", "Bye! [[end_call]]"):
        assert ob.clean_for_speech(raw) == "Bye! [[END_CALL]]"
    assert ob.clean_for_speech("Okay [laughs] sure_thing") == "Okay [laughs] surething"   # other cleaning unchanged


@pytest.mark.asyncio
async def test_the_token_is_found_even_when_the_model_streams_it_in_pieces():
    class Chunk:
        def __init__(self, text):
            self.choices = [types.SimpleNamespace(delta=types.SimpleNamespace(content=text))]

    class Stream:
        def __aiter__(self): return self._gen()

        async def _gen(self):
            for part in ("Take care! [[END", "_CALL]]"):
                yield Chunk(part)

        async def close(self): ...

    async def create(**kw): return Stream()

    client = types.SimpleNamespace(chat=types.SimpleNamespace(completions=types.SimpleNamespace(create=create)))
    brain = ob.LlmBrain(api_key="k", model="m", client=client)
    assert [s async for s in brain.stream_sentences("sys", [])] == ["Take care!", "[[END_CALL]]"]


# ---------------------------------------------------------- Live presets: Grok with end_call


def test_grok_gets_the_end_call_tool_and_the_rules_only_when_the_call_can_hang_up():
    plain = build_session_update(instructions="X", voice_id=None)
    assert "tools" not in plain and plain["instructions"] == "X"
    armed = build_session_update(instructions="X", voice_id=None, end_call_tool=True)
    assert [t["name"] for t in armed["tools"]] == [END_CALL_TOOL] and armed["tools"][0]["type"] == "function"
    assert armed["instructions"].startswith("X") and GROK_HANGUP_RULES in armed["instructions"]


@pytest.mark.asyncio
async def test_grok_session_is_armed_when_the_call_conversation_can_hang_up(rig):
    armed = make("grok", ends=[])
    await armed.start()
    assert [t["name"] for t in rig["client"].session_update["tools"]] == [END_CALL_TOOL]
    await armed.stop()
    plain = make("grok")
    await plain.start()
    assert "tools" not in rig["client"].session_update
    await plain.stop()


@pytest.mark.asyncio
async def test_grok_says_goodbye_then_calls_end_call_and_the_call_ends_when_that_response_is_done(rig):
    ends = []
    conv = make("grok", ends=ends)
    await conv.start()
    client = rig["client"]
    client.push("user_transcript", text="That's all, thanks, bye")
    client.push("other", raw_type="response.created")
    client.push("audio", audio=b"\x01\x00" * 160)                # its spoken goodbye
    client.push("function_call", text=END_CALL_TOOL, call_id="c1")
    await settle()
    assert client.results == [("c1", {"ok": True, "note": "The call is ending. If you have not already, say a brief goodbye."})]
    assert client.response_creates == 0                          # it already said goodbye: no second one
    assert ends == []                                            # not until its response is over
    client.push("other", raw_type="response.done")
    await settle()
    assert ends == [1]
    await conv.stop()


@pytest.mark.asyncio
async def test_grok_that_calls_end_call_silently_is_asked_for_a_goodbye_first(rig):
    ends = []
    conv = make("grok", ends=ends)
    await conv.start()
    client = rig["client"]
    client.push("user_transcript", text="Okay, please end the call")
    client.push("other", raw_type="response.created")
    client.push("function_call", text=END_CALL_TOOL, call_id="c2")     # no audio before the call
    await settle()
    assert client.response_creates == 1                                # it is asked to say goodbye
    client.push("other", raw_type="response.done")                     # the response that carried the call
    await settle()
    assert ends == []                                                  # the goodbye is still to come
    client.push("other", raw_type="response.created")
    client.push("audio", audio=b"\x01\x00" * 160)
    client.push("other", raw_type="response.done")
    await settle()
    assert ends == [1]
    await conv.stop()


@pytest.mark.asyncio
async def test_grok_end_call_is_refused_while_the_caller_is_still_talking(rig):
    ends = []
    conv = make("grok", ends=ends)
    await conv.start()
    client = rig["client"]
    client.push("user_transcript", text="Hold on, one more thing")
    client.push("function_call", text=END_CALL_TOOL, call_id="c3")
    await settle()
    (call_id, output), = client.results
    assert call_id == "c3" and output["ok"] is False
    assert client.response_creates == 1                                # it carries on the conversation
    client.push("other", raw_type="response.done")
    await settle()
    assert ends == []
    await conv.stop()


@pytest.mark.asyncio
async def test_grok_hangup_is_cancelled_if_the_caller_speaks_over_the_goodbye(rig):
    ends = []
    conv = make("grok", ends=ends)
    await conv.start()
    client = rig["client"]
    client.push("user_transcript", text="Thanks, bye")
    client.push("audio", audio=b"\x01\x00" * 160)
    client.push("function_call", text=END_CALL_TOOL, call_id="c4")
    client.push("interrupted")
    client.push("other", raw_type="response.done")
    await settle()
    assert ends == []
    await conv.stop()


@pytest.mark.asyncio
async def test_grok_hangs_up_anyway_if_its_goodbye_never_finishes(rig, monkeypatch):
    monkeypatch.setattr(gc, "END_CALL_RESPONSE_TIMEOUT_SECS", 0.05)
    ends = []
    conv = make("grok", ends=ends)
    await conv.start()
    client = rig["client"]
    client.push("user_transcript", text="Bye now")
    client.push("function_call", text=END_CALL_TOOL, call_id="c5")
    await settle()
    assert ends == []
    await asyncio.sleep(0.15)
    assert ends == [1]
    await conv.stop()


@pytest.mark.asyncio
async def test_grok_ignores_functions_it_does_not_have(rig):
    ends = []
    conv = make("grok", ends=ends)
    await conv.start()
    client = rig["client"]
    client.push("function_call", text="launch_rocket", call_id="c6")
    await settle()
    assert client.results[0][1]["ok"] is False and ends == []
    await conv.stop()


@pytest.mark.asyncio
async def test_the_realtime_client_reads_function_calls_and_answers_them():
    from tests.test_grok_realtime import FakeSocket

    sock = FakeSocket([
        {"type": "response.function_call_arguments.done", "name": "end_call", "call_id": "abc", "arguments": "{}"},
    ])

    async def connect(url): return sock

    client = GrokRealtimeClient(api_key="k", session_update={}, connect=connect)
    await client.start()
    (event,) = [e async for e in client.events()]
    assert (event.kind, event.text, event.call_id) == ("function_call", "end_call", "abc")
    await client.send_function_result("abc", {"ok": True})
    await client.send_response_create()
    item = sock.sent[-2]["item"]
    assert item["type"] == "function_call_output" and item["call_id"] == "abc" and json.loads(item["output"]) == {"ok": True}
    assert sock.sent[-1] == {"type": "response.create"}


# ------------------------------------------------- the time budget reaches the Custom voice


@pytest.mark.asyncio
async def test_time_is_up_makes_luna_write_the_closing_line_now_and_the_call_ends(rig):
    ends = []
    brain = FakeBrain([["Right, I will let you go now. Goodbye! [[END_CALL]]"]])
    conv = make("inworld", brain=brain, ends=ends)
    await conv.start()
    client = rig["client"]
    cue = wrapup_cue("hard", 60)
    assert is_hard_cue(cue) and not is_hard_cue(wrapup_cue("soft", 60))
    await conv.inject_cue(cue)                           # no caller turn needed
    await settle()
    assert brain.prompts and cue in brain.prompts[0]
    assert client.spoken == ["Right, I will let you go now. Goodbye!"]
    client.push("response_done")
    await settle()
    assert ends == [1]
    await conv.stop()


@pytest.mark.asyncio
async def test_the_early_cue_waits_for_luna_next_reply_and_is_used_once(rig):
    brain = FakeBrain([["Sure."], ["Okay."]])
    conv = make("inworld", brain=brain, ends=[])
    await conv.start()
    client = rig["client"]
    soft = wrapup_cue("soft", 60)
    await conv.inject_cue(soft)
    await settle()
    assert brain.prompts == []                            # not an interruption: nothing is written yet
    client.push("user_transcript", text="Tell me more")
    await settle()
    assert soft in brain.prompts[0]
    client.push("response_done")
    client.push("user_transcript", text="And then")
    await settle()
    assert soft not in brain.prompts[1]
    await conv.stop()


# --------------------------------------- the call itself: supervisor starts, hangup waits for audio


class FakeAgent:
    def __init__(self):
        self.speaking, self.cues, self.stopped = False, [], None

    async def note_call_active(self, source): return True
    async def inject_cue(self, text): self.cues.append(text)
    async def stop(self, reason="stopped"): self.stopped = reason
    def is_speaking(self): return self.speaking
    def stats(self): return {"engine": "agent"}


@pytest.mark.asyncio
async def test_answering_an_agent_call_starts_the_wrapup_supervisor():
    conv, _out, _ctl, _llm = make_conversation()
    conv._arm_wrapup(types.SimpleNamespace(instructions="", objective=""))
    conv._agent = FakeAgent()
    assert conv._wrapup_task is None
    await conv.note_call_active("relay-signal")
    assert conv._wrapup_task is not None            # it never started for agent calls before
    await conv.stop("test")


@pytest.mark.asyncio
async def test_wrapup_cues_go_to_the_agent_not_the_missing_pipeline():
    conv, *_ = make_conversation()
    conv._agent = FakeAgent()
    await conv._inject_wrapup_cue("Time is up: wrap up.")
    assert conv._agent.cues == ["Time is up: wrap up."]


@pytest.mark.asyncio
async def test_the_hangup_waits_for_the_agent_goodbye_to_finish_playing():
    conv, _out, ctl, _llm = make_conversation()
    agent = FakeAgent()
    agent.speaking = True
    conv._agent = agent
    task = asyncio.create_task(conv._graceful_assistant_hangup())
    await asyncio.sleep(1.2)                        # longer than the quiet-line wait: still speaking
    assert ctl == [] and not conv._stopped
    agent.speaking = False
    await asyncio.wait_for(task, 5)
    assert ctl == ['{"type":"hangup","reason":"assistant-ended-call"}']
    assert conv._stopped and agent.stopped == "assistant-ended-call"


@pytest.mark.asyncio
async def test_goodbyes_exchanged_hang_up_an_agent_call_through_the_real_supervisor():
    conv, _out, ctl, _llm = make_conversation()
    conv._arm_wrapup(types.SimpleNamespace(instructions="", objective=""))
    conv._wrapup._tracker = FarewellTracker(settle_secs=0.1, lone_ai_secs=0.1)
    conv._wrapup._tick = 0.05
    conv._agent = FakeAgent()
    await conv.note_call_active("relay-signal")
    conv._wrapup.on_turn("contact", "Okay thanks, bye")
    conv._wrapup.on_turn("ai", "Take care, goodbye!")
    for _ in range(100):
        if ctl:
            break
        await asyncio.sleep(0.05)
    assert ctl == ['{"type":"hangup","reason":"assistant-ended-call"}']
    assert conv._stopped
