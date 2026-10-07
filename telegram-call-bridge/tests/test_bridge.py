import asyncio
import threading

from emysa_tgcall import KnownAudioAdapter, PcmBridge
from emysa_tgcall.media import MediaEngine
from emysa_tgcall.pcm import FRAME_BYTES, silence, tone
from emysa_tgcall.types import CallInfo, Direction


class SinkMedia(MediaEngine):
    """Records frames the bridge sends."""
    def __init__(self): self.frames = []
    def protocol(self): ...
    def set_callbacks(self, **k): ...
    async def create_call(self, p): ...
    async def init_exchange(self, d, g=None): ...
    async def exchange_keys(self, a, f): ...
    async def connect(self, r, v, p): ...
    async def feed_signaling(self, d): ...
    async def send_frame(self, f): self.frames.append(f)
    async def stop(self): ...


INFO = CallInfo(1, 2, Direction.OUTGOING)


async def test_inbound_rechunked_to_960_from_foreign_thread():
    ad = KnownAudioAdapter(reply=b"")
    br = PcmBridge(SinkMedia(), ad)
    await br.start(INFO)
    data = tone(440, 200)
    def feed():
        for i in range(0, len(data), 700):          # odd-sized chunks
            br.on_media_frame(data[i:i + 700])
    t = threading.Thread(target=feed); t.start(); t.join()
    await asyncio.sleep(0.2)
    await br.stop("test")
    assert ad.rx_frames == len(data) // FRAME_BYTES and ad.bad_frames == 0
    assert ad.received_pcm() == data[: ad.rx_frames * FRAME_BYTES]
    assert ad.ended_reason == "test"


async def test_outbound_is_paced_not_bursted():
    m = SinkMedia()
    br = PcmBridge(m, KnownAudioAdapter(reply=b""))
    await br.start(INFO)
    br.send_pcm(tone(500, 2000))                    # 2 s handed over at once
    await asyncio.sleep(0.5)
    n = len(m.frames)
    assert 40 <= n <= 60, n                         # ~100 fps => ~50 in 0.5 s
    assert br.outbound_backlog_ms > 1300
    await br.stop("t")


async def test_clear_outbound_barge_in_and_silence_when_idle():
    m = SinkMedia()
    br = PcmBridge(m, KnownAudioAdapter(reply=b""))
    await br.start(INFO)
    br.send_pcm(tone(500, 2000))
    await asyncio.sleep(0.1)
    assert br.clear_outbound() > 0 and br.outbound_backlog_ms == 0
    await asyncio.sleep(0.1)
    assert br.tx_silence_frames > 0 and m.frames[-1] == silence(10)
    await br.stop("t")


async def test_outbound_overflow_drops_oldest():
    br = PcmBridge(SinkMedia(), KnownAudioAdapter(reply=b""), max_outbound_ms=100)
    br.send_pcm(tone(500, 1000))
    assert br.outbound_backlog_ms <= 100 and br.tx_dropped_bytes > 0


async def test_adapter_exception_does_not_kill_bridge():
    class Bad(KnownAudioAdapter):
        async def on_caller_audio(self, f): raise RuntimeError("boom")
    br = PcmBridge(SinkMedia(), Bad(reply=b""))
    await br.start(INFO)
    br.on_media_frame(bytes(FRAME_BYTES * 3))
    await asyncio.sleep(0.1)
    assert br.rx_frames == 3
    await br.stop("t")


async def test_on_call_end_not_called_if_never_started():
    ad = KnownAudioAdapter(reply=b"")
    await PcmBridge(SinkMedia(), ad).stop("x")
    assert ad.ended_reason is None
