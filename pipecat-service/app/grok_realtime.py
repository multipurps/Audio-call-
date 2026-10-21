"""xAI Speech to Speech (Grok Voice) realtime client: one live conversation over WebSocket.

Protocol (docs.x.ai speech-to-speech): session.update configures voice, instructions and
16 kHz PCM both ways; caller audio goes up as input_audio_buffer.append; the reply comes
back as audio deltas. Server VAD decides turn ends and barge-in. The server key is used
here only and never sent to the app.
"""

from __future__ import annotations

import base64
import json
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass
from typing import Any

import websockets

REALTIME_URL = "wss://api.x.ai/v1/realtime?model=grok-voice-latest"
DEFAULT_VOICE = "eve"  # built-in voice used when the user has not chosen one


@dataclass(frozen=True)
class RealtimeEvent:
    """What the other side reported. `audio` holds decoded PCM; `text` holds transcript or error text."""

    kind: str  # audio | interrupted | user_transcript | agent_transcript | function_call | error | other
    audio: bytes = b""
    text: str = ""
    raw_type: str = ""
    call_id: str = ""  # function_call: the id the tool result must be sent back under


END_CALL_TOOL = "end_call"

#: Said to the model when it may hang up. Grok writes its own replies, so it is given the same
#: action GPT-Live has: a function it calls after the goodbye.
HANGUP_RULES = (
    "Ending the call: you have one action, " + END_CALL_TOOL + ", which hangs up the phone call. "
    "Call it only when the conversation is finished and you have said your final goodbye, or when "
    "the person clearly asks you to hang up or end the call (say a brief goodbye, then call it). "
    "Never call it while the person is still asking or talking, and never mention it to them."
)


def end_call_tool_spec() -> dict[str, Any]:
    """The hang-up function, in the OpenAI-compatible shape the xAI realtime API takes."""
    return {
        "type": "function",
        "name": END_CALL_TOOL,
        "description": (
            "Hang up the phone call. Use only after the final goodbye has been said, or when the "
            "person clearly asks to end the call. Never use it while they are still talking."
        ),
        "parameters": {"type": "object", "properties": {}},
    }


def build_session_update(*, instructions: str, voice_id: str | None, rate: int = 16000,
                         end_call_tool: bool = False) -> dict[str, Any]:
    """The session settings sent on connect. Same instructions as GPT-Live; formats match the bridge.

    With `end_call_tool`, the model can hang up the call itself (see HANGUP_RULES)."""
    update: dict[str, Any] = {
        "voice": voice_id or DEFAULT_VOICE,
        "instructions": instructions + ("\n\n" + HANGUP_RULES if end_call_tool else ""),
        "turn_detection": {"type": "server_vad"},
        "audio": {
            "input": {
                "format": {"type": "audio/pcm", "rate": rate},
                "transcription": {"model": "grok-transcribe"},
            },
            "output": {"format": {"type": "audio/pcm", "rate": rate}},
        },
    }
    if end_call_tool:
        update["tools"] = [end_call_tool_spec()]
    return update


Connect = Callable[[str], Awaitable[Any]]


class GrokRealtimeClient:
    def __init__(self, *, api_key: str, session_update: dict[str, Any], connect: Connect | None = None,
                 url: str = REALTIME_URL) -> None:
        self._api_key = api_key
        self._session_update = session_update
        self._url = url
        self._connect = connect or self._default_connect
        self._ws: Any = None

    async def _default_connect(self, url: str) -> Any:
        return await websockets.connect(
            url,
            additional_headers={"Authorization": f"Bearer {self._api_key}"},
            max_size=2**22,
        )

    async def start(self) -> None:
        self._ws = await self._connect(self._url)
        await self._send({"type": "session.update", "session": self._session_update})

    async def send_caller_audio(self, pcm: bytes) -> None:
        """Caller audio as it arrives, not batched."""
        if pcm:
            await self._send({"type": "input_audio_buffer.append", "audio": base64.b64encode(pcm).decode("ascii")})

    async def send_greeting(self, text: str) -> None:
        """A scripted opening line, spoken as the first turn (interruptible)."""
        await self._send({
            "type": "conversation.item.create",
            "item": {
                "type": "force_message",
                "role": "assistant",
                "interruptible": True,
                "content": [{"type": "output_text", "text": text}],
            },
        })

    async def send_function_result(self, call_id: str, output: dict[str, Any]) -> None:
        """Answer a function call the model made, then the model carries on (see send_response_create)."""
        await self._send({
            "type": "conversation.item.create",
            "item": {"type": "function_call_output", "call_id": call_id, "output": json.dumps(output)},
        })

    async def send_response_create(self) -> None:
        """Ask the model to speak again (after a function result)."""
        await self._send({"type": "response.create"})

    async def events(self) -> AsyncIterator[RealtimeEvent]:
        assert self._ws is not None, "start() first"
        async for message in self._ws:
            data = json.loads(message)
            kind = data.get("type", "")
            if kind in ("response.output_audio.delta", "response.audio.delta"):
                b64 = data.get("delta", "")
                if b64:
                    yield RealtimeEvent("audio", audio=base64.b64decode(b64), raw_type=kind)
            elif kind == "input_audio_buffer.speech_started":
                yield RealtimeEvent("interrupted", raw_type=kind)
            elif kind == "conversation.item.input_audio_transcription.completed":
                yield RealtimeEvent("user_transcript", text=str(data.get("transcript", "")), raw_type=kind)
            elif kind in ("response.output_audio_transcript.done", "response.audio_transcript.done"):
                yield RealtimeEvent("agent_transcript", text=str(data.get("transcript", "")), raw_type=kind)
            elif kind == "response.function_call_arguments.done":
                yield RealtimeEvent(
                    "function_call", text=str(data.get("name", "")), raw_type=kind, call_id=str(data.get("call_id", "")),
                )
            elif kind == "error":
                message_text = str((data.get("error") or {}).get("message", ""))[:200]
                yield RealtimeEvent("error", text=message_text, raw_type=kind)
            else:
                yield RealtimeEvent("other", raw_type=kind)

    async def close(self) -> None:
        ws, self._ws = self._ws, None
        if ws is not None:
            await ws.close()

    async def _send(self, payload: dict[str, Any]) -> None:
        if self._ws is None:
            raise RuntimeError("Grok realtime socket is not open")
        await self._ws.send(json.dumps(payload))
