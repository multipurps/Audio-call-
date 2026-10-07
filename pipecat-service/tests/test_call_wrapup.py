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
        ("under 90 seconds", 90),
        ("a two-minute call", 120),
        ("in a couple of minutes", 120),
        ("within half a minute", 30),
        ("within 2 minutes, then call back in 10 minutes", 120),  # tightest wins
        ("no rush, take your time", None),
        ("call me back in 3 hours", None),
        ("within 5 seconds", None),  # below the believable floor: never cut a call off after 5s
        ("", None),
        (None, None),
    ],
)
def test_parse_time_budget(text, expected):
    assert parse_time_budget(text) == expected


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
