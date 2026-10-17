import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SRC = readFileSync(new URL('../callWakeLock.js', import.meta.url), 'utf8');

function makeEnv({ supported = true, denied = false } = {}) {
  const listeners = {};
  const locks = [];
  const warnings = [];
  const doc = {
    visibilityState: 'visible',
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
  };
  const nav = supported ? {
    wakeLock: {
      request: async (type) => {
        if (denied) { const e = new Error('denied'); e.name = 'NotAllowedError'; throw e; }
        const lock = {
          type, released: false, handlers: {},
          release() { this.released = true; (this.handlers.release || []).forEach((f) => f()); return Promise.resolve(); },
          addEventListener(t, f) { (this.handlers[t] ||= []).push(f); },
        };
        locks.push(lock);
        return lock;
      },
    },
  } : {};
  const ctx = { navigator: nav, document: doc, console: { ...console, warn: (...a) => warnings.push(a) } };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  return { api: ctx.window.callWakeLock, ctx, doc, locks, listeners, warnings };
}

test('start requests a screen lock and stop releases it', async () => {
  const env = makeEnv();
  assert.equal(await env.api.start(), true);
  assert.equal(env.locks.length, 1);
  assert.equal(env.locks[0].type, 'screen');
  assert.equal(env.api.isHeld(), true);
  env.api.stop();
  assert.equal(env.locks[0].released, true);
  assert.equal(env.api.isHeld(), false);
});

test('starting twice does not request a second lock', async () => {
  const env = makeEnv();
  await env.api.start();
  await env.api.start();
  assert.equal(env.locks.length, 1);
});

test('a lock the browser releases is re-requested when the page becomes visible', async () => {
  const env = makeEnv();
  await env.api.start();
  // The browser drops the lock when the page is hidden.
  env.locks[0].handlers.release.forEach((f) => f());
  assert.equal(env.api.isHeld(), false);
  env.doc.visibilityState = 'hidden';
  env.listeners.visibilitychange.forEach((f) => f());
  assert.equal(env.locks.length, 1, 'no request while hidden');
  env.doc.visibilityState = 'visible';
  env.listeners.visibilitychange.forEach((f) => f());
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(env.locks.length, 2);
  assert.equal(env.api.isHeld(), true);
});

test('after stop, becoming visible does not re-acquire', async () => {
  const env = makeEnv();
  await env.api.start();
  env.api.stop();
  env.listeners.visibilitychange.forEach((f) => f());
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(env.locks.length, 1);
});

test('a request that resolves after stop is released immediately', async () => {
  const env = makeEnv();
  const pending = env.api.start();
  env.api.stop();
  await pending;
  assert.equal(env.locks.length, 1);
  assert.equal(env.locks[0].released, true);
  assert.equal(env.api.isHeld(), false);
});

test('refused permission is reported and never throws', async () => {
  const env = makeEnv({ denied: true });
  assert.equal(await env.api.start(), false);
  assert.equal(env.api.isHeld(), false);
  assert.equal(env.warnings.length, 1);
});

test('unsupported browser: start and stop are harmless no-ops', async () => {
  const env = makeEnv({ supported: false });
  assert.equal(env.api.supported(), false);
  assert.equal(await env.api.start(), false);
  env.api.stop();
  assert.equal(env.locks.length, 0);
});
