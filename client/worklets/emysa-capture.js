// Microphone capture worklet for Direct Caller Mode.
//
// Runs on the audio thread, so it never drops samples when the main thread is
// busy. Per 128-sample render quantum it:
//   1. downmixes however many channels the device gave us to mono,
//   2. resamples from the AudioContext rate to the rate the voice changer
//      wants (48 kHz — w-okada's VoiceChangerSettings.inputSampleRate),
//   3. accumulates into one chunk and posts it as int16 PCM.
//
// Chunk size is the single biggest latency knob in this pipeline: the relay
// can't start converting until a whole chunk arrives. It's set from the main
// thread (DIRECT_VC_CHUNK_MS) rather than hardcoded so it can be tuned
// against a real call.
//
// Resampling is linear interpolation with the last sample and the fractional
// read position carried across quanta. Statelessness here would put a click
// every 2.7 ms.

const DEFAULT_TARGET_RATE = 48000;
const DEFAULT_CHUNK_MS = 128;

class EmysaCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.targetRate = opts.targetRate || DEFAULT_TARGET_RATE;
    const chunkMs = opts.chunkMs || DEFAULT_CHUNK_MS;
    // Snap to a whole number of 128-sample blocks: w-okada's RVC pipeline
    // works in 128-sample units, so a chunk that isn't one just gets padded
    // or split server-side.
    this.chunkSize = Math.max(128, Math.round((this.targetRate * chunkMs) / 1000 / 128) * 128);
    this.ratio = sampleRate / this.targetRate;

    this.acc = new Float32Array(this.chunkSize);
    this.accLen = 0;

    // Resampler state across quanta.
    this.last = 0;
    this.pos = 0;

    this.mono = new Float32Array(128);
    this.levelSum = 0;
    this.levelFrames = 0;
    this.lastLevelPost = currentTime;

    this.port.onmessage = (e) => {
      if (e.data && e.data.type === 'flush') {
        this.accLen = 0;
        this.last = 0;
        this.pos = 0;
      }
    };
  }

  process(inputs) {
    const input = inputs && inputs[0];
    if (!input || input.length === 0 || !input[0]) return true;

    // 1. downmix to mono
    const n = input[0].length;
    const channels = input.length;
    const mono = this.mono;
    if (channels === 1) {
      mono.set(input[0].subarray(0, 128));
    } else {
      for (let i = 0; i < 128 && i < n; i++) {
        let sum = 0;
        for (let c = 0; c < channels; c++) sum += input[c][i] || 0;
        mono[i] = sum / channels;
      }
    }

    // Input level, for the on-screen meter. Posted on a slow cadence —
    // doing it per quantum would swamp the main thread's message queue.
    for (let i = 0; i < 128; i++) this.levelSum += mono[i] * mono[i];
    this.levelFrames += 128;
    if (currentTime - this.lastLevelPost >= 0.1) {
      const rms = this.levelFrames > 0 ? Math.sqrt(this.levelSum / this.levelFrames) : 0;
      this.port.postMessage({ type: 'level', level: rms });
      this.levelSum = 0;
      this.levelFrames = 0;
      this.lastLevelPost = currentTime;
    }

    // 2. resample
    //
    // Read position `pos` is measured from `last`, which conceptually sits at
    // input index -1; input index i therefore lives at position i + 1. For a
    // read at position p the bracketing samples are at indices floor(p) - 1
    // and floor(p).
    const outLen = Math.max(0, Math.floor((128 - this.pos) / this.ratio));
    for (let k = 0; k < outLen; k++) {
      const p = this.pos + k * this.ratio;
      const i0 = Math.floor(p) - 1;
      const frac = p - Math.floor(p);
      const a = i0 < 0 ? this.last : mono[i0];
      const b = i0 + 1 >= 128 ? mono[127] : mono[i0 + 1];
      this.push(a + (b - a) * frac);
    }
    this.pos = this.pos + outLen * this.ratio - 128;
    if (this.pos < 0) this.pos = 0;
    this.last = mono[Math.min(127, n - 1)];

    return true;
  }

  push(sample) {
    this.acc[this.accLen++] = sample;
    if (this.accLen < this.chunkSize) return;

    // 3. chunk full -> int16 PCM, transferred (not copied) to the main thread
    const pcm = new Int16Array(this.chunkSize);
    for (let i = 0; i < this.chunkSize; i++) {
      const s = this.acc[i];
      const clamped = s < -1 ? -1 : s > 1 ? 1 : s;
      pcm[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    }
    this.accLen = 0;
    this.port.postMessage({ type: 'audio', pcm: pcm.buffer, samples: this.chunkSize }, [pcm.buffer]);
  }
}

registerProcessor('emysa-capture', EmysaCaptureProcessor);
