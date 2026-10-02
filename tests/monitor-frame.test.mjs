import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeMonitorFrame } from '../lib/monitorFrame.js';

function frame(direction, rate, samples) {
  const buf = new ArrayBuffer(5 + samples.length * 2);
  const v = new DataView(buf);
  v.setUint8(0, direction);
  v.setUint32(1, rate, true);
  samples.forEach((s, i) => v.setInt16(5 + i * 2, s, true));
  return buf;
}

test('decodes PCM that starts at an odd byte offset (the listen-in silence bug)', () => {
  const f = decodeMonitorFrame(frame(1, 16000, [0, 1000, -1000, 32767]));
  assert.equal(f.direction, 1);
  assert.equal(f.rate, 16000);
  assert.deepEqual([...f.samples], [0, 1000, -1000, 32767]);
});

test('rejects empty or truncated frames', () => {
  assert.equal(decodeMonitorFrame(null), null);
  assert.equal(decodeMonitorFrame(new ArrayBuffer(5)), null);
});
