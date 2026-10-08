import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const css = read('styles.css');
const html = read('index.html');

test('the back button is pinned to the top of the screen, not to the centred panel', () => {
  const rule = css.match(/\.authBack\{[^}]*\}/)[0];
  assert.match(rule, /position:fixed/);
  assert.match(rule, /top:calc\(env\(safe-area-inset-top, 0px\) \+ 14px\)/); // clears the status bar / notch
  assert.doesNotMatch(rule, /top:20px/);
});

test('the WhatsApp number screen says "Input your WhatsApp number"', () => {
  assert.match(html, /<div class="authSub">Input your WhatsApp number<\/div>/);
  assert.ok(!html.includes('Enter the number on your WhatsApp'));
});
