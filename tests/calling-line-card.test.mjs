// The Calling lines row on Connected accounts shows a connected number itself, like Telegram / WhatsApp.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { callingLineCardView, removeLineConfirm, lineIsUsable } from '../lib/callingLineCard.js';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const app = read('app.js');
const html = read('index.html');

test('a verified number is shown as "Connected as <number>" with a Remove button', () => {
  const v = callingLineCardView({ line: { status: 'verified', mode: 'own', phoneNumber: '+15305740633' }, channels: { phone: true } });
  assert.deepEqual(v, { connected: true, title: 'Connected as +15305740633', sub: 'Your calling number', action: 'Remove' });
});

test('a rented number says so and offers Release', () => {
  const v = callingLineCardView({ line: { status: 'rented', mode: 'rent', phoneNumber: '+14155550101' } });
  assert.equal(v.title, 'Connected as +14155550101');
  assert.equal(v.sub, 'Rented number');
  assert.equal(v.action, 'Release');
});

test('no number, a number still being verified, or an unloaded state is not "connected"', () => {
  for (const line of [null, undefined, { status: 'pending', phoneNumber: '+15305740633', mode: 'own' }, { status: 'failed', phoneNumber: '+1' }, { status: 'verified' }]) {
    const v = callingLineCardView({ line, channels: {} });
    assert.equal(v.connected, false);
    assert.equal(v.title, 'Calling lines');
    assert.equal(v.action, null);
    assert.equal(v.sub, 'Not set up yet');
  }
  assert.equal(callingLineCardView({ line: null, channels: { whatsapp: true } }).sub, 'WhatsApp');
  assert.equal(lineIsUsable({ status: 'pending' }), false);
});

test('removing asks the right question for an own versus a rented number', () => {
  assert.deepEqual(removeLineConfirm({ mode: 'own' }), { title: 'Remove your verified number?', message: '', confirmLabel: 'Remove', destructive: true });
  assert.deepEqual(removeLineConfirm({ mode: 'rent' }), { title: 'Release your rented number?', message: 'You will lose it.', confirmLabel: 'Release', destructive: true });
});

test('a connected row never opens the Set Up Calling page; an unconnected one does', () => {
  assert.match(app, /if \(callingLineCardView\(\{ line: lineState\.line, channels: lineState\.channels \|\| \{\} \}\)\.connected\) return;/);
  assert.match(app, /\$\('callingLinesBtn'\)\.classList\.toggle\('linkCard', !view\.connected\)/);
  assert.match(app, /\$\('callingLinesChevron'\)\.classList\.toggle\('hidden', view\.connected\)/);
});

test('Remove on the row and Remove on the setup page share one routine, and the row refreshes after', () => {
  assert.match(app, /async function removeCallingLine\(\)/);
  assert.match(app, /await lineApi\('line-remove'[^)]*\);\n\s+await loadLineState\(\); \/\/ re-renders the row/);
  assert.match(app, /\$\('callingLinesActionBtn'\)\.addEventListener\('click', async \(e\) => \{\n\s+e\.stopPropagation\(\);/);
  assert.match(app, /if \(await removeCallingLine\(\)\) showLineSetup\(\)/);
  assert.match(app, /showToast\(err\.message\)/);
});

test('the row has a title, a subtitle, a Remove button and a chevron, and the sheet refreshes the line on open', () => {
  for (const id of ['callingLinesTitle', 'callingLinesSub', 'callingLinesActionBtn', 'callingLinesChevron']) assert.ok(html.includes(`id="${id}"`), id);
  assert.match(app, /openSheet\('sheet-social-calling'\); loadSocialAccounts\(\); loadLineState\(\);/);
  assert.ok(!html.includes('Phone number and WhatsApp'));   // the old generic subtitle
});
