"""Correlated stage timing for one call's audio path.

Each mark logs the stage name, milliseconds since the first mark seen for this
call (monotonic clock, so durations are immune to wall-clock jumps), and the
wall-clock epoch milliseconds, which lets the Render logs be lined up with the
Vercel logs and the WaCalls relay logs for the same call.

Logs contain stage names and numbers only: never audio, transcript text or
credentials.
"""

from __future__ import annotations

import logging
import threading
import time

logger = logging.getLogger("emysa.latency")

_lock = threading.Lock()
_started: dict[str, float] = {}
_seen_once: set[tuple[str, str]] = set()
#: Bound the bookkeeping so a long-running service cannot grow without limit.
_MAX_TRACKED = 2000


def _key(session_id: str | None) -> str:
    return session_id or "unknown"


def mark(session_id: str | None, stage: str, **fields: object) -> None:
    """Record that `stage` happened now for this call."""
    sid = _key(session_id)
    now = time.monotonic()
    with _lock:
        t0 = _started.get(sid)
        if t0 is None:
            if len(_started) >= _MAX_TRACKED:
                _started.clear()
                _seen_once.clear()
            t0 = now
            _started[sid] = now
    detail = " ".join(f"{k}={v}" for k, v in fields.items())
    logger.info(
        "[call %s] latency stage=%s t_ms=%d wall_ms=%d %s",
        sid,
        stage,
        round((now - t0) * 1000),
        round(time.time() * 1000),
        detail,
    )


def mark_once(session_id: str | None, stage: str, **fields: object) -> None:
    """Like `mark`, but only the first occurrence per call is logged."""
    key = (_key(session_id), stage)
    with _lock:
        if key in _seen_once:
            return
        if len(_seen_once) >= _MAX_TRACKED * 8:
            _seen_once.clear()
        _seen_once.add(key)
    mark(session_id, stage, **fields)


def forget(session_id: str | None) -> None:
    """Drop bookkeeping for a finished call."""
    sid = _key(session_id)
    with _lock:
        _started.pop(sid, None)
        for key in [k for k in _seen_once if k[0] == sid]:
            _seen_once.discard(key)
