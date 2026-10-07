import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  primeAudioSession, reassertAudioSession, pickOutputMode, createCallOutput, watchLifecycle, micNeedsRestart, SESSION_TYPE,
} from '../lib/appCallOutput.js';

// ---- fakes -------------------------------------------------------------------
class Emitter {
  constructor() { this.h = {}; }
  addEventListener(t, f) { (this.h[t] ||= new Set()).add(f); }
  removeEventListener(t, f) { this.h[t]?.delete(f); }
  emit(t) { for (const f of [...(this.h[t] || [])]) f({ type: t }); }
}
class FakeNode {
  constructor(kind, ctx) { this.kind = kind; this.ctx = ctx; this.gain = { value: 1 }; this.to = []; this.stream = { id: 'dest-stream' }; }
  connect(n) { this.to.push(n); this.ctx.edges.push([this, n]); return n; }
  disconnect() { this.to = []; }
}
class FakeCtx extends Emitter {
  constructor() {
    super();
    this.state = 'running'; this.edges = [];
    this.destination = new FakeNode('destination', this);
    this.resumes = 0;
  }
  createGain() { return new FakeNode('gain', this); }
  createMediaStreamDestination() { return new FakeNode('streamdest', this); }
  async resume() { this.resumes++; this.state = 'running'; }
  reaches(from, target, seen = new Set()) {
    if (from === target) return true;
    if (seen.has(from)) return false; seen.add(from);
    return from.to.some((n) => this.reaches(n, target, seen));
  }
}
class FakeAudio extends Emitter {
  constructor() { super(); this.paused = true; this.srcObject = null; this.playCalls = 0; this.failPlay = false; this.style = {}; this.attrs = {}; this.removed = false; }
  setAttribute(k, v) { this.attrs[k] = v; }
  async play() { this.playCalls++; if (this.failPlay) throw Object.assign(new Error('blocked'), { name: 'NotAllowedError' }); this.paused = false; }
  pause() { this.paused = true; }
  remove() { this.removed = true; }
}
function fakeDoc() {
  const doc = new Emitter();
  doc.visibilityState = 'visible';
  doc.elements = [];
  doc.createElement = () => { const e = new FakeAudio(); doc.elements.push(e); return e; };
  doc.body = { appendChild() {} };
  return doc;
}
const flush = () => new Promise((r) => setTimeout(r, 0));

// ---- the root cause: nothing audible may touch ctx.destination -----------------
test('stream mode: reply audio reaches a MediaStream element and NEVER ctx.destination', async () => {
  const ctx = new FakeCtx(); const doc = fakeDoc(); const nav = { audioSession: { type: 'auto' } };
  const out = createCallOutput({ ctx, doc, nav });
  const reply = ctx.createGain(); reply.connect(out.input);                // a buffer source feeds out.input
  const micTap = ctx.createGain(); out.silentSink(micTap);                 // the mic tap's silent sink
  assert.ok(ctx.reaches(reply, out.destination), 'reply audio is delivered to the media-stream destination');
  assert.equal(ctx.reaches(reply, ctx.destination), false, 'reply audio must not use the Web Audio output unit');
  assert.equal(ctx.reaches(micTap, ctx.destination), false, 'the mic sink must not use the Web Audio output unit either');
  assert.equal(ctx.edges.some(([, to]) => to === ctx.destination), false);
  const el = out.element;
  assert.equal(el.srcObject, out.destination.stream);
  assert.equal(el.attrs.playsinline, '');
  assert.equal(el.autoplay, true); assert.equal(el.muted, false); assert.equal(el.volume, 1);
  assert.equal(out.input.gain.value, 1, 'no gain hack: unity gain');
});

test('legacy webaudio mode is explicit opt-in only (for A/B on a phone)', () => {
  assert.equal(pickOutputMode({ getItem: () => null }), 'stream');
  assert.equal(pickOutputMode({ getItem: (k) => (k === 'emysaAudioOut' ? 'webaudio' : null) }), 'webaudio');
  assert.equal(pickOutputMode({ getItem() { throw new Error('storage blocked'); } }), 'stream');
  assert.equal(pickOutputMode(undefined), 'stream');
  const ctx = new FakeCtx();
  const out = createCallOutput({ ctx, doc: fakeDoc(), nav: {}, mode: 'webaudio' });
  assert.ok(ctx.reaches(out.input, ctx.destination));
  assert.equal(out.element, null);
});

// ---- audio session intent ------------------------------------------------------
test('session is declared play-and-record, tolerates browsers without the API', () => {
  const nav = { audioSession: { type: 'auto' } };
  assert.deepEqual(primeAudioSession(nav), { supported: true, type: SESSION_TYPE });
  assert.deepEqual(primeAudioSession({}), { supported: false, type: null });
  const throwing = { audioSession: { get type() { return 'auto'; }, set type(v) { throw new TypeError('nope'); } } };
  assert.doesNotThrow(() => primeAudioSession(throwing));
  assert.equal(reassertAudioSession({ audioSession: { type: 'playback' } }), true, 'corrects a session iOS changed behind our back');
  assert.equal(reassertAudioSession({ audioSession: { type: SESSION_TYPE } }), false);
  assert.equal(reassertAudioSession({}), false);
});

// ---- the lifecycle you test on the phone ---------------------------------------
test('lifecycle: unlocked -> speaking -> lock -> unlock -> keeps playing at the same level', async () => {
  const ctx = new FakeCtx(); const doc = fakeDoc(); const win = new Emitter();
  const nav = { audioSession: { type: 'auto' } };
  primeAudioSession(nav);
  const out = createCallOutput({ ctx, doc, nav });
  const recovered = [];
  const un = watchLifecycle({ doc, win, ctx, output: out, onRecovered: (reason, r) => recovered.push([reason, r.recovered]) });

  // 1-2. call starts with the screen unlocked; the element is started inside the tap
  assert.equal(await out.start('tap'), true);
  assert.equal(out.element.paused, false);
  assert.equal(nav.audioSession.type, SESSION_TYPE);

  // 4. phone locks while Emysa speaks: iOS interrupts the context, pauses the element, flips the session
  doc.visibilityState = 'hidden'; doc.emit('visibilitychange');
  ctx.state = 'interrupted'; ctx.emit('statechange');
  out.element.pause(); out.element.emit('pause');
  nav.audioSession.type = 'playback';
  await flush();
  assert.equal(recovered.length, 0, 'nothing to fight while hidden; the OS owns the session');
  // the element's own pause handler may try to restart; that must not corrupt state
  ctx.state = 'interrupted';

  // 5. unlock
  doc.visibilityState = 'visible'; doc.emit('visibilitychange');
  await flush(); await flush();
  assert.equal(ctx.state, 'running', 'context resumed');
  assert.equal(out.element.paused, false, 'element playing again');
  assert.equal(nav.audioSession.type, SESSION_TYPE, 'session intent re-asserted');
  assert.ok(recovered.some(([r, ok]) => r === 'visible' && ok));

  // 6-7. conversation continues through the SAME graph at unity gain
  assert.equal(out.input.gain.value, 1);
  assert.equal(ctx.edges.some(([, to]) => to === ctx.destination), false);
  un();
  doc.emit('visibilitychange');
  await flush();
  assert.equal(recovered.length >= 1, true);
});

test('pageshow and a context interruption while visible also recover', async () => {
  const ctx = new FakeCtx(); const doc = fakeDoc(); const win = new Emitter();
  const out = createCallOutput({ ctx, doc, nav: { audioSession: { type: SESSION_TYPE } } });
  await out.start('tap');
  const seen = [];
  watchLifecycle({ doc, win, ctx, output: out, onRecovered: (reason) => seen.push(reason) });
  ctx.state = 'interrupted'; ctx.emit('statechange'); await flush(); await flush();
  assert.ok(seen.includes('ctx-interrupted'));
  assert.equal(ctx.state, 'running');
  out.element.pause(); win.emit('pageshow'); await flush(); await flush();
  assert.ok(seen.includes('pageshow'));
  assert.equal(out.element.paused, false);
});

test('a blocked play() does not throw or kill the call and is retried on the next recover', async () => {
  const ctx = new FakeCtx(); const doc = fakeDoc();
  const out = createCallOutput({ ctx, doc, nav: {} });
  out.element.failPlay = true;
  assert.equal(await out.start('tap'), false);
  out.element.failPlay = false;
  const r = await out.recover('visible');
  assert.equal(r.recovered, true);
  assert.equal(out.element.paused, false);
});

test('barge-in is untouched: stopping buffer sources only needs the shared input node', async () => {
  const ctx = new FakeCtx();
  const out = createCallOutput({ ctx, doc: fakeDoc(), nav: {} });
  const sources = [ctx.createGain(), ctx.createGain()];
  sources.forEach((s) => s.connect(out.input));
  sources.forEach((s) => s.disconnect());   // what clearPlayback() effectively does
  assert.equal(sources.some((s) => ctx.reaches(s, out.destination)), false);
  assert.ok(out.element && out.input, 'the output graph stays up for the next reply');
});

test('dispose releases the element and the graph', async () => {
  const ctx = new FakeCtx(); const doc = fakeDoc();
  const out = createCallOutput({ ctx, doc, nav: {} });
  await out.start('tap');
  out.dispose();
  assert.equal(out.element.removed, true); assert.equal(out.element.srcObject, null); assert.equal(out.element.paused, true);
  out.element.emit('pause'); await flush();
  assert.equal(out.element.playCalls, 1, 'a disposed output never restarts itself');
  assert.deepEqual(await out.recover('visible'), { recovered: false });
});

test('mic restart is requested only when the OS ended the track', () => {
  const stream = (states) => ({ getAudioTracks: () => states.map((readyState) => ({ readyState })) });
  assert.equal(micNeedsRestart(stream(['live'])), false);
  assert.equal(micNeedsRestart(stream(['ended'])), true);
  assert.equal(micNeedsRestart(stream([])), true);
  assert.equal(micNeedsRestart(null), true);
});

// ---- guard the call path in app.js so the root cause cannot silently come back ----
test('app.js live-call path never plays through ctx.destination and primes the session before getUserMedia', () => {
  const src = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  const start = src.indexOf('async function startAppCallSession()');
  const end = src.indexOf('// ---------- Call channel: Emysa (voice) / WhatsApp / Telegram / Phone ----------');
  assert.ok(start > 0 && end > start);
  const fn = src.slice(start, end);
  assert.equal(/ctx\.destination/.test(fn.replace(/\/\/.*$/gm, '')), false, 'no ctx.destination in the live call path');
  assert.ok(fn.indexOf('primeAudioSession(') > 0 && fn.indexOf('primeAudioSession(') < fn.indexOf('getUserMedia('), 'session declared before the mic opens');
  assert.ok(fn.indexOf('createCallOutput(') < fn.indexOf('getUserMedia('), 'output (and its element) is created inside the tap, before the mic prompt');
  assert.match(fn, /output\.silentSink\(node\)/);
  assert.match(fn, /watchLifecycle\(/);
  assert.match(fn, /echoCancellation: true/, 'echo cancellation stays on so speaker output cannot feed back');
  assert.doesNotMatch(fn, /gain\.value\s*=\s*(?!1\b|0\b)\d/, 'no gain/volume hack');
});
