// Behavioural tests for lib/appCallPlayback.js, driven by a fake Web Audio clock.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlayback, PLAYBACK_DEFAULTS } from '../lib/appCallPlayback.js';

function fakeCtx() {
  const ctx = {
    currentTime: 0,
    created: [],
    createBuffer(channels, length, rate) {
      if (!(rate >= 3000 && rate <= 768000)) throw new Error('NotSupportedError');
      const data = new Float32Array(length);
      return { duration: length / rate, getChannelData: () => data };
    },
    createBufferSource() {
      const src = {
        buffer: null, startedAt: null, stopped: false, onended: null,
        connect() {}, start(when) { this.startedAt = when; }, stop() { this.stopped = true; },
      };
      ctx.created.push(src);
      return src;
    },
  };
  return ctx;
}

const frame = (ms = 20, rate = 16000) => ({ rate, samples: new Int16Array(Math.round((rate * ms) / 1000)).fill(1000) });
const live = (ctx) => ctx.created.filter((s) => !s.stopped);

function rig(config) {
  const ctx = fakeCtx();
  const speaking = [];
  const pb = createPlayback({ ctx, out: {}, onSpeaking: (v) => speaking.push(v), config });
  return { ctx, pb, speaking };
}

test('a steady paced stream is scheduled back-to-back with no gap, overlap or drop', () => {
  const { ctx, pb } = rig();
  for (let i = 0; i < 100; i++) { ctx.currentTime = i * 0.02; pb.play(frame()); }
  const starts = live(ctx).map((s) => s.startedAt);
  assert.equal(starts.length, 100);
  for (let i = 1; i < starts.length; i++) assert.ok(Math.abs(starts[i] - starts[i - 1] - 0.02) < 1e-9, `gap at frame ${i}`);
  const s = pb.stats();
  assert.equal(s.underruns, 0);
  assert.equal(s.trimmedFrames, 0);
  assert.equal(s.framesIn, s.framesScheduled);
});

test('REGRESSION: a 3 s stall followed by a burst keeps the newest audio (the old code dropped the end of the reply)', () => {
  const { ctx, pb } = rig();
  const total = 300; // 6 s of reply, 20 ms frames
  for (let i = 0; i < total; i++) {
    const t = i * 0.02;
    ctx.currentTime = t >= 1 && t < 4 ? 4 : t; // frames released during the stall arrive at t = 4
    pb.play(frame());
  }
  const s = pb.stats();
  assert.equal(s.framesIn, total);
  // Nothing vanishes without being counted.
  assert.equal(s.framesScheduled, total, 'every frame is scheduled on arrival');
  assert.equal(s.badFrames, 0);
  // The LAST frame of the reply is audible (the old code silently discarded the tail).
  const lastCreated = ctx.created.at(-1);
  assert.equal(lastCreated.stopped, false, 'the last frame of the reply must not be stopped or discarded');
  assert.equal(Math.max(...live(ctx).map((x) => x.startedAt)), lastCreated.startedAt, 'and it is the latest thing scheduled');
  // Only stale, not-yet-started audio was trimmed, and it is accounted for.
  assert.ok(s.resyncs >= 1);
  assert.equal(Math.round(s.trimmedMs), s.trimmedFrames * 20);
  // Latency stays bounded: the schedule never runs further than maxLag ahead.
  assert.ok(s.maxLagMs <= PLAYBACK_DEFAULTS.maxLag * 1000 + 25, `maxLag ${s.maxLagMs}`);
  // Everything that still counts as live is contiguous ahead of the playhead after the resync.
  const tail = live(ctx).slice(-50).map((x) => x.startedAt);
  for (let i = 1; i < tail.length; i++) assert.ok(Math.abs(tail[i] - tail[i - 1] - 0.02) < 1e-9);
});

test('a frozen clock (page suspended) does not pile up stale audio and still plays the newest', () => {
  const { ctx, pb } = rig();
  ctx.currentTime = 10;
  for (let i = 0; i < 400; i++) pb.play(frame()); // 8 s arrives while the context is frozen
  const s = pb.stats();
  assert.equal(s.framesScheduled, 400);
  assert.ok(s.queuedMs <= PLAYBACK_DEFAULTS.maxLag * 1000 + 25);
  const last = live(ctx).at(-1);
  assert.ok(last.startedAt >= 10);
});

test('an underrun re-primes with a full cushion and a mid-sentence one deepens it, up to a ceiling', () => {
  const { ctx, pb } = rig();
  ctx.currentTime = 0; pb.play(frame());
  assert.equal(pb.jitter, PLAYBACK_DEFAULTS.jitterStart);
  ctx.currentTime = 0.5; pb.play(frame()); // 0.28 s late: mid-sentence
  assert.ok(Math.abs(pb.jitter - 0.3) < 1e-9);
  assert.ok(Math.abs(live(ctx).at(-1).startedAt - (0.5 + 0.3)) < 1e-9, 're-primed with the full cushion, not 30 ms');
  for (let i = 0; i < 10; i++) { ctx.currentTime += 1; pb.play(frame(20)); ctx.currentTime += 0.6; pb.play(frame(20)); }
  assert.ok(pb.jitter <= PLAYBACK_DEFAULTS.jitterMax + 1e-9);
  assert.ok(pb.stats().underruns >= 2);
});

test('a long silence (Emysa pausing) re-primes but does not deepen the cushion', () => {
  const { ctx, pb } = rig();
  ctx.currentTime = 0; pb.play(frame());
  ctx.currentTime = 5; pb.play(frame());
  assert.equal(pb.jitter, PLAYBACK_DEFAULTS.jitterStart);
});

test('interrupt stops everything queued, resets the clock, and the next frame starts fresh', () => {
  const { ctx, pb, speaking } = rig();
  for (let i = 0; i < 30; i++) pb.play(frame());
  const before = ctx.created.length;
  pb.clear();
  assert.equal(live(ctx).length, 0, 'all queued sources stopped');
  assert.equal(pb.nextTime, 0);
  assert.equal(speaking.at(-1), false);
  ctx.currentTime = 1;
  pb.play(frame());
  assert.equal(ctx.created.length, before + 1);
  assert.ok(Math.abs(ctx.created.at(-1).startedAt - (1 + PLAYBACK_DEFAULTS.jitterStart)) < 1e-9);
  assert.equal(pb.stats().clears, 1);
});

test('speaking turns on with the first frame and off when the last source ends', () => {
  const { ctx, pb, speaking } = rig();
  pb.play(frame()); pb.play(frame());
  assert.deepEqual(speaking, [true]);
  const [a, b] = ctx.created;
  a.onended(); assert.deepEqual(speaking, [true]);
  b.onended(); assert.deepEqual(speaking, [true, false]);
});

test('corrupt frames are counted and skipped, never thrown into the socket handler', () => {
  const { pb } = rig();
  assert.equal(pb.play(null), false);
  assert.equal(pb.play({ rate: 16000, samples: new Int16Array(0) }), false);
  assert.equal(pb.play({ rate: 1, samples: new Int16Array(10) }), false); // createBuffer rejects the rate
  assert.equal(pb.stats().badFrames, 3);
  assert.equal(pb.play(frame()), true);
});

test('frames of other rates keep exact timing (duration comes from samples / rate)', () => {
  const { ctx, pb } = rig();
  pb.play(frame(20, 24000)); pb.play(frame(20, 16000));
  const [a, b] = ctx.created;
  assert.ok(Math.abs(b.startedAt - a.startedAt - 0.02) < 1e-9);
});
