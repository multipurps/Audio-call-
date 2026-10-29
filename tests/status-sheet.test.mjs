// The status sheet replaces the browser's native popups, follows every theme, and the light themes are complete.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { blobPath } from '../lib/statusSheet.js';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const app = read('app.js');
const css = read('styles.css');
const html = read('index.html');

test('the badge blob is a closed shape with the requested number of lobes', () => {
  const d = blobPath(100, 100, 80, 8, 0.07, 0, 96);
  assert.match(d, /^M[\d. -]+(L[\d. -]+)+Z$/);
  assert.equal(d.split('L').length, 96);
  const radii = d.slice(1, -1).split('L').map((p) => { const [x, y] = p.split(' ').map(Number); return Math.hypot(x - 100, y - 100); });
  assert.ok(Math.max(...radii) - Math.min(...radii) > 80 * 0.07, 'the edge actually wobbles');
  assert.ok(Math.min(...radii) > 60 && Math.max(...radii) < 100);
});

test('no native alert, confirm or prompt box is left in the app', () => {
  assert.doesNotMatch(app, /[^a-zA-Z.]confirm\(/);
  assert.doesNotMatch(app, /[^a-zA-Z.]prompt\(/);
  assert.doesNotMatch(app, /[^a-zA-Z.]alert\(/);
  assert.match(app, /from '\.\/lib\/statusSheet\.js'/);
});

test('every question the app asks still has its answer handled (a closed sheet means no)', () => {
  const sheet = read('lib/statusSheet.js');
  assert.match(sheet, /const cancelValue = mode === 'confirm' \? false : mode === 'prompt' \? null : undefined;/);
  // destructive asks default to "no" on Escape, the X, the backdrop and a downward drag
  for (const wire of ["close.addEventListener('click', decline)", "backdrop.addEventListener('click', decline)", "e.key === 'Escape'"]) assert.ok(sheet.includes(wire), wire);
});

test('payment and premium results use the success sheet instead of a fading toast', () => {
  assert.match(app, /successSheet\('Premium is on\.'\)/);
  assert.match(app, /successSheet\(`\$\{formatMinutes\(data\.remaining - before\)\} added to your balance\.`\)/);
});

test('all four themes exist: tokens, picker swatches and the browser theme colour', () => {
  assert.match(app, /const THEMES = \{ dark: '#0b0b0b', brave: '#090c0c', cream: '#f3e8d3', white: '#ffffff' \};/);
  for (const t of ['dark', 'brave', 'cream', 'white']) assert.match(html, new RegExp(`class="themeSwatch[^"]*" data-theme="${t}"`), t);
  const block = (name) => css.slice(css.indexOf(`[data-theme="${name}"]{`), css.indexOf('}', css.indexOf(`[data-theme="${name}"]{`)));
  const need = ['--accent', '--on-accent', '--text', '--muted', '--fg-rgb', '--coffee', '--coffee-light', '--coffee-light-rgb', '--panel', '--surface-1', '--surface-2', '--surface-3', '--line', '--dim', '--icon-color', '--glass-bg', '--glass-border', '--sheet-close', '--banner-bg', '--hero-fade', '--status-strip'];
  for (const t of ['cream', 'white']) for (const token of need) assert.ok(block(t).includes(`${token}:`), `${t} defines ${token}`);
});

test('the light themes keep primary buttons dark with light text, and the sheet reads the theme tokens', () => {
  const white = css.slice(css.indexOf('[data-theme="white"]{'));
  assert.match(white, /--accent:#141414;/);
  assert.match(white, /--on-accent:#ffffff;/);
  assert.match(css, /\.stSheet\{[^}]*background:var\(--sheet-bg\)/);
  assert.match(css, /\.stBtn\.primary\{background:var\(--accent\); color:var\(--on-accent\);\}/);
});

test('the call screen stays dark in every theme, and the status bar gets a strip on the light ones', () => {
  assert.match(css, /:root, \[data-theme="cream"\] #callScreen, \[data-theme="white"\] #callScreen\{/);
  assert.match(css, /body::before\{content:""; position:absolute; top:0; left:0; right:0; height:var\(--safe-top\); background:var\(--status-strip\)/);
});

test('animations are switched off for people who ask for reduced motion', () => {
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)\{\s*\.stBackdrop, \.stSheet\{transition:none;\}\s*\.stRoot \*\{animation:none !important;\}/);
});
