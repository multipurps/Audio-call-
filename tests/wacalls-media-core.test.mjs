import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// The core is a plain browser script; load it into a sandbox and read what it exposes.
const sandbox = { };
vm.createContext(sandbox);
vm.runInContext(readFileSync(new URL('../wacalls-media-core.js', import.meta.url), 'utf8'), sandbox);
const C = sandbox.WaCallsMediaCore;

test('video frame: encodes flags, rotation and a big-endian timestamp, then decodes back', () => {
  const payload = new Uint8Array([0, 0, 0, 1, 0x65, 0xaa]);
  const framed = C.encodeVideoFrame({ keyframe: true, timestampMs: 0x01020304, rotationDeg: 90, payload });
  assert.deepEqual([...framed.slice(0, 5)], [1 | (1 << 1), 1, 2, 3, 4]);
  const back = C.decodeVideoFrame(framed);
  assert.equal(back.keyframe, true);
  assert.equal(back.rotationDeg, 90);
  assert.equal(back.timestampMs, 0x01020304);
  assert.deepEqual([...back.payload], [...payload]);
});

test('video frame: rotation wraps and a non-keyframe has bit0 clear', () => {
  const framed = C.encodeVideoFrame({ keyframe: false, timestampMs: 5, rotationDeg: 270, payload: new Uint8Array(7) });
  assert.equal(framed[0], 3 << 1);
  assert.equal(C.decodeVideoFrame(framed).keyframe, false);
  assert.equal(C.decodeVideoFrame(framed).rotationDeg, 270);
});

test('video frame: the 1-byte keyframe request is a control frame; short frames are rejected', () => {
  assert.equal(C.decodeVideoFrame(new Uint8Array([0x01])).control, 'keyframe');
  assert.equal(C.decodeVideoFrame(new Uint8Array([0, 0, 0, 0, 0])), null);
});

test('pcm: odd byte offsets are copied into an aligned Int16Array', () => {
  const big = new Uint8Array([9, 0x00, 0x80, 0xff, 0x7f]);
  const view = big.subarray(1); // starts at an odd offset
  const s = C.pcmToInt16(view);
  assert.equal(s.length, 2);
  assert.equal(s[0], -32768);
  assert.equal(s[1], 32767);
});

test('mic float -> s16le: muted gives silence, full scale is clamped', () => {
  assert.deepEqual([...C.floatToInt16(new Float32Array([1, -1, 0.5]), true)], [0, 0, 0]);
  const loud = C.floatToInt16(new Float32Array([2, -2]), false);
  assert.equal(loud[0], 32767);
  assert.equal(loud[1], -32768);
});

test('annex-B: keyframe detection finds IDR (5) and SPS (7), not plain slices', () => {
  assert.equal(C.annexBHasKeyframe(new Uint8Array([0, 0, 0, 1, 0x65, 1, 2, 3, 4])), true);
  assert.equal(C.annexBHasKeyframe(new Uint8Array([0, 0, 1, 0x67, 1, 2, 3, 4])), true);
  assert.equal(C.annexBHasKeyframe(new Uint8Array([0, 0, 0, 1, 0x41, 1, 2, 3, 4])), false);
});

test('AVCC -> Annex-B: length-prefixed NALs become start-code NALs, keyframes get SPS/PPS first', () => {
  // avcC: lengthSize 4, one SPS (0x67 0x42), one PPS (0x68 0xce)
  const desc = new Uint8Array([1, 0x42, 0, 0x1f, 0xff, 0xe1, 0, 2, 0x67, 0x42, 1, 0, 2, 0x68, 0xce]);
  const avcc = new Uint8Array([0, 0, 0, 3, 0x65, 1, 2]);
  const out = C.avccToAnnexB(avcc, desc, true);
  assert.deepEqual([...out], [0, 0, 0, 1, 0x67, 0x42, 0, 0, 0, 1, 0x68, 0xce, 0, 0, 0, 1, 0x65, 1, 2]);
  assert.equal(C.avccToAnnexB(new Uint8Array([0, 0, 0, 9, 1]), desc, false), null, 'a bad length returns null');
});

test('toAnnexBAccessUnit: Annex-B passes through; a keyframe without SPS/PPS gets them added', () => {
  const desc = new Uint8Array([1, 0x42, 0, 0x1f, 0xff, 0xe1, 0, 2, 0x67, 0x42, 1, 0, 2, 0x68, 0xce]);
  const plain = new Uint8Array([0, 0, 0, 1, 0x41, 9]);
  assert.equal(C.toAnnexBAccessUnit(plain, { keyframe: false, desc }), plain);
  const key = new Uint8Array([0, 0, 0, 1, 0x65, 9]);
  const withPs = C.toAnnexBAccessUnit(key, { keyframe: true, desc });
  assert.equal(withPs[4], 0x67);
  assert.equal(withPs.length, key.length + 4 + 2 + 4 + 2);
});

test('crop and fit: cover fills without stretching; contain shows all of it, centred', () => {
  // 1920x1080 source into a 480x640 portrait canvas: cover crops the sides
  const c = C.coverCrop(1920, 1080, 480, 640);
  assert.ok(Math.abs(c.sw / c.sh - 480 / 640) < 1e-9, 'crop keeps the canvas proportions');
  assert.equal(c.sy, 0);
  // same source contained: letterboxed, proportions kept
  const f = C.containFit(1920, 1080, 480, 640);
  assert.ok(Math.abs(f.dw / f.dh - 1920 / 1080) < 1e-9, 'contain keeps the source proportions');
  assert.equal(f.dw, 480);
  assert.ok(f.dy > 0);
});

test('greeting: waits for the connect time plus the delay, never negative', () => {
  assert.equal(C.greetingWaitMs(0, 1000), 5000, 'not connected yet: full delay');
  assert.equal(C.greetingWaitMs(1000, 1000), 5000);
  assert.equal(C.greetingWaitMs(1000, 4000), 2000);
  assert.equal(C.greetingWaitMs(1000, 9000), 0);
});
