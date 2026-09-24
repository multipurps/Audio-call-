"""Bounded outbound queue with drop-oldest backpressure.

Real-time audio has a hard property that ordinary queues get wrong: once a
frame is late, it is worthless. Buffering it does not preserve the
conversation, it *breaks* it, because the receiver then plays stale audio
while newer audio piles up behind it and latency grows without bound.

So the contract here is: the queue has a fixed capacity, and when it is full
the **oldest** frame is discarded to make room for the newest. Dropping the
newest instead would mean the assistant's audio stops advancing while the
backlog drains, which sounds like the assistant freezing mid-sentence --
strictly worse than a brief glitch.

The alternative failure mode, an unbounded queue, converts a temporary
network stall into a memory leak that eventually kills the Render instance
and every other call on it. That is the bug this class exists to make
impossible.
"""

from __future__ import annotations

import collections
from dataclasses import dataclass
from typing import Iterable


@dataclass(frozen=True, slots=True)
class QueueStats:
    """Counters for one bounded queue."""

    enqueued: int = 0
    dequeued: int = 0
    dropped: int = 0
    high_water: int = 0
    rejected: int = 0

    @property
    def drop_ratio(self) -> float:
        total = self.enqueued + self.rejected
        return (self.dropped / total) if total else 0.0

    def as_dict(self) -> dict[str, object]:
        return {
            "enqueued": self.enqueued,
            "dequeued": self.dequeued,
            "dropped": self.dropped,
            "highWater": self.high_water,
            "rejected": self.rejected,
            "dropRatio": round(self.drop_ratio, 4),
        }


class BoundedFrameQueue:
    """FIFO queue that drops the oldest item when full."""

    def __init__(self, capacity: int) -> None:
        if capacity < 1:
            raise ValueError(f"capacity must be >= 1, got {capacity}")
        self._capacity = capacity
        self._items: collections.deque[object] = collections.deque()
        self._enqueued = 0
        self._dequeued = 0
        self._dropped = 0
        self._rejected = 0
        self._high_water = 0

    @property
    def capacity(self) -> int:
        return self._capacity

    def __len__(self) -> int:
        return len(self._items)

    @property
    def full(self) -> bool:
        return len(self._items) >= self._capacity

    @property
    def empty(self) -> bool:
        return not self._items

    def put(self, item: object) -> bool:
        """Enqueue, dropping the oldest item if full.

        Returns True if an older item was dropped to make room.
        """
        dropped = False
        while len(self._items) >= self._capacity:
            self._items.popleft()
            self._dropped += 1
            dropped = True
        self._items.append(item)
        self._enqueued += 1
        self._high_water = max(self._high_water, len(self._items))
        return dropped

    def get(self) -> object | None:
        """Dequeue the oldest item, or None when empty."""
        if not self._items:
            return None
        self._dequeued += 1
        return self._items.popleft()

    def drain(self) -> list[object]:
        """Remove and return everything currently queued."""
        items = list(self._items)
        self._dequeued += len(items)
        self._items.clear()
        return items

    def discard_all(self) -> int:
        """Drop everything queued (barge-in / cancellation). Returns the count.

        Counted as `dropped`, not `dequeued`: these frames were abandoned
        rather than delivered, and folding them into `dequeued` would hide
        real TTS cancellations from the metrics.
        """
        count = len(self._items)
        self._dropped += count
        self._items.clear()
        return count

    def reject(self) -> None:
        """Record an item that was never queued (e.g. no session)."""
        self._rejected += 1

    def stats(self) -> QueueStats:
        return QueueStats(
            enqueued=self._enqueued,
            dequeued=self._dequeued,
            dropped=self._dropped,
            high_water=self._high_water,
            rejected=self._rejected,
        )

    def extend(self, items: Iterable[object]) -> int:
        """Put many items; returns how many caused a drop."""
        return sum(1 for item in items if self.put(item))


class BackpressureSignal:
    """Adaptive frame-skipping when the peer cannot keep up.

    A second, softer lever than the queue bound. When the outbound queue is
    persistently near capacity, dropping *every* other frame reduces the data
    rate by half instead of dropping whatever happens to be oldest -- which
    keeps a recognisable audio cadence rather than producing gaps in
    unpredictable places.

    It engages and disengages with hysteresis so it cannot oscillate on every
    frame, which would itself cause the artefacts it is meant to prevent.
    """

    #: Engage skipping once the queue is at or above this fraction of capacity.
    HIGH_WATER_FRACTION = 0.75
    #: Disengage only once it falls back below this lower fraction.
    LOW_WATER_FRACTION = 0.35

    def __init__(self, queue: BoundedFrameQueue) -> None:
        self._queue = queue
        self._skipping = False
        self._skipped = 0
        self._engagements = 0
        self._parity = 0

    @property
    def skipping(self) -> bool:
        return self._skipping

    @property
    def stats(self) -> dict[str, object]:
        return {
            "skipping": self._skipping,
            "skipped": self._skipped,
            "engagements": self._engagements,
        }

    def update(self) -> None:
        """Re-evaluate the skipping state against the current queue depth."""
        depth = len(self._queue) / self._queue.capacity
        if not self._skipping and depth >= self.HIGH_WATER_FRACTION:
            self._skipping = True
            self._engagements += 1
        elif self._skipping and depth <= self.LOW_WATER_FRACTION:
            self._skipping = False

    def should_send(self) -> bool:
        """Whether the next frame should be sent or skipped.

        Must be called exactly once per candidate frame, in order -- the
        alternating parity is what halves the rate.
        """
        self.update()
        if not self._skipping:
            return True
        self._parity ^= 1
        if self._parity:
            self._skipped += 1
            return False
        return True

    def reset(self) -> None:
        """Clear the adaptive *state* only.

        Called when the queue is deliberately emptied (a barge-in), so the
        skip pattern starts fresh rather than continuing mid-alternation.

        The counters are deliberately **not** cleared: they are
        session-cumulative metrics, and a call that spent most of its life
        skipping frames is exactly what an operator needs to see afterwards.
        Resetting them here would erase the evidence of the problem at the
        moment the problem became visible.
        """
        self._skipping = False
        self._parity = 0
