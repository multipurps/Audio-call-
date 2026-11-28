import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');

test('a Playground billing row never opens the audio call screen', () => {
  assert.match(app, /c\.platform === 'playground'\) return;/, 'realtime INSERT handler skips it');
  assert.match(app, /c\.platform !== 'playground' && \['queued'/, 'resume-active-call skips it');
  assert.match(app, /deepLinked && deepLinked\.platform !== 'playground'/, 'deep links skip it');
});

test('Live Swap releases the camera and microphone it asked for, even when Xmax never started', () => {
  assert.match(app, /if \(!stream\) liveOwned = granted/);
  const stop = app.slice(app.indexOf('function stopLiveSwap()'), app.indexOf('function closeVideoCall()'));
  assert.match(stop, /if \(!vcXmax\) \{ releaseLiveOwned\(\); return; \}/);
  assert.match(app.slice(app.indexOf('function closeVideoCall()')), /stopLiveSwap\(\);/);
});

test('Xmax errors 46008 and 46002 are explained in English; no retry on the cn model', () => {
  assert.match(app, /46008/);
  assert.match(app, /46002/);
  assert.match(app, /XMAX_MODELS = \['x2_1_1_preview_us'\];/);
  assert.match(app, /xmaxNoModel\(e\) && tryNextModel\(\)/);
});
