// The Emysa call's playback must not go back to a tiny fixed cushion (that broke the voice up
// whenever a streamed voice delivered a chunk late), and must never silently discard audio.
// Behaviour is tested in app-call-playback-scheduler.test.mjs; this file pins the wiring.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PLAYBACK_DEFAULTS } from '../lib/appCallPlayback.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const app = read('../app.js');
const trainer = read('../admin/trainerCall.js');

test('Emysa call playback starts with a real cushion that deepens mid-sentence, up to a ceiling', () => {
  assert.equal(PLAYBACK_DEFAULTS.jitterStart, 0.2);
  assert.equal(PLAYBACK_DEFAULTS.jitterStep, 0.1);
  assert.equal(PLAYBACK_DEFAULTS.jitterMax, 0.6);
});

test('the in-app call, the training call and both listen-in lanes all use the one shared scheduler', () => {
  assert.match(app, /import \{ createPlayback \} from '\.\/lib\/appCallPlayback\.js'/);
  assert.match(trainer, /import \{ createPlayback \} from '\.\.\/lib\/appCallPlayback\.js'/);
  assert.equal((app.match(/createPlayback\(/g) || []).length, 3, 'in-app call + two listen-in lanes');
  assert.match(trainer, /createPlayback\(/);
});

test('no call site keeps a private scheduler that throws away the newest audio when behind', () => {
  assert.ok(!/nextTime > now \+ MAX_LAG\) return/.test(app), 'old in-app / listen-in drop');
  assert.ok(!/nextTime > now \+ 2\.5\) return/.test(trainer), 'old training-call drop');
  assert.ok(!/createBufferSource\(\)/.test(trainer), 'training call schedules through the shared module');
});

test('the listen-in lanes keep their wider cap: a late word beats a missing one', () => {
  assert.match(app, /maxLag: 5/);
});

test('the in-app call draws pushed transcript turns at once, by line index, with the poll only as a slow fallback', () => {
  assert.match(app, /msg\?\.type === 'transcript' && Number\.isFinite\(msg\.seq\)\) \{ showLine\(msg\.seq - 1/);
  assert.match(app, /setInterval\(pollTranscript, 3000\)/);
  assert.ok(!/setInterval\(pollTranscript, 1200\)/.test(app), 'the 1.2 s poll was the main transcript path');
});
