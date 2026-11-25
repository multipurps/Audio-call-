import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Anam appends /chat/completions to the URL it is given, so the app must answer on all of these.
const vercel = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
const route = vercel.routes.find((r) => r.dest === '/api/assistant?action=anam-llm');
for (const path of ['/anam-llm', '/anam-llm/chat/completions', '/anam-llm/v1/chat/completions', '/anam-llm/']) {
  test(`vercel routes ${path} to the brain`, () => assert.ok(new RegExp(`^${route.src}$`).test(path)));
}
test('fly server routes the same paths', () => {
  const src = readFileSync(new URL('../fly-server.mjs', import.meta.url), 'utf8');
  const m = src.match(/if \((\/\^\\\/anam-llm[^\n]*?\/)\.test\(p\)\)/);
  assert.ok(m, 'anam-llm route found in fly-server.mjs');
  const re = eval(m[1]);
  for (const p of ['/anam-llm', '/anam-llm/chat/completions', '/anam-llm/v1/chat/completions']) assert.ok(re.test(p), p);
});
