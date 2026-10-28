"""An Inworld call where our own model (Luna) writes the replies and Inworld hears, takes turns and speaks."""

import asyncio
import types

import pytest

from app import grok_conversation as gc
from app.grok_realtime import RealtimeEvent


async def settle(n=30):
    for _ in range(n):
        await asyncio.sleep(0)


class FakeInworld:
    """The Inworld socket: records what we send, and replays the events a test pushes."""

    def __init__(self, session_update):
        self.session_update = session_update
        self.spoken, self.cancels, self.audio = [], 0, []
        self.q: asyncio.Queue = asyncio.Queue()

    async def start(self): ...
    async def send_caller_audio(self, pcm): self.audio.append(pcm)
    async def send_speak(self, text): self.spoken.append(text)
    async def send_greeting(self, text): self.spoken.append(text)
    async def send_cancel(self): self.cancels += 1
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
    def __init__(self, **_): self.enqueued, self.interrupts, self.pending = [], 0, 0
    def pending_frames(self): return self.pending
    def start(self): ...
    async def enqueue(self, pcm, rate, channels=1): self.enqueued.append(pcm)
    async def interrupt(self): self.interrupts += 1; return 0
    async def stop(self): ...
    def stats(self): return {}


class FakeBrain:
    """Replies with scripted sentences; a reply can wait on an event so a test can interrupt it."""

    model = "gpt-6-luna"

    def __init__(self, replies, gate=None, fail=False):
        self.replies, self.gate, self.fail, self.histories, self.prompts = list(replies), gate, fail, [], []

    async def stream_sentences(self, prompt, history):
        self.prompts.append(prompt)
        self.histories.append([dict(m) for m in history])
        if self.fail:
            raise RuntimeError("model unavailable")
        for i, sentence in enumerate(self.replies.pop(0)):
            if i == 1 and self.gate is not None:
                await self.gate.wait()
            yield sentence


@pytest.fixture
def rig(monkeypatch):
    made = {}

    def make_client(*, api_key, session_update, **_):
        made["client"] = FakeInworld(session_update)
        return made["client"]

    async def key(_settings): return "inworld-key"

    monkeypatch.setattr(gc, "InworldRealtimeClient", make_client)
    monkeypatch.setattr(gc, "resolve_inworld_key", key)
    monkeypatch.setattr(gc, "PacedAudioSender", FakeSender)
    return made


def make_conv(brain, on_ended=None, greeting="Hi, Emysa here.", transcript=None, language=None):
    settings = types.SimpleNamespace(bridge_sample_rate=16000, mock_mode=False, inworld_model=None,
                                     supabase_url=None, supabase_service_role_key=None)
    return gc.GrokAgentConversation(
        settings=settings, session_id="call-1", serializer=None, send_audio=None, send_control=None,
        on_ended=on_ended, prompt="THE INSTRUCTIONS", greeting=greeting, voice_id="ws__mine",
        transcript=transcript, provider="inworld", language=language, brain=brain,
    )


class Notes:
    def __init__(self): self.lines = []
    def note(self, who, text, *, interrupted=False): self.lines.append((who, text))


def turn_detection(client):
    return client.session_update["audio"]["input"]["turn_detection"]


@pytest.mark.asyncio
async def test_with_our_own_brain_inworld_does_not_write_replies_and_the_greeting_is_spoken(rig):
    conv = make_conv(FakeBrain([]))
    await conv.start()
    client = rig["client"]
    assert turn_detection(client)["create_response"] is False       # Inworld never calls its own model
    assert client.session_update["audio"]["output"]["voice"] == "ws__mine"
    assert client.spoken == ["Hi, Emysa here."]
    assert conv._history == [{"role": "assistant", "content": "Hi, Emysa here."}]  # Luna knows what was said
    await conv.stop()


@pytest.mark.asyncio
async def test_without_a_brain_inworld_still_writes_its_own_replies(rig):
    conv = make_conv(None)
    await conv.start()
    assert turn_detection(rig["client"])["create_response"] is True
    rig["client"].push("user_transcript", text="hello")
    await settle()
    assert rig["client"].spoken == ["Hi, Emysa here."]  # nothing of ours is spoken
    await conv.stop()


@pytest.mark.asyncio
async def test_a_finished_turn_is_answered_by_the_brain_one_line_at_a_time(rig):
    brain = FakeBrain([["Sure thing.", "I can help with that."]])
    notes = Notes()
    conv = make_conv(brain, transcript=notes)
    await conv.start()
    client = rig["client"]
    client.push("response_done")                      # the greeting finished
    client.push("user_transcript", text="Can you help me?")
    await settle()
    assert client.spoken == ["Hi, Emysa here.", "Sure thing."]   # the first line goes at once...
    client.push("response_done")
    await settle()
    assert client.spoken[-1] == "I can help with that."          # ...the next only after it finished
    assert len(brain.prompts) == 1 and brain.prompts[0].startswith("THE INSTRUCTIONS")
    assert "[[END_CALL]]" in brain.prompts[0]                    # Luna is told how to hang up
    assert brain.histories[0] == [{"role": "assistant", "content": "Hi, Emysa here."},
                                  {"role": "user", "content": "Can you help me?"}]
    client.push("response_done")
    await settle()
    assert conv._history[-2:] == [{"role": "user", "content": "Can you help me?"},
                                  {"role": "assistant", "content": "Sure thing. I can help with that."}]
    assert ("contact", "Can you help me?") in notes.lines
    await conv.stop()


@pytest.mark.asyncio
async def test_talking_over_the_agent_stops_the_reply_and_the_cut_off_audio(rig):
    gate = asyncio.Event()                      # the second sentence is still being written
    brain = FakeBrain([["Let me explain.", "First, there is a lot to say."], ["Okay, go ahead."]], gate=gate)
    conv = make_conv(brain)
    await conv.start()
    client = rig["client"]
    client.push("response_done")
    client.push("user_transcript", text="Tell me about it")
    await settle()
    assert client.spoken[-1] == "Let me explain."
    client.push("audio", audio=b"first-words")
    await settle()
    assert client.audio == [] and conv.sender.enqueued == [b"first-words"]
    client.push("interrupted")                  # the caller starts talking
    await settle()
    gate.set()
    await settle()
    assert client.cancels == 1                  # the line being spoken is cancelled
    assert client.spoken[-1] == "Let me explain."   # and the unfinished reply is never spoken
    assert conv.sender.interrupts == 1
    client.push("audio", audio=b"tail-of-cut-off-line")
    await settle()
    assert conv.sender.enqueued == [b"first-words"]  # dropped, not played
    client.push("response_done")                # Inworld finishing the cancelled line
    client.push("user_transcript", text="Wait, stop")
    await settle()
    assert client.spoken[-1] == "Okay, go ahead."
    # the history has what was actually said, in order, before the new question
    roles = [m["role"] for m in brain.histories[1]]
    assert roles == ["assistant", "user", "assistant", "user"]
    assert brain.histories[1][2]["content"] == "Let me explain."
    await conv.stop()


@pytest.mark.asyncio
async def test_an_error_right_after_our_cancel_is_the_provider_answering_it_and_does_not_count(rig):
    brain = FakeBrain([["Let me explain at some length."]])
    ended = []

    async def on_ended(reason): ended.append(reason)

    conv = make_conv(brain, on_ended=on_ended)
    await conv.start()
    client = rig["client"]
    client.push("user_transcript", text="go")
    await settle()
    for _ in range(5):                                    # five barge-ins in a row, each answered with an error
        client.push("interrupted")
        client.push("error", text="no active response")
        await settle()
    assert ended == []
    await conv.stop()


@pytest.mark.asyncio
async def test_when_the_brain_fails_the_caller_hears_a_line_and_the_call_ends_after_three_in_a_row(rig):
    ended = []

    async def on_ended(reason): ended.append(reason)

    conv = make_conv(FakeBrain([], fail=True), on_ended=on_ended)
    await conv.start()
    client = rig["client"]
    client.push("response_done")
    for n in range(3):
        client.push("user_transcript", text=f"hello {n}")
        await settle()
        client.push("response_done")
        await settle()
    assert client.spoken.count(gc.BRAIN_FALLBACK_LINE) == 2      # said for the first two failures, not the last
    assert ended == ["agent-error"]
    await conv.stop()


@pytest.mark.asyncio
async def test_a_working_reply_resets_the_failure_count(rig):
    brain = FakeBrain([["Fine."]])
    conv = make_conv(brain)
    await conv.start()
    conv._brain_failures = 2
    rig["client"].push("response_done")
    rig["client"].push("user_transcript", text="hi")
    await settle()
    assert conv._brain_failures == 0
    await conv.stop()


@pytest.mark.asyncio
async def test_an_agent_call_stamps_the_answer_when_the_ai_joins():
    """Minutes are charged from answered_at. The custom-voice (agent) engine must write it, as the others do."""
    from app.conversation import CallConversation

    stamped = []

    class Ctx:
        async def set_in_progress(self): stamped.append("in_progress")

    class Agent:
        async def note_call_active(self, source): return True

    conv = object.__new__(CallConversation)
    conv._agent, conv._answered_at, conv.call_context = Agent(), None, Ctx()
    conv._wrapup, conv._wrapup_task, conv._stopped = None, None, False   # what a real conversation starts with
    conv.call_active_source = None
    assert conv.call_active is False
    assert await CallConversation.note_call_active(conv, "relay-signal") is True
    assert stamped == ["in_progress"]
    assert conv._answered_at is not None
    # The end-of-call report picks "completed" only for an active call. This stayed unset, so a custom-voice
    # call that talked was reported as failed ("Couldn't reach Emysa - the call failed to connect").
    assert conv.call_active is True and conv.call_active_source == "relay-signal"


FRAME = types.SimpleNamespace(sample_rate=16000, audio=b"mic")


@pytest.mark.asyncio
async def test_caller_audio_is_held_back_while_the_greeting_plays(rig, monkeypatch):
    """Start-up noise and the greeting's own echo reached Inworld as 'the caller talking', which cancelled the
    greeting before a word was heard and invented a first turn."""
    monkeypatch.setattr(gc, "GREETING_HOLD_TAIL_SECS", 0.0)
    conv = make_conv(FakeBrain([]))
    await conv.start()
    client = rig["client"]
    await conv.push_audio(FRAME)
    assert client.audio == []                       # held: the greeting has not even been generated yet
    client.push("response_done")                    # Inworld finished generating the greeting
    await settle()
    conv.sender.pending = 40                        # ...but it is still playing out of the speaker
    await conv.push_audio(FRAME)
    assert client.audio == []
    conv.sender.pending = 0                         # played out
    await conv.push_audio(FRAME)
    assert client.audio == [b"mic"]                 # the caller can now be heard
    await conv.push_audio(FRAME)
    assert client.audio == [b"mic", b"mic"]         # and it stays open
    await conv.stop()


@pytest.mark.asyncio
async def test_the_hold_can_never_leave_the_call_deaf(rig, monkeypatch):
    monkeypatch.setattr(gc, "GREETING_HOLD_MAX_SECS", 0.0)   # the end-of-greeting signal never arrives
    conv = make_conv(FakeBrain([]))
    await conv.start()
    await conv.push_audio(FRAME)
    assert rig["client"].audio == [b"mic"]
    await conv.stop()


@pytest.mark.asyncio
async def test_a_greeting_cut_off_by_noise_at_the_start_is_not_possible_but_real_barge_in_still_works(rig, monkeypatch):
    monkeypatch.setattr(gc, "GREETING_HOLD_TAIL_SECS", 0.0)
    brain = FakeBrain([["Okay, go ahead with that."]])
    conv = make_conv(brain)
    await conv.start()
    client = rig["client"]
    for _ in range(10):
        await conv.push_audio(FRAME)                # start-up noise is dropped, so Inworld hears nothing
    assert client.audio == [] and client.cancels == 0
    client.push("response_done")
    await settle()
    client.push("user_transcript", text="Call my mum please")
    await settle()
    assert client.spoken[-1] == "Okay, go ahead with that."
    await conv.stop()


@pytest.mark.asyncio
async def test_a_blip_heard_as_a_word_is_not_a_turn(rig):
    brain = FakeBrain([["Never said."]])
    conv = make_conv(brain)
    await conv.start()
    client = rig["client"]
    client.push("response_done")
    for junk in (".", "  ", "-", "?", "a"):
        client.push("user_transcript", text=junk)
        await settle()
    assert brain.histories == [] and client.spoken == ["Hi, Emysa here."]
    client.push("user_transcript", text="Hi")       # a real, short word is still a turn
    await settle()
    assert client.spoken[-1] == "Never said."
    await conv.stop()


@pytest.mark.asyncio
async def test_inworld_is_told_the_call_language(rig):
    conv = make_conv(FakeBrain([]), language="en")
    await conv.start()
    assert rig["client"].session_update["audio"]["input"]["transcription"] == {"model": "inworld/inworld-stt-1", "language": "en"}
    await conv.stop()
