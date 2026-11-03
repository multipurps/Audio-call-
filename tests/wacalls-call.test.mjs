import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function load() {
  const sandbox = { setInterval: () => 1, clearInterval: () => {}, console };
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(new URL('../wacalls-call.js', import.meta.url), 'utf8'), sandbox);
  return sandbox.WaCallsFlyCall;
}

function fakeMedia() {
  const m = { opened: [], closed: 0, cfg: null };
  m.configure = (c) => { m.cfg = c; };
  m.open = async (o) => { m.opened.push(o); return m; };
  m.close = () => { m.closed++; };
  m.leg = {};
  return m;
}

function fakeApi(states = []) {
  const calls = [];
  let i = 0;
  const api = async (action, opts = {}) => {
    calls.push({ action, opts });
    if (action === 'whatsapp-fly-call') return { callId: 'c-9', dbCallId: 'db-1' };
    if (action === 'whatsapp-fly-state') {
      const s = states[Math.min(i, states.length - 1)];
      i++;
      if (s instanceof Error) throw s;
      return { state: s };
    }
    if (action === 'whatsapp-fly-webrtc') return { sdp_answer: 'ANS' };
    return { ok: true };
  };
  return { api, calls };
}

test('decideNext: pickup opens media once; ended finishes; silence past the limit is no answer', () => {
  const C = load();
  assert.equal(C.decideNext({ flyState: 'ringing', mediaOpen: false, ringedMs: 1500 }), 'wait');
  assert.equal(C.decideNext({ flyState: 'active', mediaOpen: false, ringedMs: 3000 }), 'open-media');
  assert.equal(C.decideNext({ flyState: 'active', mediaOpen: true, ringedMs: 3000 }), 'wait');
  assert.equal(C.decideNext({ flyState: 'ended', mediaOpen: true, ringedMs: 3000 }), 'finish-ended');
  assert.equal(C.decideNext({ flyState: 'ringing', mediaOpen: false, ringedMs: 90000 }), 'no-answer');
});

test('flow: ring, pick up, media opens exactly once, remote end saves the call once', async () => {
  const C = load();
  const { api, calls } = fakeApi(['ringing', 'active', 'active', 'ended']);
  const media = fakeMedia();
  C.setup({ api, media });
  await C.start({ to: '+2348000000000', name: 'Ada', video: true });
  for (let k = 0; k < 4; k++) await C.state().tick();
  assert.equal(media.opened.length, 1);
  assert.equal(media.opened[0].callId, 'c-9');
  assert.equal(media.opened[0].video, true);
  assert.equal(C.state().phase, 'ended');
  assert.equal(calls.filter((c) => c.action === 'whatsapp-fly-end').length, 1, 'one end request, so the conversation is saved even when the far side ended the call');
  assert.ok(media.closed >= 1);
});

test('signal adapter: the server answer { sdp_answer } reaches the media leg as { sdpAnswer }', async () => {
  const C = load();
  const { api } = fakeApi(['active']);
  const media = fakeMedia();
  C.setup({ api, media });
  await C.start({ to: '1' });
  await C.state().tick();
  const answer = await media.cfg.signal.webrtc('c-9', 'OFFER');
  assert.equal(answer.sdpAnswer, 'ANS');
  await C.end('done');
});

test('a failed state poll is not a hang-up; the next poll still works', async () => {
  const C = load();
  const { api } = fakeApi([new Error('network blip'), 'active']);
  const media = fakeMedia();
  C.setup({ api, media });
  await C.start({ to: '1' });
  await C.state().tick();
  assert.equal(C.state().phase, 'ringing');
  await C.state().tick();
  assert.equal(media.opened.length, 1);
  await C.end('done');
});

test('hang-up: ends on WaCalls and closes media once, even if pressed twice', async () => {
  const C = load();
  const { api, calls } = fakeApi(['active']);
  const media = fakeMedia();
  C.setup({ api, media });
  await C.start({ to: '1' });
  await C.state().tick();
  await C.end('You ended the call.');
  await C.end('again');
  assert.equal(calls.filter((c) => c.action === 'whatsapp-fly-end').length, 1);
  assert.equal(media.closed, 1);
  assert.equal(C.state().phase, 'ended');
});

test('no answer: after the ring limit the call is ended on WaCalls', async () => {
  const C = load();
  const { api, calls } = fakeApi(['ringing']);
  const media = fakeMedia();
  C.setup({ api, media });
  await C.start({ to: '1' });
  for (let k = 0; k < 60; k++) await C.state().tick();
  assert.equal(C.state().phase, 'ended');
  assert.equal(calls.filter((c) => c.action === 'whatsapp-fly-end').length, 1);
  assert.equal(media.opened.length, 0);
});
