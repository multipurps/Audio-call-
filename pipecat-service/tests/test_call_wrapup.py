"""Pure decision logic for ending a call: time budgets, goodbyes, the staged wrap-up."""

import pytest

from app.call_wrapup import (
    FORCE_GRACE_SECS,
    FarewellTracker,
    WrapUpPlan,
    is_farewell,
    parse_time_budget,
    wrapup_cue,
)


@pytest.mark.parametrize(
    "text,expected",
    [
        ("brief him and round it up within a minute", 60),
        ("keep it to 5 minutes", 300),
        ("make it quick, under 90 seconds", 90),
        ("a two-minute call", 120),
        ("wrap it up in a couple of minutes", 120),
        ("round it up within half a minute", 30),
        ("round up within 2 minutes, then call back in 10 minutes", 120),  # tightest wins
        ("no rush, take your time", None),
        ("call me back in 3 hours", None),
        ("round it up within 5 seconds", None),  # below the believable floor: never cut a call off after 5s
        ("", None),
        (None, None),
    ],
)
def test_parse_time_budget(text, expected):
    assert parse_time_budget(text) == expected


@pytest.mark.parametrize(
    "text",
    [
        "Tell him I'll be there in 10 minutes",
        "call Ayo and say I'm no more than 10 minutes late",
        "ask if the delivery can arrive within 2 days",
        "under 90 seconds",  # a bare duration says nothing about the call's pace
        "remind her the meeting starts in 5 minutes",
    ],
)
def test_a_duration_that_is_not_about_the_call_never_becomes_a_limit(text):
    # A wrong limit would cut a real call off, which is far worse than having no limit.
    assert parse_time_budget(text) is None


@pytest.mark.parametrize(
    "text",
    ["okay thanks, bye", "Take care, goodbye!", "talk soon", "Great, I'll send that over this afternoon. Take care, bye!"],
)
def test_real_goodbyes(text):
    assert is_farewell(text)


@pytest.mark.parametrize(
    "text",
    [
        "I'll call you later",
        "can you call me later?",
        "I can see you",
        "She never said goodbye to me and it still bothers me a lot honestly",
        "",
        None,
    ],
)
def test_sentences_that_only_mention_goodbyes_are_not_goodbyes(text):
    assert not is_farewell(text)


class TestFarewellTracker:
    def test_exchanged_goodbyes_hang_up_after_silence(self):
        t = FarewellTracker(settle_secs=3.5)
        t.on_turn("contact", "okay thanks, bye", 100.0)
        t.on_turn("ai", "Take care, goodbye!", 102.0)
        assert t.should_hang_up(103.0) == (False, "")  # not settled yet
        assert t.should_hang_up(105.6) == (True, "goodbyes-exchanged")

    def test_new_speech_after_a_goodbye_cancels_the_hangup(self):
        t = FarewellTracker()
        t.on_turn("contact", "bye", 100.0)
        t.on_turn("ai", "Goodbye!", 101.0)
        t.on_turn("contact", "oh wait, one more thing about the invoice", 102.0)
        assert t.should_hang_up(200.0) == (False, "")

    def test_assistant_goodbye_alone_hangs_up_only_after_a_long_silence(self):
        t = FarewellTracker(lone_ai_secs=9.0)
        t.on_turn("ai", "Alright, take care, bye!", 100.0)
        assert t.should_hang_up(105.0) == (False, "")
        assert t.should_hang_up(109.5) == (True, "assistant-said-goodbye")

    def test_nothing_said_never_hangs_up(self):
        assert FarewellTracker().should_hang_up(10_000.0) == (False, "")

    def test_an_ordinary_conversation_never_hangs_up(self):
        t = FarewellTracker()
        t.on_turn("ai", "Hi, how are you?", 1.0)
        t.on_turn("contact", "I'm good, I'll call you later about it", 4.0)
        assert t.should_hang_up(500.0) == (False, "")


class TestWrapUpPlan:
    def test_no_budget_no_stages(self):
        assert WrapUpPlan(None).next_stage(10_000) is None

    def test_stages_come_in_order_and_once_each(self):
        plan = WrapUpPlan(60)
        assert plan.next_stage(10) is None
        assert plan.next_stage(41) == "soft"  # 20s before the end
        assert plan.next_stage(45) is None  # not repeated
        assert plan.next_stage(60) == "hard"
        assert plan.next_stage(61) is None
        assert plan.next_stage(60 + FORCE_GRACE_SECS) == "force"
        assert plan.next_stage(500) is None

    def test_a_late_check_skips_straight_to_the_right_stage(self):
        # The supervisor ticks once a second, but a stall must not replay old cues.
        assert WrapUpPlan(60).next_stage(75) == "force"

    def test_tiny_budget_starts_wrapping_up_early_enough(self):
        plan = WrapUpPlan(20)
        assert plan.soft_at == pytest.approx(12.0)  # 60% of the budget, not at second zero
        assert plan.next_stage(11) is None
        assert plan.next_stage(12) == "soft"


def test_cues_name_the_allowed_time_and_ask_for_the_end_call_action_when_time_is_up():
    assert "1 minute" in wrapup_cue("soft", 60)
    assert "90 seconds" in wrapup_cue("soft", 90)
    hard = wrapup_cue("hard", 120)
    assert "2 minutes" in hard and "end_call" in hard


# --------------------------------------------------------------------------- supervisor

import asyncio  # noqa: E402

from app.call_wrapup import WrapUpSupervisor  # noqa: E402


class Harness:
    def __init__(self, budget=None, farewell=True):
        self.t = 0.0
        self.talk = 0
        self.cues: list[str] = []
        self.hangups: list[tuple[str, bool]] = []
        self.logs: list[str] = []
        self.stopped = False

        async def inject(text):
            self.cues.append(text)

        async def hang_up(reason, quick):
            self.hangups.append((reason, quick))

        self.sup = WrapUpSupervisor(
            budget_secs=budget,
            farewell_enabled=farewell,
            talk_seconds=lambda: self.talk,
            inject_cue=inject,
            hang_up=hang_up,
            is_stopped=lambda: self.stopped,
            log=lambda event, **kw: self.logs.append(event),
            now=lambda: self.t,
            tick_secs=0.001,
        )


async def test_budget_cues_then_forces_the_hangup():
    h = Harness(budget=60)
    h.talk = 30
    await h.sup.check()
    assert h.cues == [] and h.hangups == []
    h.talk = 41
    await h.sup.check()
    assert len(h.cues) == 1 and "almost up" in h.cues[0]
    h.talk = 60
    await h.sup.check()
    assert len(h.cues) == 2 and "Time is up" in h.cues[1] and "end_call" in h.cues[1]
    assert h.hangups == []
    h.talk = 75
    await h.sup.check()
    assert h.hangups == [("budget-force", False)]  # the model had its chance; the goodbye is allowed to finish


async def test_goodbyes_hang_up_quickly_and_only_once():
    h = Harness()
    h.sup.on_turn("contact", "okay thanks, bye")
    h.t = 1.0
    h.sup.on_turn("ai", "Take care, goodbye!")
    h.t = 2.0
    await h.sup.check()
    assert h.hangups == []
    h.t = 5.0
    await h.sup.check()
    await h.sup.check()
    assert h.hangups == [("goodbyes-exchanged", True)]
    assert "[CALL WRAPUP] hanging up" in h.logs


async def test_new_speech_after_goodbye_keeps_the_call_open():
    h = Harness()
    h.sup.on_turn("contact", "bye")
    h.sup.on_turn("ai", "Goodbye!")
    h.t = 2.0
    h.sup.on_turn("contact", "wait, one more thing about the invoice")
    h.t = 60.0
    await h.sup.check()
    assert h.hangups == []


async def test_farewell_hangup_can_be_switched_off():
    h = Harness(farewell=False)
    h.sup.on_turn("contact", "bye")
    h.sup.on_turn("ai", "Goodbye!")
    h.t = 60.0
    await h.sup.check()
    assert h.hangups == []


async def test_a_stopped_call_is_left_alone():
    h = Harness(budget=60)
    h.stopped = True
    h.talk = 500
    await h.sup.check()
    assert h.cues == [] and h.hangups == []


async def test_a_supervisor_bug_never_takes_the_call_down():
    h = Harness(budget=60)
    h.talk = 41

    async def boom(_text):
        raise RuntimeError("cue failed")

    h.sup._inject_cue = boom
    task = asyncio.create_task(h.sup.run())
    await asyncio.sleep(0.05)
    h.stopped = True
    await asyncio.wait_for(task, 1)
    assert "[CALL WRAPUP] check failed" in h.logs
