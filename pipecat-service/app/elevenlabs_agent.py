"""ElevenLabs Agents client: one live conversation over the agent WebSocket.

Caller audio goes up as base64 `user_audio_chunk` messages. Agent audio comes
back as `audio` events. ElevenLabs decides turn-taking, interruptions and
transcription, so this client only moves audio and reports events.

Server-side only: the API key is used to obtain a signed URL and never leaves
the server. Nothing here logs audio or transcript text.
"""

from __future__ import annotations

import base64
import json
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass
from typing import Any

import httpx
import websockets

AGENT_WS_URL = "wss://api.elevenlabs.io/v1/convai/conversation"
SIGNED_URL_ENDPOINT = "https://api.elevenlabs.io/v1/convai/conversation/get-signed-url"


async def fetch_signed_url(agent_id: str, api_key: str, *, client: httpx.AsyncClient | None = None) -> str:
    """Exchange the server's API key for a short-lived WebSocket URL for one agent."""
    if not agent_id or not api_key:
        raise ValueError("ElevenLabs agent id and API key are required")
    owned = client is None
    http = client or httpx.AsyncClient(timeout=10.0)
    try:
        resp = await http.get(SIGNED_URL_ENDPOINT, params={"agent_id": agent_id}, headers={"xi-api-key": api_key})
        resp.raise_for_status()
        return resp.json()["signed_url"]
    finally:
        if owned:
            await http.aclose()


@dataclass(frozen=True)
class AgentEvent:
    """One thing the agent side reported. `audio` holds decoded bytes; others carry `text`."""

    kind: str  # "audio" | "interruption" | "user_transcript" | "agent_response" | "other"
    audio: bytes = b""
    text: str = ""
    raw_type: str = ""


Connect = Callable[[str], Awaitable[Any]]


async def _default_connect(url: str) -> Any:
    return await websockets.connect(url, max_size=2**22)


class ElevenLabsAgentClient:
    """Holds one agent conversation. Use one instance per call."""

    def __init__(
        self,
        *,
        signed_url: str,
        connect: Connect = _default_connect,
        conversation_config_override: dict[str, Any] | None = None,
    ) -> None:
        self._signed_url = signed_url
        self._connect = connect
        self._override = conversation_config_override
        self._ws: Any = None

    async def start(self) -> None:
        self._ws = await self._connect(self._signed_url)
        init: dict[str, Any] = {"type": "conversation_initiation_client_data"}
        if self._override:
            init["conversation_config_override"] = self._override
        await self._send(init)

    async def send_caller_audio(self, pcm: bytes) -> None:
        """Send caller audio as it arrives. Chunks are sent as received, not batched."""
        if not pcm:
            return
        await self._send({"user_audio_chunk": base64.b64encode(pcm).decode("ascii")})

    async def events(self) -> AsyncIterator[AgentEvent]:
        """Yield agent events until the socket closes. Answers keep-alive pings itself."""
        assert self._ws is not None, "start() first"
        async for message in self._ws:
            data = json.loads(message)
            kind = data.get("type", "")
            if kind == "ping":
                event_id = (data.get("ping_event") or {}).get("event_id")
                await self._send({"type": "pong", "event_id": event_id})
                continue
            if kind == "audio":
                b64 = (data.get("audio_event") or {}).get("audio_base_64", "")
                if b64:
                    yield AgentEvent("audio", audio=base64.b64decode(b64), raw_type=kind)
                continue
            if kind == "interruption":
                yield AgentEvent("interruption", raw_type=kind)
                continue
            if kind == "user_transcript":
                text = ((data.get("user_transcription_event") or {}).get("user_transcript")) or ""
                yield AgentEvent("user_transcript", text=text, raw_type=kind)
                continue
            if kind == "agent_response":
                text = ((data.get("agent_response_event") or {}).get("agent_response")) or ""
                yield AgentEvent("agent_response", text=text, raw_type=kind)
                continue
            yield AgentEvent("other", raw_type=kind)

    async def close(self) -> None:
        ws, self._ws = self._ws, None
        if ws is not None:
            await ws.close()

    async def _send(self, payload: dict[str, Any]) -> None:
        if self._ws is None:
            raise RuntimeError("ElevenLabs agent socket is not open")
        await self._ws.send(json.dumps(payload))


_AGENT_IDS: dict[str, str] = {}


async def resolve_agent_id(
    api_key: str,
    *,
    name: str = "Emysa",
    configured: str | None = None,
    client: httpx.AsyncClient | None = None,
) -> str:
    """The agent every call uses: the configured id, or the account's agent with this name.

    The agent holds the voice, models and turn-taking settings in the ElevenLabs dashboard.
    Each call then sends the app's own instructions and the user's chosen voice on top of it.
    """
    if configured:
        return configured
    if name in _AGENT_IDS:
        return _AGENT_IDS[name]
    if not api_key:
        raise ValueError("ELEVENLABS_API_KEY is not set")
    owned = client is None
    http = client or httpx.AsyncClient(timeout=10.0)
    try:
        resp = await http.get("https://api.elevenlabs.io/v1/convai/agents", headers={"xi-api-key": api_key})
        resp.raise_for_status()
        agents = resp.json().get("agents", [])
    finally:
        if owned:
            await http.aclose()
    for agent in agents:
        if str(agent.get("name", "")).strip().lower() == name.lower() and agent.get("agent_id"):
            _AGENT_IDS[name] = str(agent["agent_id"])
            return _AGENT_IDS[name]
    raise RuntimeError(f"No ElevenLabs agent named {name!r} in this account")
