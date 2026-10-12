// The Emysa call's playback must not go back to a tiny fixed cushion: that broke the voice up
// whenever a streamed (test / clone) voice delivered a chunk late.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');

test('Emysa call playback starts with a real cushion and re-primes with it after an underrun', () => {
  assert.match(app, /const JITTER_START = 0\.2;/);
  assert.match(app, /call\.jitter = JITTER_START;/);
  assert.match(app, /call\.nextTime = now \+ call\.jitter;/);
  assert.ok(!/now \+ \(call\.nextTime \? 0\.03/.test(app), 'the 30 ms re-prime that chained gaps must stay gone');
});

test('a mid-sentence underrun deepens the cushion, up to a ceiling', () => {
  assert.match(app, /call\.jitter = Math\.min\(JITTER_MAX, call\.jitter \+ JITTER_STEP\);/);
});

test('the listen-in no longer skips the callee once it is only a couple of seconds behind', () => {
  assert.match(app, /const MAX_LAG = 5; /);
});
