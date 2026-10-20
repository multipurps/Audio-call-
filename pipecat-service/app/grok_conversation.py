"""A call on the Grok speech-to-speech agent, with the app's own instructions and the chosen voice.

Used when the user has chosen the Agent voice (table user_agents, active = true). Same
instructions GPT-Live gets (one brain). Caller audio goes up as it arrives; agent audio is
paced back; an interruption drops queued agent audio; transcripts go to the call record.
"""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass
from typing import Any, Awaitable, Callable

from app.call_context import _Rest
from app.config import Settings
from app.conversation import PacedAudioSender
from app.grok_realtime import GrokRealtimeClient, build_session_update
from app.inworld_realtime import InworldRealtimeClient, build_inworld_session
from app.monitor import DIRECTION_CALLER, DIRECTION_EMYSA, get_hub

logger = logging.getLogger("emysa.agent")

_KEY_CACHE: dict[str, Any] = {"value": None, "at": 0.0}
_KEY_TTL_SECS = 60.0


@dataclass(frozen=True)
class AgentLink:
    voice_id: str | None
    provider: str  # 'grok' (Live presets) or 'inworld' (Custom clones)


async def fetch_agent_link(settings: Settings, user_id: str | None, session_id: str) -> AgentLink | None:
    """The user's Custom (Grok) choice, or None when they use a Standard voice. A failed read raises."""
    url = getattr(settings, "supabase_url", None)
    service_key = getattr(settings, "supabase_service_role_key", None)
    if getattr(settings, "mock_mode", False) or not user_id or not url or not service_key:
        return None
    rest = _Rest(url, service_key, timeout_secs=4.0)
    try:
        rows = await rest.select(
            "user_agents", select="voice_id,active,provider",
            filters={"user_id": f"eq.{user_id}", "active": "eq.true"}, limit=1,
        )
    except Exception as exc:  # noqa: BLE001 - the Custom voice must not silently become GPT-Live
        logger.error("agent lookup failed session=%s error=%s; call not connected", session_id, type(exc).__name__)
        raise RuntimeError("the Custom voice could not be checked; call not connected") from None
    finally:
        await rest.aclose()
    if not rows:
        return None
    provider = "inworld" if rows[0].get("provider") == "inworld" else "grok"
    return AgentLink(voice_id=str(rows[0]["voice_id"]) if rows[0].get("voice_id") else None, provider=provider)


async def resolve_xai_key(settings: Settings) -> str | None:
    """The xAI key: the one saved in admin (app_secrets) first, then the server setting. Cached a minute."""
    now = time.monotonic()
    if _KEY_CACHE["value"] and now - _KEY_CACHE["at"] < _KEY_TTL_SECS:
        return _KEY_CACHE["value"]
    saved = None
    url = getattr(settings, "supabase_url", None)
    service_key = getattr(settings, "supabase_service_role_key", None)
    if not getattr(settings, "mock_mode", False) and url and service_key:
        rest = _Rest(url, service_key, timeout_secs=4.0)
        try:
            rows = await rest.select("app_secrets", select="value", filters={"name": "eq.XAI_API_KEY"}, limit=1)
            if rows and rows[0].get("value"):
                saved = str(rows[0]["value"]).strip()
        except Exception:  # noqa: BLE001 - fall back to the server setting
            saved = None
        finally:
            await rest.aclose()
    value = saved or getattr(settings, "xai_api_key", None) or None
    _KEY_CACHE.update(value=value, at=now)
    return value


async def resolve_inworld_key(settings: Settings) -> str | None:
    """The Inworld key: saved in admin (app_secrets) first, then the server setting. Cached a minute."""
    cache = _INWORLD_KEY_CACHE
    now = time.monotonic()
    if cache["value"] and now - cache["at"] < _KEY_TTL_SECS:
        return cache["value"]
    saved = None
    url = getattr(settings, "supabase_url", None)
    service_key = getattr(settings, "supabase_service_role_key", None)
    if not getattr(settings, "mock_mode", False) and url and service_key:
        rest = _Rest(url, service_key, timeout_secs=4.0)
        try:
            rows = await rest.select("app_secrets", select="value", filters={"name": "eq.INWORLD_API_KEY"}, limit=1)
            if rows and rows[0].get("value"):
                saved = str(rows[0]["value"]).strip()
        except Exception:  # noqa: BLE001 - fall back to the server setting
            saved = None
        finally:
            await rest.aclose()
    value = saved or getattr(settings, "inworld_api_key", None) or None
    cache.update(value=value, at=now)
    return value


_INWORLD_KEY_CACHE: dict[str, Any] = {"value": None, "at": 0.0}


class GrokAgentConversation:
    """One call on the Grok agent. Same shape as the other conversations the bridge drives."""

    def __init__(
        self,
        *,
        settings: Settings,
        session_id: str,
        serializer: Any,
        send_audio: Callable[[bytes], Awaitable[None]],
        send_control: Callable[[str], Awaitable[None]],
        on_ended: Callable[[str], Awaitable[None]] | None,
        prompt: str,
        greeting: str | None,
        voice_id: str | None,
        transcript: Any = None,
        provider: str = "grok",
    ) -> None:
        self._settings = settings
        self._provider = provider
        self._session_id = session_id
        self._on_ended = on_ended
        self._transcript = transcript
        self._greeting = greeting
        if provider == "inworld":
            self._session_update = build_inworld_session(
                instructions=prompt, voice_id=voice_id, rate=settings.bridge_sample_rate,
            )
        else:
            self._session_update = build_session_update(
                instructions=prompt, voice_id=voice_id, rate=settings.bridge_sample_rate,
            )
        self._client: GrokRealtimeClient | None = None
        self._task: asyncio.Task[None] | None = None
        self._stopped = False
        self._warned_rate = False
        self.call_active = False
        self.sender = PacedAudioSender(
            session_id=session_id,
            serializer=serializer,
            send_audio=send_audio,
            send_control=send_control,
            on_chunk=lambda pcm, rate, channels: get_hub().publish(session_id, DIRECTION_EMYSA, rate, pcm),
        )

    async def start(self) -> None:
        if self._provider == "inworld":
            key = await resolve_inworld_key(self._settings)
            if not key:
                raise RuntimeError("the Inworld key is not set")
            self._client = InworldRealtimeClient(api_key=key, session_update=self._session_update)
        else:
            key = await resolve_xai_key(self._settings)
            if not key:
                raise RuntimeError("the xAI key is not set")
            self._client = GrokRealtimeClient(api_key=key, session_update=self._session_update)
        await self._client.start()
        self.sender.start()
        if self._greeting:
            await self._client.send_greeting(self._greeting)
        self._task = asyncio.create_task(self._pump(), name=f"grok-events-{self._session_id}")

    async def push_audio(self, frame: Any) -> None:
        """Caller audio, sent as it arrives."""
        if self._client is None or self._stopped:
            return
        rate = getattr(frame, "sample_rate", None)
        if rate != self._settings.bridge_sample_rate:
            if not self._warned_rate:
                self._warned_rate = True
                logger.warning("agent needs %s Hz caller audio, got %s; dropping", self._settings.bridge_sample_rate, rate)
            return
        get_hub().publish(self._session_id, DIRECTION_CALLER, rate, frame.audio)
        await self._client.send_caller_audio(frame.audio)

    async def note_call_active(self, source: str) -> bool:
        self.call_active = True
        return True

    async def _pump(self) -> None:
        """Agent events in, agent audio out. Ends when the agent side closes."""
        try:
            assert self._client is not None
            async for event in self._client.events():
                if event.kind == "audio":
                    await self.sender.enqueue(event.audio, self._settings.bridge_sample_rate)
                elif event.kind == "interrupted":
                    await self.sender.interrupt()
                elif event.kind == "user_transcript" and event.text and self._transcript is not None:
                    self._transcript.note("contact", event.text)
                elif event.kind == "agent_transcript" and event.text and self._transcript is not None:
                    self._transcript.note("ai", event.text)
                elif event.kind == "error":
                    logger.warning("agent error session=%s message=%s", self._session_id, event.text)
                elif event.kind == "other":
                    logger.info("agent event type=%s session=%s", event.raw_type or "-", self._session_id)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 - reported; the call is then hung up
            logger.warning("agent event loop ended session=%s error=%s", self._session_id, type(exc).__name__)
        finally:
            if not self._stopped and self._on_ended is not None:
                await self._on_ended("agent-ended")

    async def stop(self, reason: str = "stopped") -> None:
        self._stopped = True
        task = self._task
        if task is not None and task is not asyncio.current_task():
            task.cancel()
            try:
                await task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
        elif task is not None:
            task.cancel()
        if self._client is not None:
            try:
                await self._client.close()
            except Exception:  # noqa: BLE001 - closing a dead socket is not an error
                pass
        await self.sender.stop()
        get_hub().close_room(self._session_id)
        logger.info("agent conversation stopped session=%s reason=%s", self._session_id, reason)

    def stats(self) -> dict[str, Any]:
        return {"engine": "agent", **self.sender.stats()}
