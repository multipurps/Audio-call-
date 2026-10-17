"""The callee's microphone state: muted caller audio must never reach the pipeline."""

import json
import types

import pytest

from app.protocol import AudioFrame, Encoding
from app.transport import AcafBridge


class FakeSocket:
    async def send_text(self, text: str) -> None:  # pragma: no cover - not used here
        pass


class FakeSession:
    session_id = "call-mute-1"

    def __init__(self) -> None:
        self.inbound = 0

    def note_inbound(self, sequence: int, byte_count: int) -> None:
        self.inbound += 1

    def note_malformed(self, byte_count: int) -> None:  # pragma: no cover
        pass


class FakeSerializer:
    def __init__(self) -> None:
        self.calls = 0

    async def deserialize(self, data: bytes):
        self.calls += 1
        return None


def audio_frame(sequence: int) -> bytes:
    pcm = b"\x01\x00" * 320  # 20 ms of 16 kHz mono PCM16
    return AudioFrame.audio_out(
        pcm, sequence=sequence, timestamp_ms=0, sample_rate=16000,
        channels=1, encoding=Encoding.PCM_S16LE,
    ).encode()


def make_bridge() -> AcafBridge:
    bridge = AcafBridge(websocket=FakeSocket(), settings=types.SimpleNamespace(max_frame_bytes=64 * 1024), registry=None)  # type: ignore[arg-type]
    bridge.session = FakeSession()  # type: ignore[assignment]
    bridge.serializer = FakeSerializer()  # type: ignore[assignment]
    return bridge


def mute_message(muted: bool) -> str:
    return json.dumps({"type": "peer_mute", "muted": muted})


@pytest.mark.asyncio
async def test_muted_callee_audio_never_reaches_the_serializer_or_pipeline():
    bridge = make_bridge()
    assert await bridge._handle_control(mute_message(True)) is True
    for seq in range(1, 4):
        await bridge._handle_audio(audio_frame(seq))

    assert bridge.serializer.calls == 0
    assert bridge._muted_frames == 3
    # Sequence tracking still runs, so muted frames are not reported as network loss.
    assert bridge.session.inbound == 3


@pytest.mark.asyncio
async def test_unmuting_resumes_the_callee_audio():
    bridge = make_bridge()
    await bridge._handle_control(mute_message(True))
    await bridge._handle_audio(audio_frame(1))
    await bridge._handle_control(mute_message(False))
    await bridge._handle_audio(audio_frame(2))

    assert bridge.serializer.calls == 1
    assert bridge._peer_muted is False


@pytest.mark.asyncio
async def test_repeated_mute_state_is_idempotent():
    bridge = make_bridge()
    await bridge._handle_control(mute_message(True))
    await bridge._handle_control(mute_message(True))
    assert bridge._peer_muted is True
