"""The ElevenLabs test voice returns real audio frames over HTTP streaming, and a
vendor error (bad key, no credits, unknown voice) reaches the call log instead of
silently producing no audio."""
import asyncio
import base64
import dataclasses
import json

import pytest

pytest.importorskip("pipecat")
aiohttp = pytest.importorskip("aiohttp")
from aiohttp import web  # noqa: E402

from app.config import load_settings  # noqa: E402
from app.providers import build_tts  # noqa: E402

BASE = {"ASSISTANT_BRIDGE_SECRET": "x" * 24, "OPENAI_API_KEY": "sk-test-openai-key", "FISH_API_KEY": "fish-test-key-1234"}
PCM = b"\x01\x02" * 1600  # 100 ms of 16 kHz mono PCM


def _alignment(text):
    n = len(text)
    return {
        "characters": list(text),
        "character_start_times_seconds": [i * 0.01 for i in range(n)],
        "character_end_times_seconds": [(i + 1) * 0.01 for i in range(n)],
    }


async def _run(handler, text="Hey, Ayodele."):
    seen = {}

    async def wrapped(request):
        seen["key"] = request.headers.get("xi-api-key")
        seen["path"] = request.path
        seen["body"] = await request.json()
        return await handler(request)

    app = web.Application()
    app.router.add_post("/v1/text-to-speech/{voice}/stream/with-timestamps", wrapped)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    port = site._server.sockets[0].getsockname()[1]
    try:
        s = dataclasses.replace(load_settings(dict(BASE)), tts_provider="elevenlabs",
                                tts_test_voice_id="vendor-voice-123", tts_test_api_key="user-key-abcdefgh")
        tts = build_tts(s)
        tts._base_url = f"http://127.0.0.1:{port}"
        frames = [f async for f in tts.run_tts(text, "ctx-1") if f is not None]
        await tts.cleanup()
        assert tts._owned_session.closed, "the per-call HTTP session is closed with the call"
        return frames, seen
    finally:
        await runner.cleanup()


def test_audio_frames_are_produced_with_the_users_key_and_voice():
    async def ok(request):
        text = (await request.json())["text"]
        line = json.dumps({"audio_base64": base64.b64encode(PCM).decode(), "alignment": _alignment(text)}) + "\n"
        return web.Response(text=line, content_type="application/json")

    frames, seen = asyncio.run(_run(ok))
    from pipecat.frames.frames import TTSAudioRawFrame
    audio = [f for f in frames if isinstance(f, TTSAudioRawFrame)]
    assert audio and sum(len(f.audio) for f in audio) == len(PCM)
    assert seen["key"] == "user-key-abcdefgh"
    assert "vendor-voice-123" in seen["path"]
    assert seen["body"]["text"] == "Hey, Ayodele."


def test_a_vendor_error_is_reported_with_its_message():
    async def denied(request):
        return web.json_response({"detail": {"status": "quota_exceeded", "message": "out of credits"}}, status=401)

    frames, _ = asyncio.run(_run(denied))
    from pipecat.frames.frames import ErrorFrame
    errs = [f for f in frames if isinstance(f, ErrorFrame)]
    assert errs and "quota_exceeded" in errs[0].error
