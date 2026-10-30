// Render services (free plan) must only be woken by someone opening the app: nothing runs on a schedule,
// and no on-screen poll can keep running forever or in the background.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const app = read('app.js');
const index = read('index.html');

test('nothing is scheduled: no Vercel cron jobs and no scheduled GitHub workflows', () => {
  const vercel = JSON.parse(read('vercel.json'));
  assert.equal(vercel.crons, undefined, 'vercel.json has no crons');
  assert.doesNotMatch(read('vercel.json'), /"crons"|"schedule"/);
  const dir = new URL('../.github/workflows/', import.meta.url);
  if (existsSync(dir)) for (const f of readdirSync(dir)) assert.doesNotMatch(readFileSync(new URL(f, dir), 'utf8'), /^\s*(schedule|cron)\s*:/m, f);
});

test('the Render services never ping themselves or call out on a timer', () => {
  for (const dir of ['server', 'server-social', 'signal-bridge', 'telegram-call-bridge']) {
    const base = new URL(`../${dir}/`, import.meta.url);
    if (!existsSync(base)) continue;
    for (const f of readdirSync(base).filter((n) => n.endsWith('.js') || n.endsWith('.mjs'))) {
      // The Signal bridge serves a small HTML page (LINK_PAGE) whose script polls while a person has that page
      // open; that runs in their browser, not in the service, so it is left out of this check.
      const src = readFileSync(new URL(f, base), 'utf8').replace(/const LINK_PAGE = `[\s\S]*?`;/, '');
      assert.doesNotMatch(src, /fetch\([^)]*RENDER_EXTERNAL_URL/, `${dir}/${f} must not fetch its own URL`);
      // A timer is fine (the social relay has a 6 second wait loop that clears itself); a timer that makes a
      // network request is a keep-alive.
      for (const m of src.matchAll(/setInterval\(/g)) {
        const body = src.slice(m.index, m.index + 400);
        assert.doesNotMatch(body, /fetch\(|https?\.get\(|axios|got\(/, `${dir}/${f}: a timer must not call out`);
      }
    }
  }
});

test('opening the app warms Render once, and re-warms on return only after the services could have slept', () => {
  assert.match(index, /window\.__warmBackends\(\);/);
  assert.match(index, /if \(now - last < 15 \* 60 \* 1000\) return;/);
  assert.doesNotMatch(index, /setInterval/, 'the warm-up has no timer');
  assert.match(app, /visibilitychange/);
  assert.doesNotMatch(app.slice(app.indexOf('__warmBackends') - 400, app.indexOf('__warmBackends') + 400), /setInterval/);
});

test('the WhatsApp link screen poll stops after a few minutes and stays quiet in the background', () => {
  const fn = app.slice(app.indexOf('function watchWhatsappStatus()'), app.indexOf('function watchWhatsappStatus()') + 900);
  assert.match(app, /const LINK_POLL_MAX_MS = 150_000;/);
  assert.match(fn, /Date\.now\(\) - startedAt > LINK_POLL_MAX_MS/);
  assert.match(fn, /if \(document\.hidden\) return;/);
  assert.ok(fn.indexOf('LINK_POLL_MAX_MS') < fn.indexOf('whatsapp-status'), 'the cap is checked before any request');
});

test('the first-run WhatsApp setup poll stops after a few minutes and stays quiet in the background', () => {
  const at = app.indexOf('const waStartedAt = Date.now();');
  assert.ok(at > 0);
  const block = app.slice(at, at + 700);
  assert.match(block, /Date\.now\(\) - waStartedAt > LINK_POLL_MAX_MS/);
  assert.match(block, /clearInterval\(lineWaTimer\)/);
  assert.match(block, /if \(!document\.hidden\) checkWaLinked\(\);/);
});

test('every other link poll that reaches a relay already has an end', () => {
  // Signal: gives up after its own cap. Phone verification: a fixed number of tries.
  assert.match(app, /Date\.now\(\) - startedAt > 150_000|signalPollTimer/);
  assert.match(app, /tries > 45|tries >= 45|45/);
});
