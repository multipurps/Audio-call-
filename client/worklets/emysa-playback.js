// Caller-audio playback worklet for Direct Caller Mode.
//
// The relay forwards the caller's audio as int16 PCM at Twilio's native
// 8 kHz, completely unprocessed — no voice conversion is applied to the
// incoming side, by design. This worklet's only job is to turn that back
// into something the device can play: linear-interpolate 8 kHz up to the
// AudioContext rate and pull it out a render quantum at a time.
//
// It's a worklet rather than a chain of AudioBufferSourceNodes because the
// audio arrives in a continuous, open-ended stream; scheduling thousands of
// one-shot buffers per call both leaks and drifts.
//
// Buffer underruns (the caller is silent, or a packet is late) emit silence
// rather than repeating the last sample, which would sound like a stuck
// record. Overruns drop the oldest audio so latency can't accumulate — on a
// phone call, slightly lossy and current beats complete and behind.

const DEFAULT_SOURCE_RATE = 8000;

class EmysaPlaybackProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.sourceRate = opts.sourceRate || DEFAULT_SOURCE_RATE;
    this.ratio = this.sourceRate / sampleRate; // < 1: we are upsampling

    this.capacity = Math.floor(sampleRate * 1.5); // 1.5 s of device-rate audio
    this.ring = new Float32Array(this.capacity);
    this.write = 0;
    this.available = 0;

    // Resampler state across pushes.
    this.last = 0;
    this.pos = 0;

    this.port.onmessage = (e) => {
      const data = e.data;
      if (!data) return;
      if (data.type === 'clear') {
        this.available = 0;
        this.write = 0;
        this.last = 0;
        this.pos = 0;
        return;
      }
      if (data.pcm) this.pushInt16(new Int16Array(data.pcm));
    };
  }

  pushInt16(pcm) {
    const n = pcm.length;
    if (n === 0) return;
    const outLen = Math.max(0, Math.floor((n - this.pos) / this.ratio));
    for (let k = 0; k < outLen; k++) {
      const p = this.pos + k * this.ratio;
      const i0 = Math.floor(p) - 1;
      const frac = p - Math.floor(p);
      const a = i0 < 0 ? this.last : pcm[i0] / 0x8000;
      const b = i0 + 1 >= n ? pcm[n - 1] / 0x8000 : pcm[i0 + 1] / 0x8000;
      this.writeSample(a + (b - a) * frac);
    }
    this.pos = this.pos + outLen * this.ratio - n;
    if (this.pos < 0) this.pos = 0;
    this.last = pcm[n - 1] / 0x8000;
  }

  writeSample(s) {
    this.ring[this.write] = s;
    this.write = (this.write + 1) % this.capacity;
    if (this.available < this.capacity) {
      this.available++;
    } else {
      // Ring is full. Nothing to drop explicitly: process() derives the read
      // position as (write - available), so once available is pinned at
      // capacity the read pointer tracks the write pointer and the sample
      // just overwritten was already the oldest one. The message is only so
      // the UI can say the connection is running behind.
      this.port.postMessage({ type: 'overflow' });
    }
  }

  process(inputs, outputs) {
    const out = outputs[0];
    if (!out) return true;
    const frames = out[0].length;
    const readStart = (this.write - this.available + this.capacity * 2) % this.capacity;

    let played = 0;
    for (let i = 0; i < frames; i++) {
      if (i < this.available) {
        const sample = this.ring[(readStart + i) % this.capacity];
        for (let c = 0; c < out.length; c++) out[c][i] = sample;
        played++;
      } else {
        for (let c = 0; c < out.length; c++) out[c][i] = 0;
      }
    }

    this.available = Math.max(0, this.available - played);
    return true;
  }
}

registerProcessor('emysa-playback', EmysaPlaybackProcessor);
