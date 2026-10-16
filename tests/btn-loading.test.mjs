import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SRC = readFileSync(new URL('../btnLoading.js', import.meta.url), 'utf8');

function makeEnv() {
  let clock = 1000;
  const timers = new Map();
  let tid = 0;
  const fetches = [];
  let observerCb = null;
  let clickHandler = null;
  const mkBtn = (text) => {
    const classes = new Set();
    const attrs = {};
    const b = {
      tagName: 'BUTTON', textContent: text, disabled: false, isConnected: true,
      classList: { add: (...c) => c.forEach((x) => classes.add(x)), remove: (...c) => c.forEach((x) => classes.delete(x)), has: (c) => classes.has(c) },
      setAttribute: (k, v) => { attrs[k] = v; }, removeAttribute: (k) => { delete attrs[k]; },
      closest() { return b; }, contains(o) { return o === b; },
      attrs,
    };
    return b;
  };
  const window = {
    fetch: () => new Promise((resolve, reject) => fetches.push({ resolve, reject })),
  };
  const document = {
    documentElement: {},
    addEventListener: (type, fn) => { if (type === 'click') clickHandler = fn; },
  };
  class MO { constructor(cb) { observerCb = cb; } observe() {} }
  const ctx = vm.createContext({
    window, document, MutationObserver: MO, Map, Set, Array, Date: { now: () => clock },
    setTimeout: (fn, ms) => { const id = ++tid; timers.set(id, { fn, at: clock + ms }); return id; },
    clearTimeout: (id) => timers.delete(id),
    Promise, Math,
  });
  vm.runInContext(SRC, ctx);
  const advance = (ms) => {
    clock += ms;
    for (const [id, t] of [...timers]) if (t.at <= clock) { timers.delete(id); t.fn(); }
  };
  const tap = (btn) => clickHandler({ target: btn });
  const setDisabled = (btn, v) => { btn.disabled = v; observerCb([{ target: btn }]); };
  return { window, mkBtn, tap, setDisabled, advance, fetches };
}

test('a tapped button that disables itself shows a spinner until re-enabled', () => {
  const e = makeEnv();
  const b = e.mkBtn('Save');
  e.tap(b);
  e.setDisabled(b, true);
  assert.ok(b.classList.has('isLoading'));
  assert.equal(b.attrs['aria-busy'], 'true');
  assert.ok(!b.classList.has('isLoadingIcon'));
  e.window.fetch('/api/x');
  e.setDisabled(b, false);
  assert.ok(!b.classList.has('isLoading'));
  assert.equal(b.attrs['aria-busy'], undefined);
});

test('icon-only buttons get the centered icon variant', () => {
  const e = makeEnv();
  const b = e.mkBtn('');
  e.tap(b);
  e.setDisabled(b, true);
  assert.ok(b.classList.has('isLoading') && b.classList.has('isLoadingIcon'));
});

test('a button disabled without a tap (e.g. A-Z letters) never gets a spinner', () => {
  const e = makeEnv();
  const b = e.mkBtn('Q');
  e.setDisabled(b, true);
  assert.ok(!b.classList.has('isLoading'));
});

test('a purely local disable (no request) drops the spinner', () => {
  const e = makeEnv();
  const b = e.mkBtn('Done');
  e.tap(b);
  e.setDisabled(b, true);
  assert.ok(b.classList.has('isLoading'));
  e.advance(1600);
  assert.ok(!b.classList.has('isLoading'));
});

test('spinner stops after the request finishes even if the button stays disabled', async () => {
  const e = makeEnv();
  const b = e.mkBtn('Send');
  e.tap(b);
  e.setDisabled(b, true);
  e.advance(10);
  e.window.fetch('/api/y');
  e.advance(1600); // past the no-request watchdog: a request is in flight, spinner stays
  assert.ok(b.classList.has('isLoading'));
  e.fetches[0].resolve({});
  await Promise.resolve(); await Promise.resolve();
  e.advance(700);
  assert.ok(!b.classList.has('isLoading'));
});

test('a different button disabled by the tap does not get the spinner', () => {
  const e = makeEnv();
  const tapped = e.mkBtn('Call');
  const other = e.mkBtn('Cancel');
  e.tap(tapped);
  e.setDisabled(other, true);
  assert.ok(!other.classList.has('isLoading'));
});

test('explicit start/stop API works', () => {
  const e = makeEnv();
  const b = e.mkBtn('Go');
  e.window.btnLoading.start(b);
  assert.ok(b.classList.has('isLoading'));
  e.window.btnLoading.stop(b);
  assert.ok(!b.classList.has('isLoading'));
});

test('helper is loaded by both the app and the admin page', () => {
  assert.match(readFileSync(new URL('../index.html', import.meta.url), 'utf8'), /btnLoading\.js/);
  assert.match(readFileSync(new URL('../admin/index.html', import.meta.url), 'utf8'), /btnLoading\.js/);
});
