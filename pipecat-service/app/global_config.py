"""Admin-controlled global AI guidance (sql/041_ai_behavior.sql).

One published config plus approved knowledge, shared by GPT-Live and the Luna
classic pipeline. It is prompt configuration and retrieval. It does not train or
fine-tune any model, and it never touches per-user memory.

Fetched once at call start. A call keeps what it started with: GPT-Live's
instructions are locked for the session (app/live.py), and the classic pipeline
keeps the same rule so a call never changes mid-sentence. Any failure returns an
empty block, so the built-in rules keep working.
"""

from __future__ import annotations

import time
from typing import Any

import httpx
from loguru import logger

_TTL_SECS = 30.0
_TIMEOUT_SECS = 2.5
_MAX_BLOCK_CHARS = 5200
_cache: dict[tuple[str, str, str], tuple[float, tuple[int, str]]] = {}

#: Sessions started by the admin "Call Emysa" training call, session id -> "live" | "luna".
#: Filled only after the signed trainer token was verified (app/main.py), never from client input.
_TRAINERS: dict[str, str] = {}


def mark_trainer(session_id: str, engine: str = "live") -> None:
    _TRAINERS[session_id] = "luna" if engine == "luna" else "live"


def trainer_engine(session_id: str) -> str | None:
    return _TRAINERS.get(session_id)


def clear_trainer(session_id: str) -> None:
    _TRAINERS.pop(session_id, None)

HEADER = (
    "House guidance from the Emysa team (applies to every call; the instructions "
    "for this call still take priority):"
)


def call_mode(platform: str | None, is_app_call: bool) -> str:
    """phone | app | social, the three modes the admin can target."""
    if is_app_call:
        return "app"
    p = str(platform or "").strip().lower()
    if p in {"whatsapp", "telegram", "signal"}:
        return "social"
    return "phone"


def _query_for(call_context: Any) -> str:
    parts = [
        str(getattr(call_context, "objective", "") or ""),
        str(getattr(call_context, "instructions", "") or ""),
    ]
    return " ".join(p for p in parts if p).strip()[:600]


def render_section(block: str) -> str:
    block = (block or "").strip()
    return f"{HEADER}\n{block}" if block else ""


async def fetch_global_block(
    settings: Any, *, model: str, mode: str, call_context: Any = None, session_id: str = "-", draft: bool = False
) -> str:
    """Rendered guidance for this call, or "" if none is published or the fetch fails."""
    url = getattr(settings, "supabase_url", None)
    key = getattr(settings, "supabase_service_role_key", None)
    if not url or not key:
        return ""
    query = _query_for(call_context)
    cache_key = (model, mode, query)
    hit = None if draft else _cache.get(cache_key)  # training calls always read the latest draft
    now = time.monotonic()
    if hit and now - hit[0] < _TTL_SECS:
        return render_section(hit[1][1])
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT_SECS) as client:
            resp = await client.post(
                f"{url.rstrip('/')}/rest/v1/rpc/ai_global_context",
                headers={"apikey": key, "Authorization": f"Bearer {key}", "Content-Type": "application/json"},
                json={"p_model": model, "p_mode": mode, "p_query": query, **({"p_use_draft": True} if draft else {})},
            )
        if resp.status_code >= 400:
            raise RuntimeError(f"HTTP {resp.status_code}")
        data = resp.json() or {}
        block = str(data.get("block") or "")[:_MAX_BLOCK_CHARS]
        version = int(data.get("version") or 0)
        if not draft:
            if len(_cache) > 200:
                _cache.clear()
            _cache[cache_key] = (now, (version, block))
        logger.info(f"[global-ai] session={session_id} model={model} mode={mode} version={version} chars={len(block)}")
        return render_section(block)
    except Exception as exc:  # noqa: BLE001 - never block a call on guidance
        logger.warning(f"[global-ai] session={session_id} fetch failed, using built-in rules: {type(exc).__name__}: {str(exc)[:120]}")
        return ""
