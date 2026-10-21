"""Inworld Realtime (speech to speech) client: one live conversation over WebSocket.

Verified protocol (docs.inworld.ai realtime): connect with a session id and the key in
an Authorization: Basic header; session.update sets the model, instructions, voice and
16 kHz PCM both ways; caller audio goes up as input_audio_buffer.append; the reply comes
back as response.output_audio.delta. Server-side only; the key never reaches the app.
"""

from __future__ import annotations

import base64
import json
import uuid
from collections.abc import AsyncIterator, Awaitable, Callable
from typing import Any

import websockets

from app.grok_realtime import RealtimeEvent

REALTIME_BASE = "wss://api.inworld.ai/api/v1/realtime/session"
DEFAULT_MODEL = "google-ai-studio/gemini-2.5-flash"
DEFAULT_TTS = "inworld-tts-2"
DEFAULT_STT = "inworld/inworld-stt-1"


def build_inworld_session(*, instructions: str, voice_id: str | None, rate: int = 16000,
                          model: str = DEFAULT_MODEL, own_llm: bool = False) -> dict[str, Any]:
    """The session settings sent on connect: the app's instructions, the chosen voice, 16 kHz PCM.

    With `own_llm`, Inworld still hears the caller, takes turns and transcribes, but does not write
    replies (create_response is off): our own model does, and the reply is sent back to be spoken."""
    return {
        "type": "realtime",
        "model": model,
        "instructions": instructions,
        "output_modalities": ["audio"],
        "audio": {
            "input": {
                "format": {"type": "audio/pcm", "rate": rate},
                "transcription": {"model": DEFAULT_STT},
                "turn_detection": {
                    "type": "semantic_vad",
                    "eagerness": "medium",
                    "create_response": not own_llm,
                    "interrupt_response": True,
                },
            },
            "output": {
                "format": {"type": "audio/pcm", "rate": rate},
                "voice": voice_id or "Dennis",
                "model": DEFAULT_TTS,
            },
        },
    }


Connect = Callable[[str, dict[str, str]], Awaitable[Any]]


async def _default_connect(url: str, headers: dict[str, str]) -> Any:
    return await websockets.connect(url, additional_headers=headers, max_size=2**22)


class InworldRealtimeClient:
    def __init__(self, *, api_key: str, session_update: dict[str, Any], connect: Connect | None = None,
                 session_id: str | None = None) -> None:
        self._api_key = api_key
        self._session_update = session_update
        self._connect = connect or _default_connect
        self._session_id = session_id or uuid.uuid4().hex
        self._ws: Any = None

    def url(self) -> str:
        return f"{REALTIME_BASE}?key={self._session_id}&protocol=realtime"

    async def start(self) -> None:
        self._ws = await self._connect(self.url(), {"Authorization": f"Basic {self._api_key}"})
        await self._send({"type": "session.update", "session": self._session_update})

    async def send_caller_audio(self, pcm: bytes) -> None:
        if pcm:
            await self._send({"type": "input_audio_buffer.append", "audio": base64.b64encode(pcm).decode("ascii")})

    async def send_speak(self, text: str) -> None:
        """Text spoken verbatim in the session's voice, without Inworld's language model.

        Inworld documents response.speak for this. One at a time is the supported pattern: the
        next is sent after the previous one's response.done."""
        await self._send({"type": "response.speak", "text": text})

    async def send_greeting(self, text: str) -> None:
        """A scripted opening line."""
        await self.send_speak(text)

    async def send_cancel(self) -> None:
        """Stop the line being spoken (the caller talked over it)."""
        await self._send({"type": "response.cancel"})

    async def events(self) -> AsyncIterator[RealtimeEvent]:
        assert self._ws is not None, "start() first"
        async for message in self._ws:
            data = json.loads(message)
            kind = data.get("type", "")
            if kind == "response.output_audio.delta":
                b64 = data.get("delta", "")
                if b64:
                    yield RealtimeEvent("audio", audio=base64.b64decode(b64), raw_type=kind)
            elif kind == "input_audio_buffer.speech_started":
                yield RealtimeEvent("interrupted", raw_type=kind)
            elif kind == "response.done":
                yield RealtimeEvent("response_done", raw_type=kind)
            elif kind == "conversation.item.input_audio_transcription.completed":
                yield RealtimeEvent("user_transcript", text=str(data.get("transcript", "")), raw_type=kind)
            elif kind == "response.output_audio_transcript.done":
                yield RealtimeEvent("agent_transcript", text=str(data.get("transcript", "")), raw_type=kind)
            elif kind == "error":
                err = data.get("error") or {}
                yield RealtimeEvent("error", text=str(err.get("message", ""))[:200], raw_type=kind)
            else:
                yield RealtimeEvent("other", raw_type=kind)

    async def close(self) -> None:
        ws, self._ws = self._ws, None
        if ws is not None:
            await ws.close()

    async def _send(self, payload: dict[str, Any]) -> None:
        if self._ws is None:
            raise RuntimeError("Inworld realtime socket is not open")
        await self._ws.send(json.dumps(payload))
