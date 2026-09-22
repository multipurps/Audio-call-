import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  linearToMulaw,
  mulawToLinear,
  mulawToPcm16,
  pcm16ToMulaw,
  pcm16ToWav,
  floatToPcm16,
  pcm16ToFloat,
  mulawFrames,
  LinearResampler,
} from '../audioCodec.js';

// The published G.711 μ-law table pins two values exactly: 0x00 decodes to
// -32124 and 0x80 to +32124 (the codec's full scale), and 0xFF is silence.
// If the sign bit or the 0x84 bias were wrong these would come out wrong
// while audio still "mostly worked", so they're worth asserting literally.
test('mulaw matches the reference table at the extremes and at silence', () => {
  assert.equal(mulawToLinear(0x00), -32124);
  assert.equal(mulawToLinear(0x80), 32124);
  assert.equal(mulawToLinear(0xff), 0);
  assert.equal(linearToMulaw(0), 0xff);
});

test('mulaw round-trips within its quantisation step', () => {
  // μ-law is logarithmic: the step is small near zero and large near full
  // scale, so the tolerance has to scale with the value rather than being a
  // fixed number.
  for (let v = -32124; v <= 32124; v += 37) {
    const back = mulawToLinear(linearToMulaw(v));
    const tolerance = Math.max(4, Math.abs(v) * 0.06);
    assert.ok(Math.abs(back - v) <= tolerance, `${v} -> ${back}`);
  }
});

test('mulaw preserves sign', () => {
  assert.ok(mulawToLinear(linearToMulaw(9000)) > 0);
  assert.ok(mulawToLinear(linearToMulaw(-9000)) < 0);
});

test('pcm16/mulaw buffer conversions are inverses', () => {
  const pcm = Int16Array.from([0, 4000, -4000, 16000, -16000, 32124, -32124]);
  const mulaw = pcm16ToMulaw(pcm);
  assert.equal(mulaw.length, pcm.length);
  const back = mulawToPcm16(mulaw);
  assert.equal(back.length, pcm.length);
  for (let i = 0; i < pcm.length; i++) {
    assert.ok(Math.abs(back[i] - pcm[i]) <= Math.max(4, Math.abs(pcm[i]) * 0.06), `index ${i}`);
  }
});

test('pcm16ToMulaw accepts a Buffer without reading past its window', () => {
  // Buffers are views onto a pooled ArrayBuffer; slicing the wrong range
  // would encode neighbouring bytes as audio.
  const pool = Buffer.alloc(16);
  pool.writeInt16LE(8000, 4);
  pool.writeInt16LE(-8000, 6);
  const view = pool.subarray(4, 8);
  const mulaw = pcm16ToMulaw(view);
  assert.equal(mulaw.length, 2);
  assert.ok(mulawToLinear(mulaw[0]) > 0);
  assert.ok(mulawToLinear(mulaw[1]) < 0);
});

test('mu-law silence is 0xFF, not 0x00', () => {
  // directBridge.js fills pacing gaps with this byte. 0x00 is -32124 — a
  // loud click fifty times a second — so this is the assertion that keeps
  // that from silently regressing.
  assert.equal(mulawToLinear(0xff), 0);
  assert.ok(Math.abs(mulawToLinear(0x00)) > 30000);
});

test('float/pcm16 conversions clamp and round-trip', () => {
  const f = Float32Array.from([0, 1, -1, 2, -2, 0.5]);
  const pcm = floatToPcm16(f);
  assert.equal(pcm[1], 0x7fff);
  assert.equal(pcm[2], -0x8000);
  assert.equal(pcm[3], 0x7fff); // clamped
  assert.equal(pcm[4], -0x8000); // clamped
  const back = pcm16ToFloat(pcm);
  assert.ok(Math.abs(back[5] - 0.5) < 0.001);
});

test('mulawFrames splits on 20ms telephony boundaries', () => {
  const frames = mulawFrames(Buffer.alloc(160 * 3 + 7));
  assert.equal(frames.length, 4);
  assert.equal(frames[0].length, 160);
  assert.equal(frames[3].length, 7); // remainder kept, not dropped
});

test('pcm16ToWav writes a header Whisper will accept', () => {
  const wav = pcm16ToWav(Int16Array.from([1, 2, 3]), 8000);
  assert.equal(wav.subarray(0, 4).toString(), 'RIFF');
  assert.equal(wav.subarray(8, 12).toString(), 'WAVE');
  assert.equal(wav.readUInt32LE(24), 8000); // sample rate
  assert.equal(wav.readUInt16LE(22), 1); // mono
  assert.equal(wav.readUInt16LE(34), 16); // bits
  assert.equal(wav.readUInt32LE(40), 6); // data bytes
  assert.equal(wav.length, 50);
});

test('resampler downsamples 48k->8k to a sixth of the length', () => {
  const r = new LinearResampler(48000, 8000);
  const out = r.process(new Float32Array(6144).fill(0.5));
  assert.equal(out.length, 1024);
  // Every sample but the very first should be the constant — the first is
  // interpolated against the zeroed initial state.
  for (let i = 1; i < out.length; i++) {
    assert.ok(Math.abs(out[i] - 0.5) < 1e-6, `index ${i} = ${out[i]}`);
  }
});

test('resampler carries state across calls so chunks join without a step', () => {
  const r = new LinearResampler(48000, 8000);
  const a = r.process(new Float32Array(4800).fill(0.25));
  const b = r.process(new Float32Array(4800).fill(0.25));
  const seamA = a[a.length - 1];
  const seamB = b[0];
  // A stateless resampler would restart from 0 here and produce a full
  // 0.25 step at the boundary — audible as a click every chunk.
  assert.ok(Math.abs(seamB - seamA) < 0.01, `seam ${seamA} -> ${seamB}`);
});

test('resampler upsamples 8k->48k for the browser playback path', () => {
  const r = new LinearResampler(8000, 48000);
  const out = r.process(new Float32Array(160).fill(-0.3));
  assert.equal(out.length, 960);
  // The first upsampling ratio (6) of samples interpolate up from the zeroed
  // initial state — that's the resampler's fade-in, not an error.
  for (let i = 6; i < out.length; i++) {
    assert.ok(Math.abs(out[i] + 0.3) < 1e-6, `index ${i} = ${out[i]}`);
  }
});
