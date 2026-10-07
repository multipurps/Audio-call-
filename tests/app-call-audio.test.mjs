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
