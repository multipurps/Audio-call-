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

// The theme's tokens: the shared light block (when it applies) plus the theme's own block.
const themeTokens = (name) => {
  const take = (open) => { const i = css.indexOf(open); return i < 0 ? '' : css.slice(i, css.indexOf('}', i)); };
  return take(`\n[data-theme="${name}"]{`) + take('\n[data-theme="cream"], [data-theme="white"]{');
};
const tok = (name, token) => (themeTokens(name).match(new RegExp(`${token}:\\s*(#[0-9a-fA-F]{6})`)) || [])[1];
const lum = (hex) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const contrast = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };

test('three themes exist: tokens, picker swatches and the browser theme colour', () => {
  assert.match(app, /const THEMES = \{ dark: '#0b0b0b', cream: '#f4ead6', white: '#ffffff' \};/);
  for (const t of ['dark', 'cream', 'white']) assert.match(html, new RegExp(`class="themeSwatch[^"]*" data-theme="${t}"`), t);
  // the red Brave theme is gone, everywhere
  assert.doesNotMatch(html, /data-theme="brave"/);
  assert.doesNotMatch(css, /data-theme="brave"/);
  assert.doesNotMatch(app, /brave/i);
  assert.doesNotMatch(readFileSync(new URL('../admin/admin.js', import.meta.url), 'utf8'), /brave/i);
  const need = ['--accent', '--on-accent', '--text', '--muted', '--fg-rgb', '--coffee', '--coffee-light', '--coffee-light-rgb', '--panel', '--surface-1', '--surface-2', '--surface-3', '--line', '--dim', '--icon-color', '--glass-bg', '--glass-border', '--sheet-close', '--banner-bg', '--status-strip'];
  for (const t of ['cream', 'white']) for (const token of need) assert.ok(themeTokens(t).includes(`${token}:`), `${t} defines ${token}`);
});

test('the light themes are cream and white with no black, and stay readable', () => {
  for (const t of ['cream', 'white']) {
    const block = themeTokens(t);
    // no black or near-black ink, fill or surface in a light theme (the status strip behind the clock is the one exception)
    for (const hex of block.match(/#[0-9a-fA-F]{6}\b/g)) {
      if (hex.toLowerCase() === '#0b0b0b') continue; // --status-strip
      assert.ok(lum(hex) > 0.03, `${t} has a black or near-black value ${hex}`); // the old espresso #2b211b is 0.017; cocoa #4a3a2b is 0.045
    }
    const text = tok(t, '--text'), accent = tok(t, '--accent'), onAccent = tok(t, '--on-accent'), page = tok(t, '--coffee');
    assert.ok(contrast(text, page) >= 7, `${t}: text on the page is ${contrast(text, page).toFixed(1)}:1`);
    assert.ok(contrast(onAccent, accent) >= 4.5, `${t}: button text on the accent is ${contrast(onAccent, accent).toFixed(1)}:1`);
    assert.ok(contrast(accent, page) >= 4.5, `${t}: accent text on the page is ${contrast(accent, page).toFixed(1)}:1`);
  }
  // Cream is a cream page with white cards; White is a white page with cream cards
  assert.equal(tok('cream', '--coffee'), '#f4ead6');
  assert.equal(tok('cream', '--coffee-light'), '#fffdf8');
  assert.equal(tok('white', '--coffee'), '#ffffff');
  assert.equal(tok('white', '--coffee-light'), '#f7f0e2');
  // the sheet and its primary button read the theme tokens
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
