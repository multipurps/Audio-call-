"""Tests for OpenFeelz-inspired emotional state, GPT Luna config, and [[END_CALL]] handling."""

from __future__ import annotations

import dataclasses

from app.config import Settings
from app.emotion import (
    EmotionState,
    appraise_turn,
    decay_emotion_state,
    derive_discrete_emotions,
    extract_and_strip_control_tags,
    format_emotion_state_block,
    should_end_call,
)
from app.pipeline import build_system_prompt


class TestEmotionEngine:
    def test_default_state_and_formatting(self) -> None:
        state = EmotionState()
        primary, secondary, _ = derive_discrete_emotions(state.dimensions)
        assert primary in ("warm", "calm", "curious")
        assert secondary
        block = format_emotion_state_block(state)
        assert "<emotion_state>" in block
        assert state.primary_emotion in block

    def test_distressed_turn_triggers_rumination_and_decays(self) -> None:
        t0 = 1_700_000_000.0
        state = EmotionState(updated_at=t0)
        stressed = appraise_turn(
            state,
            "I am so stressed, scared, and overwhelmed right now after a terrible hospital visit.",
            now_ts=t0,
        )
        assert stressed.primary_emotion == "empathetic"
        assert stressed.dimensions["connection"] > state.dimensions["connection"]
        assert len(stressed.rumination) >= 1

        # Advance rumination across 4 neutral turns -> clears buffer
        cur = stressed
        for idx in range(4):
            cur = appraise_turn(cur, "Okay.", now_ts=t0 + idx + 1)
        assert len(cur.rumination) == 0

        # Exponential decay over 10 hours brings pleasure closer to baseline
        decayed = decay_emotion_state(stressed, now_ts=t0 + 36000.0)
        assert abs(decayed.dimensions["pleasure"] - state.dimensions["pleasure"]) < abs(
            stressed.dimensions["pleasure"] - state.dimensions["pleasure"]
        )

    def test_control_tag_stripping_and_false_positive_hangup_guard(self) -> None:
        clean, end_call = extract_and_strip_control_tags(
            "All set for tomorrow at noon. Goodbye! [[MOOD:warm]] [[END_CALL]]"
        )
        assert end_call is True
        assert clean == "All set for tomorrow at noon. Goodbye!"

        # Guard: caller asked a question -> do not hang up
        should_end, _ = should_end_call(
            "Okay bye! [[END_CALL]]",
            "Wait, what is the confirmation number?",
        )
        assert should_end is False

        # Guard: caller said don't hang up
        should_end_hold, _ = should_end_call(
            "Talk soon, bye [[END_CALL]]",
            "Hold on, don't hang up yet",
        )
        assert should_end_hold is False

        # Genuine goodbye -> hang up allowed
        should_end_ok, stripped = should_end_call(
            "You are all set. Have a great night, bye! [[END_CALL]]",
            "Thanks so much, goodbye!",
        )
        assert should_end_ok is True
        assert "[[END_CALL]]" not in stripped


class TestLunaConfig:
    def test_luna_provider_resolves_gpt_6_luna_and_redacts_key(self) -> None:
        s = Settings(
            bridge_secret="bridge-sec",
            stt_provider="mock",
            llm_provider="luna",
            tts_provider="mock",
            luna_api_key="sk-luna-secret-key-999",
        )
        assert s.resolved_llm_model() == "gpt-6-luna"
        assert s.resolved_llm_api_key() == "sk-luna-secret-key-999"
        assert "sk-luna-secret-key-999" in s.secret_values()

        prompt = build_system_prompt(s, extra_context="User prefers window seats")
        assert "<emotion_state>" in prompt
        assert "[[END_CALL]]" in prompt
        assert "User prefers window seats" in prompt
        # The expressive-personality layer is part of the default prompt.
        assert "Who you are, underneath the technique" in prompt
        # An operator-supplied system prompt owns the persona outright.
        custom = build_system_prompt(
            dataclasses.replace(s, system_prompt="You are a terse PA.")
        )
        assert "You are a terse PA." in custom
        assert "Who you are, underneath the technique" not in custom
