// Local copy: lists, balance and profile show from localStorage at once, then refresh; the app shell opens offline.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const sw = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');

test('each main list draws from the saved copy first, then replaces it with fresh data', () => {
  for (const url of ["'/api/contacts'", "'/api/calls?action=list'", "'/api/referrals?action=billing'"]) {
    assert.ok(app.includes(`cacheRead(${url})`) || app.includes(`const url = ${url}`) || app.includes(`Url = ${url}`), url);
  }
  assert.match(app, /fetchJsonCached\('\/api\/contacts'\)/);
  assert.match(app, /const url = '\/api\/assistant\?action=sessions&callRelated=true';\n  const apply[\s\S]*cacheRead\(url\)/);
  assert.match(app, /cacheRead\('profile\.header'\)/);
});

test('a failed fetch never wipes what is on screen, and a fresh one always wins', () => {
  assert.match(app, /if \(!resp\?\.ok\) return null;/);
  assert.match(app, /if \(data\) cacheWrite\(url, data\);/);
  assert.match(app, /if \(hit\) return; \/\/ offline: keep showing the saved copy/);
});

test('saved copies are per user and are wiped on sign-out', () => {
  assert.match(app, /return id \? `\$\{CACHE_PREFIX\}\$\{id\}\.\$\{name\}` : null;/);
  assert.match(app, /if \(_event === 'SIGNED_OUT'\) cacheClearAll\(\);/);
});

test('with no connection the app opens as the remembered user instead of the login page', () => {
  assert.match(app, /function enterOffline\(\)/);
  assert.match(app, /_event !== 'SIGNED_OUT' && !navigator\.onLine && !currentUser && enterOffline\(\)/);
  assert.match(app, /window\.addEventListener\('online'/);
});

test('service worker: app code is network-first with a saved fallback, API and version.json are never cached', () => {
  assert.match(sw, /p\.startsWith\('\/api\/'\)/);
  assert.match(sw, /p === '\/version\.json'/);
  assert.match(sw, /Promise\.race\(\[network, slow\]\)/);
  assert.match(sw, /resp\.ok && !resp\.redirected/);
  assert.match(sw, /type !== 'cache-shell'/);
});
