"""Pre-call context resolution and live persistence against the app database.

The ACAF handshake only carries ids (`sessionId` = ``call-{platform_call_id}``,
``platform``, ``userId``). Everything the model needs for a *person-centred*
call — who is being called, the user's objective, what was discussed last
time — already lives in the app's ``calls`` row (sql/017) and the ``memories``
table. This module is the single place that talks to Supabase REST with the
service-role key:

  * :func:`resolve_call_context` — called once at call start. The row is
    written by Vercel just before the carrier dials, so the lookup retries
    against a bounded deadline (``ASSISTANT_CONTEXT_TIMEOUT_SECS``, default
    20s) instead of failing the call over a few hundred milliseconds of race.
    Returns ``None`` (call proceeds with the default prompt, no persistence)
    in mock mode or without Supabase credentials.
  * :class:`CallContext` — the resolved row plus everything written back:
    status transitions (queued/ringing -> in_progress -> terminal) and the
    end-of-call report that triggers the app's shared summary pipeline.
  * :class:`TranscriptLog` — live transcript for one call. Entries are
    appended per turn (speaker + text + timestamp) and flushed as a debounced
    full-array ``PATCH``: idempotent, so a retried write can never duplicate
    a turn, and the app's realtime channel picks up every flush for the
    live-call screen.

Secrets: only ever sent as headers to Supabase/the app API. Never logged;
log lines carry ids, counts and statuses only.
"""

from __future__ import annotations

import asyncio
import contextlib
import re
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

import httpx
from loguru import logger

from app.config import Settings

#: Statuses after which a call is finished. Mirrors the app's vocabulary
#: (api/social-calling.js + lib/callSession.js).
TERMINAL_STATUSES = ("completed", "no_answer", "failed", "busy", "canceled")

#: How long to wait after the pipeline ends before checking whether the
#: carrier already reported the outcome. WaCalls/mp-relay post their own
#: reportRelayOutcome within about a second of hangup; waiting briefly means
#: we normally skip ours entirely and the carrier's (more accurate) status
#: wins. We only report when nothing else did, so the row cannot sit on
#: "ringing" forever.
END_REPORT_DELAY_SECS = 2.5

#: Transcript entries beyond this are dropped (oldest first out of the
#: prompt-relevant window): a 30-minute call with a chatty caller must not
#: grow an unbounded jsonb row on every flush.
MAX_TRANSCRIPT_ENTRIES = 400
MAX_ENTRY_CHARS = 2000

#: Cheap defence against secrets that were stored as "memories" by mistake —
#: the JS side sanitises on write, this catches older rows on read.
_SECRET_PATTERNS = re.compile(
    r"(sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|"
    r"(api[_-]?key|secret|password|token)\s*[:=]\s*\S+)",
    re.IGNORECASE,
)


def _log(level: str, session_id: str, event: str, **fields: Any) -> None:
    """Session-scoped log line; ids/counts only, never content or secrets."""
    parts = " ".join(f"{key}={value}" for key, value in fields.items())
    logger.log(level, f"[call {session_id}] {event}" + (f" {parts}" if parts else ""))


def _iso_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def _is_uuid(value: str) -> bool:
    try:
        import uuid

        uuid.UUID(value)
        return True
    except (ValueError, AttributeError, TypeError):
        return False


class _Rest:
    """Minimal Supabase/PostgREST client (service role, REST only).

    Deliberately not supabase-py: the service needs three verbs (select,
    patch, and one app-API POST) and httpx is already a transitive dependency
    of the stack. Fewer moving parts in the call path.
    """

    def __init__(self, base_url: str, service_key: str, timeout_secs: float = 5.0) -> None:
        self._base = base_url.rstrip("/")
        self._headers = {
            "apikey": service_key,
            "Authorization": f"Bearer {service_key}",
            "Content-Type": "application/json",
        }
        self._client = httpx.AsyncClient(timeout=timeout_secs)

    async def aclose(self) -> None:
        with contextlib.suppress(Exception):
            await self._client.aclose()

    async def select(
        self,
        table: str,
        *,
        select: str,
        filters: dict[str, str],
        limit: int | None = None,
        order: str | None = None,
    ) -> list[dict[str, Any]]:
        params: list[tuple[str, str]] = [("select", select)]
        for key, value in filters.items():
            params.append((key, value))
        if order:
            params.append(("order", order))
        if limit is not None:
            params.append(("limit", str(limit)))
        resp = await self._client.get(
            f"{self._base}/rest/v1/{table}", params=params, headers=self._headers
        )
        if resp.status_code >= 400:
            raise RuntimeError(f"select {table} failed: HTTP {resp.status_code}")
        data = resp.json()
        return data if isinstance(data, list) else []

    async def patch(self, table: str, *, match: dict[str, str], body: dict[str, Any]) -> None:
        params = [(key, value) for key, value in match.items()]
        resp = await self._client.patch(
            f"{self._base}/rest/v1/{table}",
            params=params,
            headers={**self._headers, "Prefer": "return=minimal"},
            json=body,
        )
        if resp.status_code >= 400:
            raise RuntimeError(f"patch {table} failed: HTTP {resp.status_code}")


@dataclass
class CallContext:
    """The resolved ``calls`` row plus the writes the call makes against it."""

    call_id: str
    user_id: str | None
    contact_id: str | None
    contact_name: str
    platform: str
    session_id: str
    to_number: str
    objective: str
    instructions: str
    status: str
    extra_context: str
    memories: list[str] = field(default_factory=list)
    prior_summaries: list[str] = field(default_factory=list)
    #: ISO timestamp of the actual answer (set by ``set_in_progress``), so
    #: talk duration can be measured from the answer rather than from dial.
    answered_at: str | None = None
    _rest: _Rest | None = field(default=None, repr=False)
    _in_progress_done: bool = field(default=False, repr=False)

    # -- status ---------------------------------------------------------

    async def set_in_progress(self) -> None:
        """The callee answered: queued/ringing -> in_progress, once.

        Conditional on the current status still being pre-connected so a
        completed/failed row is never resurrected by a late answer signal.
        Records ``answered_at`` at the same moment — the conversation timer
        and the recorded talk duration both start at the *actual answer*, not
        at dial time and not at first audio frame.
        """
        if self._rest is None or self._in_progress_done:
            return
        self._in_progress_done = True
        try:
            rows = await self._rest.select(
                "calls",
                select="status, answered_at",
                filters={"id": f"eq.{self.call_id}"},
                limit=1,
            )
            current = rows[0].get("status") if rows else None
            if current in ("queued", "ringing"):
                patch: dict[str, Any] = {"status": "in_progress"}
                if rows and not rows[0].get("answered_at"):
                    patch["answered_at"] = _iso_now()
                await self._rest.patch(
                    "calls",
                    match={"id": f"eq.{self.call_id}"},
                    body=patch,
                )
                self.status = "in_progress"
                self.answered_at = patch.get("answered_at") or (rows[0].get("answered_at") if rows else None)
                _log("INFO", self.session_id, "call status -> in_progress", callId=self.call_id)
        except Exception as exc:  # noqa: BLE001 - never break the audio path
            _log(
                "WARNING",
                self.session_id,
                "failed to mark call in_progress",
                error=type(exc).__name__,
            )

    async def current_status(self) -> str | None:
        if self._rest is None:
            return None
        rows = await self._rest.select(
            "calls",
            select="status",
            filters={"id": f"eq.{self.call_id}"},
            limit=1,
        )
        return rows[0].get("status") if rows else None

    async def fetch_ai_muted(self) -> bool:
        """The call screen's 'Emysa muted' toggle (recipient-side mute)."""
        if self._rest is None:
            return False
        rows = await self._rest.select(
            "calls",
            select="ai_muted",
            filters={"id": f"eq.{self.call_id}"},
            limit=1,
        )
        return bool(rows[0].get("ai_muted")) if rows else False

    async def save_transcript(self, entries: list[dict[str, Any]]) -> None:
        """Debounced full-array write of the transcript (idempotent)."""
        if self._rest is None:
            return
        try:
            await self._rest.patch(
                "calls",
                match={"id": f"eq.{self.call_id}"},
                body={"transcript": entries},
            )
        except Exception as exc:  # noqa: BLE001 - retry happens on next flush
            _log(
                "WARNING",
                self.session_id,
                "transcript flush failed",
                error=type(exc).__name__,
                entries=len(entries),
            )

    async def aclose(self) -> None:
        if self._rest is not None:
            await self._rest.aclose()
            self._rest = None

    # -- end of call ----------------------------------------------------

    async def report_end(
        self,
        *,
        settings: Settings,
        status: str,
        duration_seconds: int,
        active: bool,
    ) -> None:
        """Report the call's end to the app, but only if nobody else did.

        The carrier (WaCalls/mp-relay) posts its own outcome within about a
        second of hangup; this runs after END_REPORT_DELAY_SECS and skips
        entirely when the row is already terminal. When we *do* report, we go
        through the same relay endpoint the carriers use so the app runs its
        full terminal handling (status + ended_at + chat follow-up +
        shared summary/memory extraction) — not a bare status update that
        would skip the summary.
        """
        if self._rest is None:
            return
        with contextlib.suppress(Exception):
            await asyncio.sleep(END_REPORT_DELAY_SECS)

        try:
            current = await self.current_status()
        except Exception:  # noqa: BLE001
            current = None
        if current in TERMINAL_STATUSES:
            _log(
                "INFO",
                self.session_id,
                "end report skipped; carrier already reported",
                status=current,
            )
            return

        if status not in ("completed", "no_answer", "failed"):
            status = "completed" if active else "failed"

        if settings.public_app_url and self.platform in ("whatsapp", "telegram"):
            body = {
                "callId": self.call_id,
                "userId": self.user_id,
                "sessionId": self.session_id,
                "platform": self.platform,
                "status": status,
                "durationSeconds": duration_seconds or None,
                "contactName": self.contact_name or None,
            }
            try:
                resp = await httpx.AsyncClient(timeout=6.0).post(
                    f"{settings.public_app_url.rstrip('/')}/api/social-calling"
                    "?action=relay-call-status",
                    json=body,
                    headers={"X-Relay-Secret": settings.bridge_secret or ""},
                )
                _log(
                    "INFO",
                    self.session_id,
                    "reported call end to app",
                    httpStatus=resp.status_code,
                    status=status,
                )
                return
            except Exception as exc:  # noqa: BLE001 - fall through to direct write
                _log(
                    "WARNING",
                    self.session_id,
                    "app end report failed; writing status directly",
                    error=type(exc).__name__,
                )

        try:
            await self._rest.patch(
                "calls",
                match={"id": f"eq.{self.call_id}"},
                body={
                    "status": status,
                    "ended_at": _iso_now(),
                    "duration_seconds": duration_seconds or None,
                },
            )
            _log("INFO", self.session_id, "call status written directly", status=status)
        except Exception as exc:  # noqa: BLE001 - status will be fixed by other paths
            _log("WARNING", self.session_id, "direct status write failed", error=type(exc).__name__)


class TranscriptLog:
    """Live transcript for one call: append per turn, flush debounced.

    Writes the *full* array each flush rather than appending server-side:
    PostgREST cannot atomically append to jsonb, and full-array writes with a
    dedupe-on-append rule are naturally idempotent under retry. Flushes are
    debounced (~0.75s after the last turn) because a fast back-and-forth
    would otherwise PATCH on every utterance; :meth:`close` always performs a
    final flush so nothing is lost when the call ends.
    """

    def __init__(self, context: CallContext, *, debounce_secs: float = 0.75) -> None:
        self._context = context
        self._debounce = debounce_secs
        self._entries: list[dict[str, Any]] = []
        self._task: asyncio.Task[None] | None = None
        self._dirty = False
        self._closed = False
        self.writes = 0
        self.write_failures = 0

    @property
    def entries(self) -> list[dict[str, Any]]:
        return list(self._entries)

    def note(self, speaker: str, text: str, *, interrupted: bool = False) -> None:
        """Record one turn. Safe to call from pipeline processors.

        Dedupe: an identical entry from the same speaker within a few
        seconds is almost always a retry or an STT repeat of the same
        utterance, not a genuine echo.
        """
        if self._closed:
            return
        clean = (text or "").strip()[:MAX_ENTRY_CHARS]
        if not clean:
            return
        speaker = "ai" if speaker == "ai" else "contact"
        if self._entries:
            last = self._entries[-1]
            if (
                last.get("speaker") == speaker
                and last.get("content") == clean
                and (time.time() - _entry_epoch(last)) < 3.0
            ):
                return
        entry: dict[str, Any] = {"speaker": speaker, "content": clean, "at": _iso_now()}
        if interrupted:
            entry["interrupted"] = True
        self._entries.append(entry)
        if len(self._entries) > MAX_TRANSCRIPT_ENTRIES:
            del self._entries[: len(self._entries) - MAX_TRANSCRIPT_ENTRIES]
        self._dirty = True
        self._schedule()

    def _schedule(self) -> None:
        if self._task is not None and not self._task.done():
            return
        self._task = asyncio.create_task(self._flush_soon(), name="transcript-flush")

    async def _flush_soon(self) -> None:
        # Loop while dirty: a turn recorded *during* a flush must schedule
        # another one — `_schedule` skips when this task is still running.
        while True:
            await asyncio.sleep(self._debounce)
            if self._closed:
                return
            await self.flush()
            if not self._dirty:
                return

    async def flush(self) -> None:
        if self._closed or not self._dirty:
            return
        self._dirty = False
        self.writes += 1
        try:
            await self._context.save_transcript(self._entries)
        except Exception:  # noqa: BLE001 - save_transcript already logged
            self.write_failures += 1
            self._dirty = True

    async def close(self) -> None:
        """Final flush; further notes are ignored."""
        if self._closed:
            return
        task, self._task = self._task, None
        if task is not None:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await task
        if self._entries:
            self._dirty = True
        await self.flush()
        self._closed = True


def _entry_epoch(entry: dict[str, Any]) -> float:
    raw = entry.get("at")
    if not isinstance(raw, str):
        return 0.0
    try:
        from datetime import datetime as _dt

        return _dt.fromisoformat(raw.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return 0.0


# --------------------------------------------------------------------------
# Resolution
# --------------------------------------------------------------------------


def _session_id_candidates(session_id: str) -> list[str]:
    """Ids the row might be keyed by, most specific first.

    The bridge session id is ``call-{platform_call_id}`` for both WaCalls and
    mp-relay; a few integration points pass the raw platform id or the db
    uuid instead, so all three forms are tried.
    """
    out: list[str] = []
    for value in (session_id, session_id.removeprefix("call-")):
        if value and value not in out:
            out.append(value)
    return out


async def _find_call_row(
    rest: _Rest, *, session_id: str, platform: str
) -> dict[str, Any] | None:
    for candidate in _session_id_candidates(session_id):
        attempts: list[dict[str, str]] = [
            {"platform": f"eq.{platform}", "platform_call_id": f"eq.{candidate}"},
            {"platform_call_id": f"eq.{candidate}"},
        ]
        if _is_uuid(candidate):
            attempts.append({"id": f"eq.{candidate}"})
        for filters in attempts:
            try:
                rows = await rest.select(
                    "calls",
                    select=(
                        "id, user_id, contact_id, to_number, objective, instructions, "
                        "status, platform, session_id, outcome_summary, created_at"
                    ),
                    filters=filters,
                    order="created_at.desc",
                    limit=1,
                )
            except Exception:  # noqa: BLE001 - try the next candidate
                continue
            if rows:
                return rows[0]
    return None


async def _fetch_memories(
    rest: _Rest, *, user_id: str, contact_id: str | None, session_id: str
) -> list[str]:
    filters: dict[str, str] = {"user_id": f"eq.{user_id}"}
    if contact_id:
        filters["or"] = f"(contact_id.eq.{contact_id},contact_id.is.null)"
    try:
        rows = await rest.select(
            "memories",
            select="content, memory_type, contact_id, created_at",
            filters=filters,
            order="created_at.desc",
            limit=50,
        )
    except Exception as exc:  # noqa: BLE001 - context degrades, call continues
        _log("WARNING", session_id, "memory retrieval failed", error=type(exc).__name__)
        return []

    scored: list[tuple[int, str]] = []
    for row in rows:
        content = str(row.get("content") or "").strip()
        if not content or _SECRET_PATTERNS.search(content):
            continue
        # Prefer memories recorded against this specific contact, then
        # general user memories; within each band recency wins (rows arrive
        # newest-first).
        rank = 0 if contact_id and row.get("contact_id") == contact_id else 1
        scored.append((rank, content))
    scored.sort(key=lambda item: item[0])
    return [content for _, content in scored[:8]]


async def _fetch_prior_summaries(
    rest: _Rest, *, user_id: str, contact_id: str | None, session_id: str
) -> list[str]:
    if not contact_id:
        return []
    try:
        rows = await rest.select(
            "calls",
            select="outcome_summary, created_at",
            filters={
                "user_id": f"eq.{user_id}",
                "contact_id": f"eq.{contact_id}",
                "outcome_summary": "not.is.null",
            },
            order="created_at.desc",
            limit=5,
        )
    except Exception as exc:  # noqa: BLE001
        _log("WARNING", session_id, "summary history retrieval failed", error=type(exc).__name__)
        return []
    return [str(row.get("outcome_summary") or "").strip() for row in rows if row.get("outcome_summary")]


async def _fetch_contact_name(
    rest: _Rest, *, contact_id: str | None, to_number: str, session_id: str
) -> str:
    if contact_id:
        try:
            rows = await rest.select("contacts", select="name", filters={"id": f"eq.{contact_id}"}, limit=1)
            if rows and rows[0].get("name"):
                return str(rows[0]["name"])
        except Exception:  # noqa: BLE001 - fall through to the number
            pass
    return to_number or "your contact"


def build_extra_context(context: CallContext) -> str:
    """Compose the per-call block appended under the behavioural prompt.

    Rules live in the system prompt (app/pipeline.py); this block is only
    facts, so nothing here can talk the model out of its behavioural
    constraints.
    """
    lines = [
        "This is a live phone call — everything you write is spoken aloud.",
        f"You are speaking with: {context.contact_name}.",
    ]
    if context.objective:
        lines.append(f"Objective for this call: {context.objective}")
    if context.instructions and context.instructions != context.objective:
        lines.append(f"Extra instructions from the user: {context.instructions}")
    if context.prior_summaries:
        lines.append("What you discussed with this person before:")
        lines.extend(f"- {summary}" for summary in context.prior_summaries)
    if context.memories:
        lines.append("Facts you remember about them:")
        lines.extend(f"- {memory}" for memory in context.memories)
    return "\n".join(lines)


async def resolve_call_context(
    settings: Settings,
    *,
    session_id: str,
    platform: str,
    user_id: str | None,
) -> CallContext | None:
    """Find the ``calls`` row for this bridged call, within a bounded wait.

    Returns ``None`` when the service runs standalone (mock mode, no
    Supabase creds) or when no row appears before the deadline — the call
    then proceeds with the default system prompt and without transcript
    persistence rather than failing outright.
    """
    if settings.mock_mode:
        return None
    if not settings.supabase_url or not settings.supabase_service_role_key:
        # This used to be a silent `return None`, which made every call run
        # with NO objective, NO person context, NO memory and NO transcript
        # persistence, with nothing in the logs to say why. Say it loudly.
        _log(
            "ERROR",
            session_id,
            "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set on this service; "
            "the call runs WITHOUT instructions, memory, live transcript or summary. "
            "Set both env vars on the assistant service and redeploy",
            urlSet=bool(settings.supabase_url),
            serviceKeySet=bool(settings.supabase_service_role_key),
        )
        return None

    rest = _Rest(settings.supabase_url, settings.supabase_service_role_key, timeout_secs=5.0)
    deadline = time.monotonic() + settings.context_timeout_secs
    delay = 0.75
    row: dict[str, Any] | None = None
    try:
        while True:
            row = await _find_call_row(rest, session_id=session_id, platform=platform)
            if row:
                break
            if time.monotonic() >= deadline:
                break
            await asyncio.sleep(delay)
            delay = min(delay * 1.6, 3.0)

        if not row:
            _log(
                "WARNING",
                session_id,
                "no calls row found before deadline; continuing without context",
                platform=platform,
                deadlineSecs=settings.context_timeout_secs,
            )
            return None

        call_id = str(row["id"])
        db_user_id = str(row.get("user_id") or user_id or "")
        contact_id = row.get("contact_id")
        contact_id = str(contact_id) if contact_id else None
        to_number = str(row.get("to_number") or "")

        contact_name, memories, summaries = await asyncio.gather(
            _fetch_contact_name(rest, contact_id=contact_id, to_number=to_number, session_id=session_id),
            _fetch_memories(rest, user_id=db_user_id, contact_id=contact_id, session_id=session_id)
            if settings.enable_persistent_memory and db_user_id
            else _empty(),
            _fetch_prior_summaries(rest, user_id=db_user_id, contact_id=contact_id, session_id=session_id)
            if db_user_id
            else _empty(),
        )

        context = CallContext(
            call_id=call_id,
            user_id=db_user_id or None,
            contact_id=contact_id,
            contact_name=contact_name,
            platform=str(row.get("platform") or platform),
            session_id=session_id,
            to_number=to_number,
            objective=str(row.get("objective") or ""),
            instructions=str(row.get("instructions") or ""),
            status=str(row.get("status") or "queued"),
            extra_context="",
            memories=memories,
            prior_summaries=summaries,
            _rest=rest,
        )
        context.extra_context = build_extra_context(context)
        _log(
            "INFO",
            session_id,
            "call context resolved",
            callId=call_id,
            status=context.status,
            memories=len(memories),
            priorSummaries=len(summaries),
        )
        return context
    except Exception as exc:  # noqa: BLE001 - never block the call on context
        _log(
            "WARNING",
            session_id,
            "context resolution error; continuing without context",
            error=type(exc).__name__,
        )
        return None
    finally:
        # The client is cheap to recreate for writes (short-lived requests),
        # but closing here would break the context we may have just returned,
        # so it is only closed when we return None.
        if row is None:
            await rest.aclose()


async def _empty() -> list[str]:  # pragma: no cover - trivial
    return []
