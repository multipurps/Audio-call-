import threading

from emysa_tgcall import pcm


def test_format_constants():
    assert (pcm.SAMPLE_RATE, pcm.CHANNELS, pcm.SAMPLE_WIDTH) == (48000, 1, 2)
    assert pcm.FRAME_SAMPLES == 480 and pcm.FRAME_BYTES == 960
    assert len(pcm.silence(10)) == pcm.FRAME_BYTES
    assert len(pcm.tone(440, 1000)) == pcm.BYTES_PER_SECOND


def test_goertzel_identifies_tones_and_silence():
    for hz in (300, 500, 700, 900):
        assert pcm.dominant_frequency(pcm.tone(hz, 100), pcm.KNOWN_SEQUENCE_HZ + (pcm.PROBE_HZ,)) == hz
    assert pcm.dominant_frequency(pcm.silence(100), (300, 500)) is None


def test_known_signal_is_deterministic_and_ordered():
    a, b = pcm.known_test_signal(), pcm.known_test_signal()
    assert a == b
    assert pcm.detect_sequence(a, pcm.KNOWN_SEQUENCE_HZ) == list(pcm.KNOWN_SEQUENCE_HZ)


def test_chunker_resizes_arbitrary_input():
    c = pcm.FrameChunker()
    assert c.push(b"x" * 500) == []
    out = c.push(b"y" * 1500)
    assert [len(f) for f in out] == [960, 960] and c.pending == 80
    assert len(c.flush()[0]) == 960 and c.pending == 0


def test_jitter_buffer_underrun_pad_and_overflow_drop_oldest():
    j = pcm.JitterBuffer(max_bytes=10)
    j.push(b"abcdefghijKLM")
    assert j.dropped == 3 and j.pull(10) == b"defghijKLM"
    assert j.pull(4) == b"\x00" * 4 and j.underruns == 1
    assert j.pull_available(1) is None


def test_jitter_buffer_threadsafe():
    j = pcm.JitterBuffer(10**7)
    def prod():
        for _ in range(2000):
            j.push(b"z" * 100)
    ts = [threading.Thread(target=prod) for _ in range(4)]
    [t.start() for t in ts]; [t.join() for t in ts]
    assert len(j) == 800_000
