// Telephony audio primitives: G.711 μ-law <-> PCM16, plus streaming linear
// resampling.
//
// Twilio Media Streams carries call audio as 8 kHz mono μ-law in 20 ms frames
// (see server/AUDIO-PATH.md). The browser and the w-okada voice changer both
// want PCM16 — the browser at whatever its AudioContext runs at, w-okada at
// 48 kHz by default (VoiceChangerSettings.inputSampleRate). Everything that
// crosses those boundaries converts here, in one place, so the relay and the
// worklets can't drift apart on what a "sample" means.
//
// The μ-law tables are the canonical Sun Microsystems reference
// implementation (the same arithmetic g711.c/sox uses), not a re-derivation —
// getting the sign bit or the bias wrong here produces audio that is merely
// loud and wrong rather than obviously broken, so it's worth being boring.

export const MULAW_BIAS = 0x84; // 132
const MULAW_CLIP = 0x7fff;
const SEG_AEND = [0xff, 0x1ff, 0x3ff, 0x7ff, 0xfff, 0x1fff, 0x3fff, 0x7fff];
const QUANT_MASK = 0x0f;
const SEG_MASK = 0x70;
const SEG_SHIFT = 4;
const SIGN_BIT = 0x80;

/** PCM16 sample (signed 16-bit int) -> one μ-law byte. */
export function linearToMulaw(pcmSample) {
  let sample = pcmSample;
  let mask;

  if (sample < 0) {
    sample = MULAW_BIAS - sample;
    mask = 0x7f;
  } else {
    sample = sample + MULAW_BIAS;
    mask = 0xff;
  }
  if (sample > MULAW_CLIP) sample = MULAW_CLIP;

  let seg = 8;
  for (let i = 0; i < 8; i++) {
    if (sample <= SEG_AEND[i]) {
      seg = i;
      break;
    }
  }
  if (seg >= 8) return 0x7f ^ mask;
  return ((seg << 4) | ((sample >> (seg + 3)) & 0x0f)) ^ mask;
}

/** One μ-law byte -> PCM16 sample. */
export function mulawToLinear(ulawByte) {
  const u = ~ulawByte & 0xff;
  let t = ((u & QUANT_MASK) << 3) + MULAW_BIAS;
  t <<= (u & SEG_MASK) >> SEG_SHIFT;
  return u & SIGN_BIT ? MULAW_BIAS - t : t - MULAW_BIAS;
}

/** Buffer of μ-law bytes -> Int16Array of PCM16 samples. */
export function mulawToPcm16(mulawBuffer) {
  const out = new Int16Array(mulawBuffer.length);
  for (let i = 0; i < mulawBuffer.length; i++) out[i] = mulawToLinear(mulawBuffer[i]);
  return out;
}

/** PCM16 samples (Int16Array | Buffer of int16) -> Buffer of μ-law bytes. */
export function pcm16ToMulaw(pcm16) {
  const samples = pcm16 instanceof Int16Array ? pcm16 : new Int16Array(toArrayBuffer(pcm16));
  const out = Buffer.alloc(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = linearToMulaw(samples[i]);
  return out;
}

/** Node Buffer / Uint8Array -> a real ArrayBuffer view (no copy when possible). */
function toArrayBuffer(buf) {
  if (buf instanceof Uint8Array) {
    // Slice out the exact window — a Buffer can be a view onto a pooled
    // ArrayBuffer, and Int16Array over the whole pool would read neighbours.
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  }
  return buf;
}

/** Wrap raw int16 PCM in a minimal 44-byte RIFF/WAVE header. */
export function pcm16ToWav(pcm16, sampleRate) {
  const samples = pcm16 instanceof Int16Array ? pcm16 : new Int16Array(toArrayBuffer(pcm16));
  const dataSize = samples.length * 2;
  const out = Buffer.alloc(44 + dataSize);
  out.write('RIFF', 0);
  out.writeUInt32LE(36 + dataSize, 4);
  out.write('WAVE', 8);
  out.write('fmt ', 12);
  out.writeUInt32LE(16, 16); // PCM chunk size
  out.writeUInt16LE(1, 20); // format = PCM
  out.writeUInt16LE(1, 22); // mono
  out.writeUInt32LE(sampleRate, 24);
  out.writeUInt32LE(sampleRate * 2, 28); // byte rate
  out.writeUInt16LE(2, 32); // block align
  out.writeUInt16LE(16, 34); // bits per sample
  out.write('data', 36);
  out.writeUInt32LE(dataSize, 40);
  Buffer.from(samples.buffer, samples.byteOffset, dataSize).copy(out, 44);
  return out;
}

/** Float32 [-1, 1] -> Int16Array, clamped. */
export function floatToPcm16(float32) {
  const out = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

/** Int16Array -> Float32Array in [-1, 1]. */
export function pcm16ToFloat(pcm16) {
  const out = new Float32Array(pcm16.length);
  for (let i = 0; i < pcm16.length; i++) out[i] = pcm16[i] / 0x8000;
  return out;
}

/**
 * Streaming linear-interpolation resampler.
 *
 * Stateful on purpose: call-to-call it keeps the last input sample and the
 * fractional read position, so chunk boundaries don't introduce a step (which
 * sounds like a click every ~100 ms — very audible on a phone call). Linear
 * is good enough for 8 kHz telephony audio; a polyphase filter would be
 * better and is not worth the CPU here.
 */
export class LinearResampler {
  constructor(fromRate, toRate) {
    if (!fromRate || !toRate) throw new Error('LinearResampler needs non-zero rates');
    this.fromRate = fromRate;
    this.toRate = toRate;
    this.ratio = fromRate / toRate;
    this.last = 0; // last sample of the previous call, for interpolation across the seam
    this.pos = 0; // fractional read position, in input samples, relative to `last`
    this.primed = false;
  }

  reset() {
    this.last = 0;
    this.pos = 0;
    this.primed = false;
  }

  /** Float32Array in -> Float32Array out at the new rate. */
  process(input) {
    if (input.length === 0) return new Float32Array(0);
    const outLen = Math.max(0, Math.floor((input.length - this.pos) / this.ratio));
    const out = new Float32Array(outLen);

    // Read position `pos` is measured from `last`; index i of `input` sits at
    // position i + 1. Interpolate between the two samples bracketing `pos`.
    for (let n = 0; n < outLen; n++) {
      const p = this.pos + n * this.ratio;
      const i = Math.floor(p) - 1; // index into input; -1 means "the seam sample"
      const frac = p - Math.floor(p);
      const a = i < 0 ? this.last : input[i];
      const b = i + 1 < 0 ? this.last : i + 1 < input.length ? input[i + 1] : input[input.length - 1];
      out[n] = a + (b - a) * frac;
    }

    this.pos = (this.pos + outLen * this.ratio) - input.length;
    if (this.pos < 0) this.pos = 0;
    this.last = input[input.length - 1];
    this.primed = true;
    return out;
  }
}

/** Split PCM16 bytes into Twilio-sized μ-law frames (default 20 ms @ 8 kHz). */
export function mulawFrames(mulawBuffer, frameSize = 160) {
  const frames = [];
  for (let i = 0; i < mulawBuffer.length; i += frameSize) {
    frames.push(mulawBuffer.subarray(i, i + frameSize));
  }
  return frames;
}
