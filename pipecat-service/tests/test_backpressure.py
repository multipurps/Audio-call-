"""Backpressure tests: the queue bound, drop-oldest policy, and frame skipping.

The property these tests protect is that memory can never grow without bound
because a peer stopped reading. An unbounded audio queue does not degrade
gracefully -- it takes down the process, and with it every other call.
"""

from __future__ import annotations

import pytest

from app.backpressure import BackpressureSignal, BoundedFrameQueue


class TestBoundedFrameQueue:
    def test_enqueue_and_dequeue_in_order(self):
        queue = BoundedFrameQueue(3)
        for item in ("a", "b", "c"):
            assert queue.put(item) is False
        assert [queue.get(), queue.get(), queue.get()] == ["a", "b", "c"]

    def test_get_on_empty_returns_none(self):
        assert BoundedFrameQueue(2).get() is None

    def test_never_exceeds_capacity(self):
        queue = BoundedFrameQueue(3)
        for i in range(1000):
            queue.put(i)
        assert len(queue) == 3

    def test_drops_oldest_not_newest(self):
        """The newest audio must survive.

        Dropping the newest would freeze the assistant mid-sentence while the
        backlog drains -- worse than a brief glitch.
        """
        queue = BoundedFrameQueue(3)
        for i in range(10):
            queue.put(i)
        assert queue.drain() == [7, 8, 9]

    def test_put_reports_when_something_was_dropped(self):
        queue = BoundedFrameQueue(2)
        assert queue.put("a") is False
        assert queue.put("b") is False
        assert queue.put("c") is True  # 'a' was dropped

    def test_stats_track_drops(self):
        queue = BoundedFrameQueue(2)
        for i in range(5):
            queue.put(i)
        stats = queue.stats()
        assert stats.enqueued == 5
        assert stats.dropped == 3
        assert stats.high_water == 2

    def test_stats_track_dequeues(self):
        queue = BoundedFrameQueue(3)
        queue.put("a")
        queue.put("b")
        queue.get()
        assert queue.stats().dequeued == 1

    def test_drop_ratio(self):
        queue = BoundedFrameQueue(1)
        for i in range(4):
            queue.put(i)
        assert queue.stats().drop_ratio == pytest.approx(0.75)

    def test_drop_ratio_with_no_traffic(self):
        assert BoundedFrameQueue(2).stats().drop_ratio == 0.0

    def test_discard_all_counts_as_dropped(self):
        """Barge-in cancels queued TTS; those frames were not delivered."""
        queue = BoundedFrameQueue(10)
        for i in range(5):
            queue.put(i)
        assert queue.discard_all() == 5
        assert queue.empty
        stats = queue.stats()
        assert stats.dropped == 5
        assert stats.dequeued == 0  # not delivered

    def test_discard_all_on_empty(self):
        assert BoundedFrameQueue(4).discard_all() == 0

    def test_reject_counts_without_queueing(self):
        queue = BoundedFrameQueue(2)
        queue.reject()
        assert queue.empty
        assert queue.stats().rejected == 1

    def test_rejected_affects_drop_ratio_denominator(self):
        queue = BoundedFrameQueue(1)
        queue.put("a")
        queue.put("b")  # one drop, one enqueue
        queue.reject()
        # dropped 1 of (2 enqueued + 1 rejected) = 1/3
        assert queue.stats().drop_ratio == pytest.approx(1 / 3)

    def test_full_and_empty_properties(self):
        queue = BoundedFrameQueue(1)
        assert queue.empty and not queue.full
        queue.put("a")
        assert queue.full and not queue.empty

    def test_drain_returns_everything_and_empties(self):
        queue = BoundedFrameQueue(5)
        queue.extend([1, 2, 3])
        assert queue.drain() == [1, 2, 3]
        assert queue.empty

    def test_extend_counts_drops(self):
        queue = BoundedFrameQueue(2)
        drops = queue.extend(range(5))
        assert drops == 3
        assert queue.drain() == [3, 4]

    def test_capacity_must_be_positive(self):
        with pytest.raises(ValueError, match="capacity must be >= 1"):
            BoundedFrameQueue(0)
        with pytest.raises(ValueError):
            BoundedFrameQueue(-5)

    def test_stats_are_json_safe(self):
        import json

        queue = BoundedFrameQueue(2)
        queue.extend(range(4))
        stats = queue.stats().as_dict()
        assert json.loads(json.dumps(stats)) == stats

    def test_sustained_overload_dequeues_still_work(self):
        """Under continuous overload the queue must still yield frames.

        A drop-oldest queue that got stuck dropping on every put would yield
        nothing at all, which is a silent total failure rather than
        degradation.
        """
        queue = BoundedFrameQueue(2)
        delivered = []
        for i in range(50):
            queue.put(i)
            item = queue.get()
            if item is not None:
                delivered.append(item)
        assert len(delivered) == 50


class TestBackpressureSignal:
    def test_inactive_when_queue_is_shallow(self):
        signal = BackpressureSignal(BoundedFrameQueue(10))
        assert signal.should_send() is True
        assert not signal.skipping

    def test_engages_at_high_water(self):
        queue = BoundedFrameQueue(10)
        for i in range(8):  # 80% > 75% threshold
            queue.put(i)
        signal = BackpressureSignal(queue)
        signal.update()
        assert signal.skipping

    def test_does_not_engage_below_high_water(self):
        queue = BoundedFrameQueue(10)
        for i in range(7):  # 70% < 75%
            queue.put(i)
        signal = BackpressureSignal(queue)
        signal.update()
        assert not signal.skipping

    def test_skips_roughly_half_the_frames(self):
        queue = BoundedFrameQueue(10)
        for i in range(10):
            queue.put(i)
        signal = BackpressureSignal(queue)
        sent = sum(1 for _ in range(100) if signal.should_send())
        assert 45 <= sent <= 55

    def test_hysteresis_prevents_oscillation(self):
        """Between the two thresholds the state must not flip-flop."""
        queue = BoundedFrameQueue(10)
        for i in range(8):
            queue.put(i)
        signal = BackpressureSignal(queue)
        signal.update()
        assert signal.skipping

        # Drop to 50% -- above LOW_WATER (35%), below HIGH_WATER (75%).
        while len(queue) > 5:
            queue.get()
        signal.update()
        assert signal.skipping, "should stay engaged between the thresholds"

        # Now fall below LOW_WATER.
        while len(queue) > 3:
            queue.get()
        signal.update()
        assert not signal.skipping

    def test_engagements_counted_once_per_engagement(self):
        queue = BoundedFrameQueue(10)
        signal = BackpressureSignal(queue)
        for _ in range(3):
            for i in range(10):
                queue.put(i)
            signal.update()
            for _ in range(10):
                signal.should_send()
            queue.discard_all()
            signal.update()
        assert signal.stats["engagements"] == 3

    def test_skipped_counter(self):
        queue = BoundedFrameQueue(10)
        for i in range(10):
            queue.put(i)
        signal = BackpressureSignal(queue)
        for _ in range(10):
            signal.should_send()
        assert signal.stats["skipped"] == 5

    def test_reset_clears_adaptive_state(self):
        queue = BoundedFrameQueue(10)
        for i in range(10):
            queue.put(i)
        signal = BackpressureSignal(queue)
        assert signal.should_send() is False  # skipping engaged
        assert signal.skipping

        # A reset is only meaningful once the condition that caused it is
        # gone -- exactly the barge-in case, where the queue is emptied.
        queue.discard_all()
        signal.reset()
        assert not signal.skipping
        assert signal.should_send() is True

    def test_reset_with_a_still_full_queue_re_engages(self):
        """Resetting does not blind the signal to a queue that is still full."""
        queue = BoundedFrameQueue(10)
        for i in range(10):
            queue.put(i)
        signal = BackpressureSignal(queue)
        signal.reset()
        # should_send() re-evaluates first, sees 100% > 75%, and skips again.
        assert signal.should_send() is False
        assert signal.skipping

    def test_reset_preserves_cumulative_counters(self):
        """Counters are session metrics and must survive a barge-in reset.

        Clearing them would erase the evidence of sustained backpressure at
        the exact moment it became visible.
        """
        queue = BoundedFrameQueue(10)
        for i in range(10):
            queue.put(i)
        signal = BackpressureSignal(queue)
        for _ in range(10):
            signal.should_send()
        skipped_before = signal.stats["skipped"]
        engagements_before = signal.stats["engagements"]

        signal.reset()
        assert signal.stats["skipped"] == skipped_before
        assert signal.stats["engagements"] == engagements_before

    def test_sends_everything_when_never_engaged(self):
        signal = BackpressureSignal(BoundedFrameQueue(10))
        assert all(signal.should_send() for _ in range(50))
