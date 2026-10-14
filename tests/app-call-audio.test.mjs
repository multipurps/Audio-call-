import test from 'node:test';
import assert from 'node:assert/strict';
import { floatToPcm16k, decodeAppCallFrame, describeAppCallMessage, describeAppCallClose, describeMicError } from '../lib/appCallAudio.js';

test('48 kHz mic audio is downsampled to 16 kHz PCM16', () => {
  const input = new Float32Array(480).fill(0.5);
  const out = floatToPcm16k(input, 48000);
  assert.equal(out.length, 160);
  assert.ok(Math.abs(out[0] - 16383) < 2);
});

test('clipping is clamped and empty input is safe', () => {
  const out = floatToPcm16k(new Float32Array([2, -2, 2, -2]), 16000);
  assert.equal(out[0], 32767);
  assert.equal(out[1], -32768);
  assert.equal(floatToPcm16k(new Float32Array(0), 48000).length, 0);
});

test('a service frame decodes to rate and samples (unaligned-safe)', () => {
  const buf = new ArrayBuffer(4 + 6);
  new DataView(buf).setUint32(0, 24000, true);
  new Int16Array(buf, 4, 3).set([100, -200, 300]);
  const f = decodeAppCallFrame(buf);
  assert.equal(f.rate, 24000);
  assert.deepEqual(Array.from(f.samples), [100, -200, 300]);
  assert.equal(decodeAppCallFrame(new ArrayBuffer(3)), null);
});

test('service messages become plain-language statuses', () => {
  assert.doesNotMatch(describeAppCallMessage({ type: 'error', reason: 'auth-refused' }).text, /SECRET|Vercel|service/i);
  assert.equal(describeAppCallMessage({ type: 'hangup' }).kind, 'ended');
  assert.equal(describeAppCallMessage({ type: 'ready' }).kind, 'info');
  assert.equal(describeAppCallMessage({ type: 'x' }), null);
});

test('closes are explained once, and a normal end is silent', () => {
  assert.doesNotMatch(describeAppCallClose({ opened: false }), /PUBLIC_|wss|Render|service/i);
  assert.equal(describeAppCallClose({ opened: true, ended: true }), null);
  assert.equal(describeAppCallClose({ opened: true, explained: true }), null);
  assert.match(describeAppCallClose({ opened: true, code: 1006 }), /dropped/);
});

test('microphone errors say what to do', () => {
  assert.match(describeMicError({ name: 'NotAllowedError' }), /Allow the microphone/);
  assert.match(describeMicError({ name: 'NotFoundError' }), /No microphone/);
});

// --- stateful mic downsampler -------------------------------------------------------
import { createMicDownsampler } from '../lib/appCallAudio.js';

function wave(n) { const a = new Float32Array(n); for (let i = 0; i < n; i++) a[i] = Math.sin(i / 7) * 0.6 + Math.sin(i / 53) * 0.2; return a; }

for (const rate of [48000, 44100, 32000, 16000]) {
  test(`mic downsampler at ${rate} Hz is identical to resampling the whole stream at once (no per-chunk loss)`, () => {
    const whole = wave(rate * 2);
    const expected = floatToPcm16k(whole, rate);
    const push = createMicDownsampler(rate);
    const parts = [];
    // The worklet delivers 128-sample quanta that are merged to >= 20 ms: 1024 at 48 kHz, 896 at 44.1 kHz.
    const chunk = Math.ceil(rate * 0.02 / 128) * 128;
    for (let o = 0; o < whole.length; o += chunk) parts.push(push(whole.subarray(o, Math.min(whole.length, o + chunk))));
    const got = Int16Array.from(parts.flatMap((p) => Array.from(p)));
    assert.ok(Math.abs(got.length - expected.length) <= 1, `length ${got.length} vs ${expected.length}`);
    for (let i = 0; i < got.length; i++) assert.ok(Math.abs(got[i] - expected[i]) <= 1, `sample ${i}`);
  });
}

test('REGRESSION: the stateless converter loses a sample of every 1024-sample chunk at 48 kHz, the stateful one does not', () => {
  const chunks = 100;
  const stateless = Array.from({ length: chunks }, () => floatToPcm16k(new Float32Array(1024).fill(0.1), 48000).length).reduce((a, b) => a + b, 0);
  const push = createMicDownsampler(48000);
  const stateful = Array.from({ length: chunks }, () => push(new Float32Array(1024).fill(0.1)).length).reduce((a, b) => a + b, 0);
  assert.equal(stateful, Math.floor((chunks * 1024) / 3)); // 34133: every input sample accounted for
  assert.ok(stateless < stateful, `stateless produced ${stateless}, one sample short per chunk`);
});

test('the stateful downsampler clamps clipping and tolerates empty input', () => {
  const push = createMicDownsampler(16000);
  const out = push(new Float32Array([2, -2]));
  assert.equal(out[0], 32767);
  assert.equal(out[1], -32768);
  assert.equal(push(new Float32Array(0)).length, 0);
  assert.equal(push(null).length, 0);
});
