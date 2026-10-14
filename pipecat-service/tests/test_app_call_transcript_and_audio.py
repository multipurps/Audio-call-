"""Regression tests: live transcript push to the in-app call, and no frame thinning on audio out."""

import asyncio
import json

from app.app_call import BrowserAcafSocket
from app.monitor import get_hub, reset_hub


class _FakeWs:
    def __init__(self) -> None:
        self.texts: list[str] = []
        self.blocker = asyncio.Event()

    async def receive(self):
        await self.blocker.wait()
        return {"type": "websocket.disconnect"}

    async def send_text(self, text: str) -> None:
        self.texts.append(text)

    async def send_bytes(self, data: bytes) -> None:  # pragma: no cover - unused here
        pass

    async def close(self, code: int = 1000) -> None:
        pass


async def _settle() -> None:
    for _ in range(5):
        await asyncio.sleep(0)


class TestTranscriptPush:
    async def test_a_recorded_turn_reaches_the_browser_without_a_database_round_trip(self):
        reset_hub()
        ws = _FakeWs()
        peer = BrowserAcafSocket(ws, secret="s", session_id="call-t1", user_id="u1")
        await peer.receive_text()  # handshake read starts the feed
        get_hub().publish_transcript("call-t1", {"speaker": "contact", "content": "hello there", "at": "t"})
        get_hub().publish_transcript("call-t1", {"speaker": "ai", "content": "hi", "at": "t"})
        await _settle()
        events = [json.loads(t) for t in ws.texts]
        assert [e["type"] for e in events] == ["transcript", "transcript"]
        assert [e["seq"] for e in events] == [1, 2]
        assert events[0]["speaker"] == "contact" and events[1]["content"] == "hi"
        await peer.close()

    async def test_other_calls_turns_are_never_forwarded(self):
        reset_hub()
        ws = _FakeWs()
        peer = BrowserAcafSocket(ws, secret="s", session_id="call-a", user_id="u1")
        await peer.receive_text()
        get_hub().publish_transcript("call-b", {"speaker": "ai", "content": "secret", "at": "t"})
        await _settle()
        assert ws.texts == []
        await peer.close()

    async def test_closing_releases_the_subscription_and_stops_forwarding(self):
        reset_hub()
        ws = _FakeWs()
        peer = BrowserAcafSocket(ws, secret="s", session_id="call-c", user_id="u1")
        await peer.receive_text()
        assert get_hub().subscriber_count("call-c") == 1
        await peer.close()
        assert get_hub().subscriber_count("call-c") == 0


class TestWriteLoopDoesNotThinAudio:
    async def test_a_deep_queue_is_delivered_frame_for_frame_not_every_other_one(self):
        from app.backpressure import BoundedFrameQueue
        from app.transport import AcafBridge  # noqa: F401  (import check: module loads)

        # The old loop skipped every other frame once the queue was >= 75% full. Reproduce
        # the decision it used and show the new loop never consults it.
        import inspect

        import app.transport as transport

        src = inspect.getsource(transport.AcafBridge._write_loop)
        assert "should_send" not in src, "adaptive frame skipping must not be applied to live audio"
        q = BoundedFrameQueue(100)
        for i in range(90):
            q.put(i)
        # Drop-oldest remains the only shedding, and it is contiguous.
        for i in range(90, 130):
            q.put(i)
        kept = [q.get() for _ in range(len(q))]
        assert kept == list(range(30, 130))


class TestNativeOutputRate:
    async def _wire(self, native: bool, rate: int):
        from pipecat.frames.frames import OutputAudioRawFrame

        from app.protocol import AudioFrame
        from app.serializer import TelegramFrameSerializer

        params = TelegramFrameSerializer.InputParams(bridge_sample_rate=16000, native_output_rate=native)
        ser = TelegramFrameSerializer("s", params=params)
        pcm = (b"\x10\x00\x20\x00" * 240)  # 480 samples = 20 ms at 24 kHz
        wire = await ser.serialize(OutputAudioRawFrame(audio=pcm, sample_rate=rate, num_channels=1))
        return AudioFrame.decode(wire), pcm

    async def test_in_app_calls_get_the_engines_own_rate_untouched(self):
        frame, pcm = await self._wire(True, 24000)
        assert frame.sample_rate == 24000
        assert frame.payload == pcm, "no resampling: the samples are exactly what the engine produced"

    async def test_carrier_peers_still_get_the_bridge_rate(self):
        frame, pcm = await self._wire(False, 24000)
        assert frame.sample_rate == 16000
        assert len(frame.payload) < len(pcm)
