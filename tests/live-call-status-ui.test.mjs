// The live-call status UI, state by state. Every state is mapped from the call's
// real status (what the provider reported); nothing here is driven by a timer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { liveCallView, endedCallLabel, formatCallTimer, TERMINAL_STATUSES, CALL_ENDED_LABELS } from '../lib/callStatus.js';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const app = read('app.js');
const html = read('index.html');
const css = read('styles.css');

// ---- 1. dialing / ringing ---------------------------------------------------------------

test('ringing shows only "Ringing" and no timer', () => {
  const v = liveCallView({ status: 'ringing' });
  assert.deepEqual(v.pill, { phase: 'connecting', label: 'Ringing' });
  assert.equal(v.timer, false);
  assert.doesNotMatch(v.pill.label, /\d|:|connect|listen|live/i); // no time, no internal state
});

test('before the provider reports ringing the call says "Calling", never "Ringing"', () => {
  const v = liveCallView({ status: 'queued' });
  assert.equal(v.pill.label, 'Calling');
  assert.equal(v.timer, false);
  assert.equal(liveCallView({}).pill.label, 'Calling'); // unknown/missing status: not "Ringing" either
});

test('no timer text exists while the call is not answered', () => {
  assert.equal(formatCallTimer(null), null);
  assert.equal(formatCallTimer(undefined), null);
  assert.equal(formatCallTimer(NaN), null);
});

// ---- 2. answered ---------------------------------------------------------------------------

test('an answered call shows no "Connected" pill and starts the timer', () => {
  const v = liveCallView({ status: 'in_progress' });
  assert.equal(v.pill, null);
  assert.equal(v.timer, true);
  assert.equal(liveCallView({ status: 'in-progress' }).pill, null);
});

test('the timer counts from the answer, from 00:00, as elapsed mm:ss', () => {
  const t0 = Date.parse('2026-10-07T10:00:00Z');
  assert.equal(formatCallTimer(t0, t0), '00:00');
  assert.equal(formatCallTimer(t0, t0 + 9_000), '00:09');
  assert.equal(formatCallTimer(t0, t0 + 65_000), '01:05');
  assert.equal(formatCallTimer(t0, t0 + 3_725_000), '62:05');
  assert.equal(formatCallTimer(t0, t0 - 5_000), '00:00'); // clock skew never shows a negative time
});

// ---- 3. during the call ----------------------------------------------------------------------

test('a healthy call shows no status text at all; only a mute the user switched on', () => {
  assert.equal(liveCallView({ status: 'in_progress', aiMuted: false }).pill, null);
  assert.deepEqual(liveCallView({ status: 'in_progress', aiMuted: true }).pill, { phase: 'muted', label: 'Emysa muted' });
});

test('no developer, tutorial or connection-state text remains in the live-call UI', () => {
  const shown = [app, html, read('lib/callStatus.js'), read('lib/monitorStatus.js'), read('lib/appCallAudio.js')].join('\n');
  for (const s of ['Now listen', 'listen to both', 'Emysa is now talking', 'is now talking', 'Connected · Live',
    'Connected · Listening', 'Emysa is speaking', 'Listening in - both sides', 'Monitor off', 'Connecting to Emysa']) {
    assert.ok(!shown.includes(s), `still present: ${s}`);
  }
  assert.doesNotMatch(app, /case 'in_progress'[\s\S]{0,40}'Connected'/);
});

// ---- 4. rejected -------------------------------------------------------------------------------

test('a rejected call says "Call rejected", not a generic failure', () => {
  assert.equal(endedCallLabel('rejected'), 'Call rejected');
  assert.notEqual(endedCallLabel('rejected'), endedCallLabel('failed'));
  assert.notEqual(endedCallLabel('rejected'), endedCallLabel('no_answer'));
  assert.ok(TERMINAL_STATUSES.includes('rejected'));
});

test('every other ending keeps its own real label', () => {
  assert.deepEqual(
    { completed: 'Call ended', no_answer: 'No answer', busy: 'Busy', failed: 'Call failed', canceled: 'Call canceled' },
    Object.fromEntries(['completed', 'no_answer', 'busy', 'failed', 'canceled'].map((k) => [k, CALL_ENDED_LABELS[k]])),
  );
  assert.equal(endedCallLabel('ringing'), null); // live states are not "ended"
});

// ---- 5. silenced / DND callee -----------------------------------------------------------------

test('a silenced or Do-Not-Disturb callee is never shown as connected and never starts the timer', () => {
  // Their phone does not ring, so the provider never reports an answer: the row
  // stays ringing/queued, then rings out. At no point is there an answered state.
  for (const status of ['queued', 'ringing']) {
    const v = liveCallView({ status });
    assert.equal(v.timer, false);
    assert.notEqual(v.pill?.label, 'Connected');
  }
  assert.equal(endedCallLabel('no_answer'), 'No answer'); // rang out: not "rejected", not "connected"
});

// ---- wiring in the production screen ------------------------------------------------------------

test('the production call screen uses these states (no parallel hard-coded copies)', () => {
  assert.match(app, /liveCallView\(/);
  assert.match(app, /endedCallLabel\(/);
  assert.match(app, /formatCallTimer\(callAnsweredAtMs\)/);
  assert.doesNotMatch(app, /const CALL_ENDED_LABELS/); // single source of truth is lib/callStatus.js
  assert.doesNotMatch(app, /\$\('callTimer'\)\.textContent = '00:00'/);
});

test('the timer is hidden until answered and the pill starts as "Calling"', () => {
  assert.match(html, /id="callTimer"[^>]*class="[^"]*"|class="callTimer pending" id="callTimer"/);
  assert.doesNotMatch(html, /id="callTimer"[^>]*>\s*0?0:00/);
  assert.match(html, /id="callStatePill"[^>]*>Calling</);
  assert.match(css, /\.callTimer\.pending\{visibility:hidden/);
});

test('the local ringback tone plays only when the provider reports ringing', () => {
  assert.match(app, /if \(st === 'ringing'\) startRingback\(\); else stopRingback\(\);/);
});

// ---- Emysa transcript bubble ---------------------------------------------------------------------

test('Emysa transcript bubble uses the single Emysa blue token and is distinct from the other side', () => {
  assert.equal((css.match(/--emysa-blue:/g) || []).length, 2, 'defined once per theme (dark + brave)');
  assert.match(css, /\.transcriptLine\.ai \.transcriptBubble\{[^}]*background:var\(--emysa-blue\)/);
  assert.match(css, /\.transcriptLine\.ai \.transcriptBubble\{[^}]*color:var\(--on-emysa-blue\)/);
  // The other side keeps its own look, and the blue is not hard-coded anywhere else.
  assert.match(css, /\.transcriptLine\.user \.transcriptBubble\{background:var\(--accent\)/);
  assert.match(css, /\.transcriptLine\.contact \.transcriptBubble\{background:rgba/);
  const hex = css.match(/#0a6fe6/gi) || [];
  assert.equal(hex.length, 2, 'the blue value lives only in the two theme token definitions');
  assert.doesNotMatch(app, /#0a6fe6|emysa-blue/); // no styling in JS: both render paths just set the .ai class
});

test('both transcript render paths mark Emysa lines with the same ai class', () => {
  assert.match(app, /normalizedSpeaker = \(speaker === 'ai' \|\| speaker === 'assistant'\) \? 'ai' : 'user'/);
  assert.match(app, /const roleClass = isAi \? 'ai' : 'caller'/);
});
