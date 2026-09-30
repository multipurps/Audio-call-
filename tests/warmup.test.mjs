import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

test('warmup is an action on the existing assistant endpoint (no new /api function)', () => {
  const src = readFileSync('api/assistant.js', 'utf8');
  assert.match(src, /case 'warmup': return warmBackends\(req, res\);/);
  assert.match(src, /ASSISTANT_WARMUP_URL/);
  assert.match(src, /WACALLS_RELAY_URL/);
  // Vercel Hobby allows 12 serverless functions; never exceed it.
  const fns = readdirSync('api').filter((f) => f.endsWith('.js'));
  assert.ok(fns.length <= 12, `api/ has ${fns.length} functions`);
});

test('the app warms the backends on home load and when returning to foreground, throttled', () => {
  const src = readFileSync('app.js', 'utf8');
  assert.match(src, /function warmBackends\(\)/);
  assert.match(src, /action=warmup/);
  assert.match(src, /4 \* 60 \* 1000/);
  assert.match(src, /visibilitychange/);
});
