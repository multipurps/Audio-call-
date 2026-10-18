"""A call on the Emysa agent (ElevenLabs), with the app's own instructions and the user's voice.

Used when the user has chosen the Agent voice (table user_agents, active = true). The agent
holds the models and turn-taking settings; each call sends the same instructions GPT-Live
gets, and the chosen voice, when the connection opens. ElevenLabs runs speech recognition,
turn-taking, interruptions and the reply. This module moves audio both ways.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from typing import Any, Awaitable, Callable

from app.call_context import _Rest
from app.config import Settings
from app.conversation import PacedAudioSender
from app.elevenlabs_agent import ElevenLabsAgentClient, fetch_signed_url, resolve_agent_id
from app.monitor import DIRECTION_CALLER, DIRECTION_EMYSA, get_hub

logger = logging.getLogger("emysa.agent")


@dataclass(frozen=True)
class AgentLink:
    voice_id: str | None


async def fetch_agent_link(settings: Settings, user_id: str | None, session_id: str) -> AgentLink | None:
    """The user's Agent choice, or None when they use a Standard or Custom voice (or the read fails)."""
    if settings.mock_mode or not user_id or not settings.supabase_url or not settings.supabase_service_role_key:
        return None
    rest = _Rest(settings.supabase_url, settings.supabase_service_role_key, timeout_secs=4.0)
    try:
        rows = await rest.select(
            "user_agents",
            select="voice_id,active",
            filters={"user_id": f"eq.{user_id}", "active": "eq.true"},
            limit=1,
        )
    except Exception as exc:  # noqa: BLE001 - a read problem means the normal voices run
        logger.warning("agent lookup failed session=%s error=%s", session_id, type(exc).__name__)
        return None
    finally:
        await rest.aclose()
    if not rows:
        return None
    return AgentLink(voice_id=str(rows[0]["voice_id"]) if rows[0].get("voice_id") else None)


def build_overrides(*, prompt: str, first_message: str | None, voice_id: str | None) -> dict[str, Any]:
    """Per-call settings layered on the agent. Only what is set is sent."""
    agent: dict[str, Any] = {"prompt": {"prompt": prompt}}
    if first_message:
        agent["first_message"] = first_message
    overrides: dict[str, Any] = {"agent": agent}
    if voice_id:
        overrides["tts"] = {"voice_id": voice_id}
    return overrides


class ElevenLabsAgentConversation:
    """One call on the Emysa agent. Same shape as the other conversations the bridge drives."""

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
        first_message: str | None,
        voice_id: str | None,
    ) -> None:
        self._settings = settings
        self._session_id = session_id
        self._on_ended = on_ended
        self._overrides = build_overrides(prompt=prompt, first_message=first_message, voice_id=voice_id)
        self._client: ElevenLabsAgentClient | None = None
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
        key = self._settings.elevenlabs_api_key
        if not key:
            raise RuntimeError("ELEVENLABS_API_KEY is not set on the assistant service")
        agent_id = await resolve_agent_id(key, configured=self._settings.elevenlabs_agent_id)
        url = await fetch_signed_url(agent_id, key)
        self._client = ElevenLabsAgentClient(signed_url=url, conversation_config_override=self._overrides)
        await self._client.start()
        self.sender.start()
        self._task = asyncio.create_task(self._pump(), name=f"agent-events-{self._session_id}")

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
                elif event.kind == "interruption":
                    await self.sender.interrupt()
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
