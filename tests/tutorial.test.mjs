// Guided tutorial engine: tooltip placement, persistence, registration, and the Emysa wiring.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  computePlacement, unionRects, padRect, clamp, tutorialKey, readTutorialState, isCompleted, resetTutorial, register,
} from '../lib/tutorial.js';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const memory = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };
const phone = { left: 0, top: 0, right: 390, bottom: 780 };
const tip = { width: 300, height: 120 };

test('tooltip goes below a target near the top and above one near the bottom', () => {
  const nearTop = computePlacement({ rect: { top: 80, left: 150, width: 90, height: 40 }, tip, bounds: phone });
  assert.equal(nearTop.side, 'bottom');
  assert.ok(nearTop.top >= 80 + 40);
  const nearBottom = computePlacement({ rect: { top: 700, left: 150, width: 90, height: 60 }, tip, bounds: phone });
  assert.equal(nearBottom.side, 'top');
  assert.ok(nearBottom.top + tip.height <= 700);
});

test('tooltip never overflows the screen, even for a target at the corner', () => {
  for (const rect of [
    { top: 10, left: 340, width: 40, height: 40 }, { top: 730, left: 4, width: 40, height: 40 },
    { top: 380, left: 0, width: 30, height: 30 }, { top: 380, left: 360, width: 30, height: 30 },
  ]) {
    const p = computePlacement({ rect, tip, bounds: phone });
    assert.ok(p.left >= 12 && p.left + tip.width <= 390 - 12, `horizontal ${JSON.stringify(rect)}`);
    assert.ok(p.top >= 12 && p.top + tip.height <= 780 - 12, `vertical ${JSON.stringify(rect)}`);
  }
});

test('a preferred side is used when it fits and flipped when it does not', () => {
  const rect = { top: 100, left: 150, width: 90, height: 40 };
  assert.equal(computePlacement({ rect, tip, bounds: phone, side: 'top' }).side, 'bottom'); // no room above
  assert.equal(computePlacement({ rect: { top: 400, left: 150, width: 90, height: 40 }, tip, bounds: phone, side: 'top' }).side, 'top');
});

test('the on-screen keyboard shrinks the usable area', () => {
  const keyboardOpen = { left: 0, top: 0, right: 390, bottom: 400 };
  const p = computePlacement({ rect: { top: 300, left: 100, width: 190, height: 44 }, tip, bounds: keyboardOpen });
  assert.ok(p.top + tip.height <= 400 - 12);
  assert.equal(p.side, 'top');
});

test('when nothing fits it still stays on screen and drops the arrow', () => {
  const huge = { top: 20, left: 20, width: 350, height: 740 };
  const p = computePlacement({ rect: huge, tip, bounds: phone });
  assert.equal(p.fits, false);
  assert.equal(p.arrow, null);
  assert.ok(p.top >= 12 && p.top + tip.height <= 780 - 12);
});

test('no target centres the tooltip', () => {
  const p = computePlacement({ rect: null, tip, bounds: phone });
  assert.equal(p.side, 'center');
  assert.equal(Math.round(p.left), 45);
});

test('arrow points at the target and stays inside the tooltip', () => {
  const p = computePlacement({ rect: { top: 200, left: 330, width: 40, height: 40 }, tip, bounds: phone });
  assert.ok(p.arrow >= 20 && p.arrow <= tip.width - 20);
});

test('rect helpers', () => {
  assert.deepEqual(unionRects([{ top: 10, left: 10, width: 10, height: 10 }, { top: 30, left: 5, width: 10, height: 10 }]), { top: 10, left: 5, width: 15, height: 30 });
  assert.equal(unionRects([{ top: 0, left: 0, width: 0, height: 0 }]), null);
  assert.deepEqual(padRect({ top: 10, left: 10, width: 20, height: 20 }, 6), { top: 4, left: 4, width: 32, height: 32 });
  assert.equal(clamp(5, 10, 3), 10);
});

test('a finished tutorial is not shown again, until its version is bumped or it is reset', () => {
  const storage = memory();
  const o = { userId: 'u1', storage };
  assert.equal(isCompleted('t', { ...o, version: 1 }), false);
  storage.setItem(tutorialKey('t', 'u1'), JSON.stringify({ version: 1, status: 'completed' }));
  assert.equal(isCompleted('t', { ...o, version: 1 }), true);
  assert.equal(isCompleted('t', { ...o, version: 2 }), false);
  assert.equal(isCompleted('t', { userId: 'u2', storage, version: 1 }), false, 'per user');
  storage.setItem(tutorialKey('t', 'u1'), JSON.stringify({ version: 1, status: 'skipped' }));
  assert.equal(isCompleted('t', { ...o, version: 1 }), true, 'skipping counts as done');
  resetTutorial('t', o);
  assert.equal(readTutorialState('t', o), null);
});

test('broken storage never throws', () => {
  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); } };
  assert.equal(readTutorialState('t', { storage: broken }), null);
  assert.equal(isCompleted('t', { storage: broken, version: 1 }), false);
  assert.doesNotThrow(() => resetTutorial('t', { storage: broken }));
});

test('register rejects empty tutorials and steps without text', () => {
  assert.throws(() => register('x', { steps: [] }), /at least one step/);
  assert.throws(() => register('x', { steps: [{ target: '#a' }] }), /needs text/);
  assert.throws(() => register('', { steps: [{ text: 'hi' }] }), /id/);
  assert.doesNotThrow(() => register('x', { steps: [{ text: 'hi' }] }));
});

test('Emysa wiring: first-call tutorial targets elements that exist in index.html', () => {
  const html = read('index.html');
  const app = read('app.js');
  const css = read('styles.css');
  for (const id of ['contactsBtn', 'contactsAddBtn', 'contactEditor', 'addContactBtn', 'briefInput', 'moodFloat', 'sendBtn', 'tutorialBtn']) {
    assert.match(html, new RegExp(`id="${id}"`), `#${id} exists`);
  }
  for (const tab of ['profile', 'chat']) assert.match(html, new RegExp(`class="tabBtn[^"]*" data-tab="${tab}"`));
  assert.match(app, /Tutorial\.register\(FIRST_CALL_TUTORIAL/);
  assert.match(app, /emysa:contact-saved/);
  assert.match(css, /\.tutRoot\{/);
  // The first-call tutorial must not invent minutes/line gates the app already handles.
  assert.doesNotMatch(app.slice(app.indexOf('Tutorial.register(FIRST_CALL_TUTORIAL'), app.indexOf('async function maybeStartFirstCallTutorial')), /homeBalance|needsTopUp\(/);
});

test('copy buttons exist for every page that produces a link', () => {
  const html = read('index.html');
  const app = read('app.js');
  for (const id of ['referralCopyLinkBtn', 'addTimeCopy', 'premiumCopy']) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(app, /copy: \$\('addTimeCopy'\)/);
  assert.match(app, /copy: \$\('premiumCopy'\)/);
});
