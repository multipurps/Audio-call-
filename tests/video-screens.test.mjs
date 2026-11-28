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

test('Xmax error 46008 is explained in English and retried once with the other model', () => {
  assert.match(app, /46008/);
  assert.match(app, /XMAX_MODELS = \['x2_1_1_preview_us', 'x2_1_1_preview_cn'\]/);
  assert.match(app, /xmaxNoModel\(e\) && tryNextModel\(\)/);
});
