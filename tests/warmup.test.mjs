import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

test('the backends are pinged invisibly the instant the page opens (before app.js)', () => {
  const html = readFileSync('index.html', 'utf8');
  const head = html.slice(0, html.indexOf('</head>'));
  assert.match(head, /window\.__warmBackends = function/);
  assert.match(head, /mode: 'no-cors'/);
  assert.match(head, /audio-call-assistant\.onrender\.com\/healthz/);
  assert.match(head, /wacalls-relay\.onrender\.com/);
  assert.match(head, /audio-call-relay\.onrender\.com/);
  assert.match(head, /4 \* 60 \* 1000/);
  assert.match(head, /window\.__warmBackends\(\);/);
  // Invisible: the ping code must never touch the DOM.
  const script = head.slice(head.indexOf('window.__warmBackends = function'));
  assert.ok(!/document\.|innerHTML|classList|alert\(/.test(script.slice(0, script.indexOf('</script>'))));
});

test('app.js re-pings on return to foreground and never blocks on it', () => {
  const src = readFileSync('app.js', 'utf8');
  assert.match(src, /visibilitychange/);
  assert.match(src, /window\.__warmBackends\?\.\(\)/);
  assert.ok(!/await[^\n]*__warmBackends/.test(src));
});

test('no extra /api function was added (Vercel Hobby allows 12)', () => {
  assert.ok(readdirSync('api').filter((f) => f.endsWith('.js')).length <= 12);
  assert.ok(!/warmup/.test(readFileSync('api/assistant.js', 'utf8')));
});
