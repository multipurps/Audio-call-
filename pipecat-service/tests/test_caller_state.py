"""Caller interaction-state layer: detector, debounce, trajectory, behaviour notes.

Pure Python: none of these need Pipecat or a network.
"""

from __future__ import annotations

import math
import struct

from app.caller_state import (
    BEHAVIOUR,
    NEGATIVE_STATES,
    NOTE_PREFIX,
    STATES,
    CallerStateDetector,
    CallerStateTracker,
    behaviour_note,
)


class Clock:
    def __init__(self) -> None:
        self.t = 1000.0

    def __call__(self) -> float:
        return self.t

    def advance(self, secs: float) -> None:
        self.t += secs


def make(clock: Clock | None = None):
    clock = clock or Clock()
    det = CallerStateDetector(clock=clock)
    trk = CallerStateTracker(clock=clock, wall=lambda: "2026-10-06T00:00:00.000Z")
    return clock, det, trk


def say(clock, det, trk, text, *, gap=6.0):
    """One caller utterance: returns the Transition (or None)."""
    clock.advance(gap)
    return trk.update(det.end_utterance(text))


def tone(amplitude: float, secs: float = 0.5, rate: int = 16000, hz: float = 220.0) -> bytes:
    n = int(rate * secs)
    return struct.pack(f"<{n}h", *[int(amplitude * 32767 * math.sin(2 * math.pi * hz * i / rate)) for i in range(n)])


# -- detector ---------------------------------------------------------------


def test_scores_are_a_distribution_over_the_seven_states():
    _, det, _ = make()
    obs = det.end_utterance("I already told you, it's not working")
    assert set(obs.scores) == set(STATES)
    assert abs(sum(obs.scores.values()) - 1.0) < 1e-6
    assert obs.top == "frustrated"
    assert 0.0 < obs.confidence <= 1.0


def test_plain_speech_is_weak_calm_not_confident_calm():
    _, det, _ = make()
    obs = det.end_utterance("I'd like to book a table for Friday")
    assert obs.top == "calm"
    assert obs.confidence <= 0.6


def test_each_state_has_a_lexical_trigger():
    cases = {
        "confused": "I don't understand what you mean",
        "impatient": "just tell me, I don't have time",
        "upset": "this is ridiculous, I'm so upset",
        "frustrated": "how many times do I have to say it",
    }
    for state, text in cases.items():
        _, det, _ = make()
        assert det.end_utterance(text).top == state, text


def test_loudness_is_relative_to_the_callers_own_baseline():
    _, det, _ = make()
    # Two ordinary utterances set the baseline.
    for _ in range(2):
        det.feed_audio(tone(0.10), 16000)
        det.end_utterance("okay")
    det.feed_audio(tone(0.45), 16000)
    loud = det.end_utterance("okay")
    assert loud.features["loudness_ratio"] >= 1.6
    assert "louder" in loud.cues
    # A caller who is simply loud all the time never trips the cue.
    _, det2, _ = make()
    for _ in range(4):
        det2.feed_audio(tone(0.45), 16000)
        obs = det2.end_utterance("okay")
    assert "louder" not in obs.cues


def test_silence_and_noise_floor_are_ignored():
    _, det, _ = make()
    det.feed_audio(tone(0.002), 16000)  # below the audible floor
    obs = det.end_utterance("")
    assert obs.features["rms"] == 0.0


def test_talking_over_the_assistant_counts_toward_impatient():
    _, det, _ = make()
    det.feed_audio(tone(0.2, secs=0.6), 16000, ai_speaking=True)
    obs = det.end_utterance("yeah yeah")
    assert "talked-over" in obs.cues
    assert obs.scores["impatient"] > obs.scores["frustrated"]


def test_repeated_short_fillers_read_as_disengaged():
    clock, det, _ = make()
    for t in ("mm", "ok", "yeah"):
        clock.advance(5)
        obs = det.end_utterance(t)
    assert obs.top == "disengaged"


# -- tracker: debounce -------------------------------------------------------


def test_one_strange_utterance_does_not_change_state():
    clock, det, trk = make()
    for _ in range(3):
        say(clock, det, trk, "I'd like to book a table")
    assert say(clock, det, trk, "this is ridiculous") is None
    assert trk.current_state == "calm"
    # ...and the calm utterance that follows resets any pending change.
    assert say(clock, det, trk, "so Friday at seven") is None
    assert trk.current_state == "calm"


def test_sustained_evidence_changes_state_once():
    clock, det, trk = make()
    say(clock, det, trk, "hello")
    changes = [say(clock, det, trk, "I already told you, it's not working") for _ in range(4)]
    committed = [c for c in changes if c]
    assert len(committed) == 1
    assert committed[0].previous_state == "calm"
    assert committed[0].state == "frustrated"
    assert trk.previous_state == "calm"


def test_minimum_dwell_blocks_instant_flips():
    clock, det, trk = make()
    out = [say(clock, det, trk, "I already told you, it's not working", gap=0.5) for _ in range(3)]
    assert not any(out)  # evidence is there, but only ~1.5s have passed
    assert say(clock, det, trk, "I already told you, it's not working", gap=5) is not None


def test_reassured_requires_a_negative_state_first():
    clock, det, trk = make()
    for _ in range(4):
        say(clock, det, trk, "great, thank you so much")
    assert trk.current_state == "calm"  # nothing to recover from


# -- tracker: trajectory + recovery -----------------------------------------


def run_arc(clock, det, trk):
    for _ in range(2):
        say(clock, det, trk, "hi, I need help with my order")
    for _ in range(4):
        say(clock, det, trk, "I already told you, it's not working")
    for _ in range(5):
        say(clock, det, trk, "okay thanks, that helps, that makes sense")


def test_calm_to_frustrated_to_reassured_trajectory_and_recovery():
    clock, det, trk = make()
    run_arc(clock, det, trk)
    s = trk.summary()
    assert s["starting_state"] == "calm"
    assert s["lowest_state"] == "frustrated"
    assert s["final_state"] in ("reassured", "calm")
    assert s["recovery"] == "successful"
    assert s["recovery_detected"] is True
    states = [t["state"] for t in s["trajectory"]]
    assert states[0] == "calm" and "frustrated" in states
    assert states.index("frustrated") < len(states) - 1


def test_reassured_settles_back_to_calm_gradually():
    clock, det, trk = make()
    run_arc(clock, det, trk)
    for _ in range(6):
        say(clock, det, trk, "so what time does it arrive")
    assert trk.current_state == "calm"
    assert trk.recovery_detected is True  # the recovery is not forgotten


def test_unresolved_when_the_call_ends_negative():
    clock, det, trk = make()
    for _ in range(5):
        say(clock, det, trk, "this is ridiculous, I'm so upset")
    s = trk.summary()
    assert s["lowest_state"] == "upset"
    assert s["final_state"] == "upset"
    assert s["recovery"] == "unresolved"


def test_never_negative_call_needs_no_recovery():
    clock, det, trk = make()
    for _ in range(4):
        say(clock, det, trk, "what are your opening hours")
    s = trk.summary()
    assert s["recovery"] == "not_needed"
    assert s["lowest_state"] == "calm"
    assert s["transitions"] == 0


def test_relapse_after_recovery_clears_the_flag():
    clock, det, trk = make()
    run_arc(clock, det, trk)
    assert trk.recovery_detected
    for _ in range(6):
        say(clock, det, trk, "this is ridiculous, I'm so upset")
    assert trk.current_state in NEGATIVE_STATES
    assert trk.recovery_detected is False
    assert trk.recoveries >= 1


def test_state_model_exposes_the_required_fields():
    clock, det, trk = make()
    run_arc(clock, det, trk)
    for name in ("current_state", "confidence", "previous_state", "state_started_at",
                 "lowest_state", "recovery_detected", "trajectory"):
        assert hasattr(trk, name), name
    assert trk.current_state in STATES
    assert 0.0 <= trk.confidence <= 1.0


def test_trajectory_is_capped_and_keeps_the_opening():
    clock, det, trk = make()
    for i in range(80):
        trk._commit("frustrated" if i % 2 == 0 else "calm", 0.7, "test")
    assert len(trk.trajectory) <= 60
    assert trk.trajectory[0]["trigger"] == "start"


# -- behaviour policy --------------------------------------------------------


def test_every_state_has_guidance_and_the_note_forbids_disclosure():
    assert set(BEHAVIOUR) == set(STATES)
    for state in STATES:
        note = behaviour_note(state)
        assert note.startswith(NOTE_PREFIX)
        assert BEHAVIOUR[state] in note
    assert "never" in NOTE_PREFIX.lower() and "mention" in NOTE_PREFIX.lower()


def test_guidance_text_matches_the_spec():
    assert "Be concise, calm and specific" in BEHAVIOUR["frustrated"]
    assert "one precise question" in BEHAVIOUR["confused"]
    assert "Get to the point" in BEHAVIOUR["impatient"]
    assert "Do not mirror hostility" in BEHAVIOUR["upset"]
    assert "shorter responses" in BEHAVIOUR["disengaged"]
    assert "Gradually return" in BEHAVIOUR["reassured"]


# -- monitor (glue) ----------------------------------------------------------

import asyncio

from app.caller_state import CallerStateMonitor
from app.config import load_settings


def test_monitor_sends_a_private_note_only_on_a_committed_change():
    async def scenario():
        clock = Clock()
        sent: list[str] = []
        logs: list[tuple] = []

        async def send(note: str) -> None:
            sent.append(note)

        mon = CallerStateMonitor(
            send_note=send,
            log=lambda event, level="INFO", **kw: logs.append((event, level, kw)),
            detector=CallerStateDetector(clock=clock),
            tracker=CallerStateTracker(clock=clock, wall=lambda: "t"),
        )
        for _ in range(2):
            clock.advance(6)
            mon.on_caller_transcript("hi, I need help with my order")
        clock.advance(6)
        mon.on_caller_transcript("it's not working")  # one odd turn: no note
        await asyncio.sleep(0)
        assert sent == []
        for _ in range(4):
            clock.advance(6)
            mon.on_caller_transcript("I already told you, it's not working")
        await asyncio.sleep(0.01)
        return mon, sent, logs

    mon, sent, logs = asyncio.run(scenario())
    assert len(sent) == 1
    assert "FRUSTRATED" in sent[0] and "Be concise" in sent[0]
    assert mon.state == "frustrated"
    events = [e for e, _, _ in logs]
    assert "caller_state_change" in events and "caller_state_observation" in events
    assert mon.summary()["notes_sent"] == 1


def test_monitor_never_raises_even_if_delivery_fails():
    async def scenario():
        clock = Clock()

        async def boom(note: str) -> None:
            raise RuntimeError("session gone")

        mon = CallerStateMonitor(
            send_note=boom,
            detector=CallerStateDetector(clock=clock),
            tracker=CallerStateTracker(clock=clock, wall=lambda: "t"),
        )
        for _ in range(6):
            clock.advance(6)
            mon.on_caller_transcript("this is ridiculous, I'm so upset")
        await asyncio.sleep(0.01)
        return mon

    mon = asyncio.run(scenario())
    assert mon.state == "upset"
    assert mon.note_failures >= 1


def test_monitor_without_a_running_loop_or_sender_is_safe():
    mon = CallerStateMonitor()
    mon.on_audio(tone(0.2), 16000)
    for _ in range(6):
        mon.on_caller_transcript("this is ridiculous, I'm so upset")
    assert mon.summary()["observations"] == 6


def test_feature_flag_defaults_on_and_can_be_disabled():
    assert load_settings({"ASSISTANT_MOCK_MODE": "true"}).caller_state_enabled is True
    assert load_settings({"ASSISTANT_MOCK_MODE": "true", "CALLER_STATE_ENABLED": "false"}).caller_state_enabled is False
