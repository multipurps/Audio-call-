import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');

// The bottom nav keeps its bare icons, and the active tab gets a liquid pill with its title beside the icon.
// These guards exist because the styles were once deleted by an unrelated edit while the script kept running.
test('bottom nav: liquid pill styles and the title-beside-icon rules are present', () => {
  const css = read('styles.css');
  assert.match(css, /\.tabPill\{[^}]*position:absolute/, 'pill styles missing');
  assert.match(css, /\.tabBtn\.active > span:not\(\.tabAvatarRing\)\{[^}]*opacity:1/, 'active title rule missing');
  assert.match(css, /\.tabBtn > span:not\(\.tabAvatarRing\)\{[^}]*max-width:0/, 'inactive tabs must hide their title');
  assert.match(css, /#tabBar\{gap:14px;\}/);
});

test('bottom nav: the pill script is loaded and drives the active tab', () => {
  assert.match(read('index.html'), /<script src="tabpill\.js/);
  const js = read('tabpill.js');
  assert.match(js, /\.tabBtn\.active/);
  assert.match(js, /requestAnimationFrame/);
});

test('bottom nav: a scrim sits under the icons so scrolling content cannot collide with them', () => {
  const css = read('styles.css');
  assert.match(css, /#tabScrim\{[^}]*pointer-events:none/);
  assert.match(css, /#tabScrim\{[^}]*backdrop-filter:blur/);
  const html = read('index.html');
  assert.ok(html.indexOf('id="tabScrim"') > 0 && html.indexOf('id="tabScrim"') < html.indexOf('id="tabBar"'), 'scrim must come before the nav');
});
