// A screen opened FROM a sheet must appear on top of it. Reproduces the two reported bugs against the real
// index.html markup and styles.css: Get Premium on the Voice page, and Calling lines on Connected accounts
// (the Verify Your Number screen) both opened underneath the sheet and only showed once it was closed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { installOverlayStacking, stackedZ, Z_MAX, OVERLAY_SELECTOR } from '../lib/overlayStack.js';

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const html = read('index.html');
const css = read('styles.css');
const app = read('app.js');

async function page() {
  const dom = new JSDOM(html, { pretendToBeVisual: true });
  const { document, window } = dom.window;
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);
  // The signed-in app: the sign-in screen (visible at first load) has been hidden, as enterApp() does.
  document.getElementById('authScreen').classList.add('hidden');
  installOverlayStacking(document, window);
  const z = (id) => Number(document.getElementById(id).style.zIndex) || Number(window.getComputedStyle(document.getElementById(id)).zIndex) || 0;
  const open = async (id) => { document.getElementById(id).classList.remove('hidden'); await tick(); };
  const close = async (id) => { document.getElementById(id).classList.add('hidden'); await tick(); };
  const closeAll = () => document.querySelectorAll('.sheetScreen').forEach((s) => s.classList.add('hidden'));
  const inline = (id) => document.getElementById(id).style.zIndex;
  return { document, window, z, open, close, closeAll, inline };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

test('the CSS alone is the reported bug: Premium (120) and sign-in (100) sit below a sheet (150)', async () => {
  const { z } = await page();
  assert.equal(z('premiumScreen'), 120);
  assert.equal(z('authScreen'), 100);
  assert.equal(z('sheet-voice'), 150);
  assert.equal(z('callScreen'), 200);
});

test('Get Premium on the Voice page opens ABOVE the Voice page, and closing it returns to the Voice page', async () => {
  const { z, open, close, document } = await page();
  await open('sheet-voice');
  await open('premiumScreen');
  assert.ok(z('premiumScreen') > z('sheet-voice'), `premium ${z('premiumScreen')} must be above the voice sheet ${z('sheet-voice')}`);
  await close('premiumScreen');
  assert.ok(!document.getElementById('sheet-voice').classList.contains('hidden'), 'the Voice page is still there underneath');
});

test('Calling lines on Connected accounts opens the Verify screen ABOVE the sheet', async () => {
  const { z, open, close, inline } = await page();
  await open('sheet-social-calling');
  await open('authScreen');
  assert.ok(z('authScreen') > z('sheet-social-calling'));
  await close('authScreen');
  assert.equal(inline('authScreen'), '', 'the override is removed when it closes');
});

test('Terms opened from the Premium screen sits above it, so those links still work', async () => {
  const { z, open, document } = await page();
  await open('sheet-voice');
  await open('premiumScreen');
  // openSheet() hides the other sheets and shows the new one
  document.getElementById('sheet-voice').classList.add('hidden');
  await open('sheet-terms');
  assert.ok(z('sheet-terms') > z('premiumScreen'));
});

test('with nothing else open, nothing changes: Premium and sign-in keep their own layer', async () => {
  const { z, open, inline } = await page();
  await open('premiumScreen');
  assert.equal(inline('premiumScreen'), '');
  assert.equal(z('premiumScreen'), 120);
  const p2 = await page();
  await p2.open('authScreen');
  assert.equal(p2.inline('authScreen'), '', 'the login screen stays under the cookie banner as before');
});

test('the Add time screen also opens above a sheet', async () => {
  const { z, open } = await page();
  await open('sheet-referrals');
  await open('addTimeScreen');
  assert.ok(z('addTimeScreen') > z('sheet-referrals'));
});

test('whichever opens last is on top, through any sequence, and never above the call screen', async () => {
  const { z, open, close, document } = await page();
  const ids = ['sheet-voice', 'premiumScreen', 'sheet-terms', 'authScreen', 'addTimeScreen', 'sheet-help'];
  const opened = [];
  for (const id of ids) {
    await open(id);
    for (const earlier of opened) assert.ok(z(id) > z(earlier), `${id} above ${earlier}`);
    opened.push(id);
  }
  for (const id of ids) assert.ok(z(id) < z('callScreen'), `${id} below the in-call screen`);
  assert.ok(Math.max(...ids.map(z)) <= Z_MAX);
  for (const id of [...ids].reverse()) await close(id);
  for (const id of ids) assert.equal(document.getElementById(id).style.zIndex, '', id);
});

test('stackedZ: one level above the highest visible overlay, capped, and nothing when alone', () => {
  assert.equal(stackedZ([]), null);
  assert.equal(stackedZ([150]), 151);
  assert.equal(stackedZ([100]), 150, 'never below the sheet layer');
  assert.equal(stackedZ([150, 155, 152]), 156);
  assert.equal(stackedZ([189]), 190);
  assert.equal(stackedZ([190]), 190);
});

test('every overlay kind is covered, and the app really installs it', () => {
  assert.equal(OVERLAY_SELECTOR, '.sheetScreen, .addTimeScreen, #authScreen');
  assert.match(app, /^import \{ installOverlayStacking \} from '\.\/lib\/overlayStack\.js';$/m);
  assert.match(app, /^installOverlayStacking\(\);$/m);
  // every full-screen overlay in the markup is one of the covered kinds
  const { document } = new JSDOM(html).window;
  const covered = new Set(document.querySelectorAll(OVERLAY_SELECTOR));
  for (const el of document.querySelectorAll('[role="dialog"].addTimeScreen, .sheetScreen, #authScreen')) assert.ok(covered.has(el), el.id);
});
