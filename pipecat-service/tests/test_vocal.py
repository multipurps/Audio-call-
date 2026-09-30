"""Vocalisation pipeline tests: real Fish Audio tags in, clean speech/transcript out.

Covers the contract the app relies on:
  * markers are translated to the ACTIVE Fish model's syntax (s2 brackets /
    s1 fixed paren set — unknown markers dropped, never spoken literally);
  * the persisted transcript carries quiet annotations, never control tags;
  * streaming chunks never leak half a marker into speech;
  * the policy keeps vocalisations occasional and drops laughter in serious
    emotional contexts — with no extra LLM calls anywhere.
"""

from app import vocal
from app.vocal import (
    VocalisationPolicy,
    marker_annotations,
    split_complete,
    to_transcript_text,
    to_tts_text,
)


class TestSplitComplete:
    def test_plain_text_passes_whole(self):
        assert split_complete("Hello there.") == ("Hello there.", "")

    def test_trailing_partial_marker_is_held_back(self):
        complete, hold = split_complete("Sure [laugh")
        assert complete == "Sure "
        assert hold == "[laugh"

    def test_complete_marker_is_not_held(self):
        assert split_complete("Sure [laughing] yes") == ("Sure [laughing] yes", "")

    def test_control_tag_fragment_is_held_back(self):
        complete, hold = split_complete("Bye! [[END")
        assert complete == "Bye! "
        assert hold == "[[END"

    def test_marker_straddling_chunks_reassembles(self):
        first, hold = split_complete("Well [laugh")
        second, hold2 = split_complete(hold + "ing] that's funny.")
        assert first + second == "Well [laughing] that's funny."
        assert hold2 == ""


class TestTtsTranslation:
    def test_s2_bracket_syntax(self):
        assert to_tts_text("Oh [laughing] that's good.", syntax="s2") == "Oh [laughing] that's good."
        assert to_tts_text("[sighing] What a day.", syntax="s2") == "[sighing] What a day."

    def test_s1_paren_syntax_with_fixed_tag_set(self):
        assert to_tts_text("Oh [laughing] nice.", syntax="s1") == "Oh (laughing) nice."
        assert to_tts_text("[clearing throat] Listen.", syntax="s1") == "(clear throat) Listen."

    def test_s1_drops_markers_with_no_verified_tag(self):
        # Humming has no verified S1 tag — dropped, the spoken "Hmm." carries it.
        out = to_tts_text("[humming] Interesting.", syntax="s1")
        assert out == "Interesting."
        assert "[" not in out and "(" not in out

    def test_unknown_bracket_tags_are_stripped_never_spoken(self):
        out = to_tts_text("[singing] Hello [dance] there.", syntax="s2")
        assert out == "Hello there."
        assert "singing" not in out and "dance" not in out

    def test_control_tags_removed(self):
        out = to_tts_text("Bye now! [[END_CALL]]", syntax="s2")
        assert out == "Bye now!"
        assert "END_CALL" not in out

    def test_whitespace_collapse_keeps_sentence_spacing(self):
        out = to_tts_text("Well,  [soft]  yes.", syntax="s2")
        assert out == "Well, [soft] yes."


class TestTranscriptText:
    def test_markers_become_quiet_annotations(self):
        assert to_transcript_text("Oh [laughing] that's good.") == "Oh (laughs) that's good."
        assert to_transcript_text("[sighing] What a day.") == "(sighs) What a day."

    def test_delivery_only_markers_leave_no_transcript_trace(self):
        assert to_transcript_text("[soft] Please, sit.") == "Please, sit."
        assert to_transcript_text("[emphasis] Never.") == "Never."

    def test_control_tags_never_reach_the_transcript(self):
        assert to_transcript_text("Bye! [[END_CALL]]") == "Bye!"
        assert to_transcript_text("[[MOOD:happy]] Hi") == "Hi"

    def test_annotations_available_separately(self):
        assert marker_annotations("Oh [laughing]. [sighing] Fine.") == ["(laughs)", "(sighs)"]

    def test_paren_form_converts_without_double_stripping(self):
        # The annotation "(laughs)" must survive a second pass unchanged —
        # regression: a naive matcher re-matched its own output and ate it.
        once = to_transcript_text("Ha [laughing] ha.")
        assert once == "Ha (laughs) ha."
        assert to_transcript_text(once) == once

    def test_unknown_fragments_are_stripped_not_leaked(self):
        assert to_transcript_text("[zzz weird] Hello") == "Hello"


class TestVocalisationPolicy:
    def test_rate_limit_keeps_vocalisations_occasional(self):
        policy = VocalisationPolicy(min_gap_secs=25.0)
        t0 = 1_000.0
        tts, _ = policy.process("[laughing] Sure thing.", now=t0)
        assert "[laughing]" in tts
        tts2, _ = policy.process("[chuckling] Again!", now=t0 + 5)
        # Second vocalisation inside the gap window is dropped.
        assert "chuck" not in tts2
        tts3, _ = policy.process("[chuckling] Much later.", now=t0 + 30)
        assert "[chuckling]" in tts3

    def test_serious_emotions_drop_laughter_from_both_outputs(self):
        policy = VocalisationPolicy()
        for emotion in ("concerned", "sad", "empathetic", "focused"):
            tts, transcript = policy.process(
                "[laughing] I'm so sorry, that sounds hard.", emotion=emotion
            )
            assert "laugh" not in tts and "laughs" not in transcript, emotion
        # Low pleasure suppresses laughter too.
        tts, transcript = policy.process("[laughing] Right.", pleasure=-0.5)
        assert "laugh" not in tts and "laughs" not in transcript

    def test_serious_context_keeps_sighs_and_words(self):
        policy = VocalisationPolicy()
        tts, transcript = policy.process(
            "[sighing] I understand. That's tough.", emotion="concerned"
        )
        assert "[sighing]" in tts
        assert "(sighs)" in transcript
        assert "I understand." in tts and "I understand." in transcript

    def test_delivery_markers_always_pass(self):
        policy = VocalisationPolicy()
        for _ in range(10):
            tts, _ = policy.process("[soft] Okay. [emphasis] Now.", emotion="sad")
            assert "[soft]" in tts and "[emphasis]" in tts

    def test_policy_removes_markers_from_transcript_too(self):
        policy = VocalisationPolicy()
        _, transcript = policy.process("[laughing] Yes, let's do it.", emotion="sad")
        assert transcript == "Yes, let's do it."

    def test_window_cap_bounds_total_vocalisations(self):
        policy = VocalisationPolicy(min_gap_secs=0.0, max_per_window=3, window_secs=3600.0)
        kept = 0
        for i in range(10):
            tts, _ = policy.process("[sighing] Hmm.", now=5_000.0 + i)
            kept += "[sighing]" in tts
        assert kept == 3
