import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const rows = [...html.slice(html.indexOf('class="pfTable"'), html.indexOf('id="planList"')).matchAll(/<div class="pfRow(?: pfHead)?">((?:<span>.*?<\/span>)+)<\/div>/g)]
  .map((m) => [...m[1].matchAll(/<span>(.*?)<\/span>/g)].map((x) => x[1]));

test('the Premium table lists exactly what Premium includes', () => {
  assert.deepEqual(rows, [
    ['Feature', 'Free', 'Premium'],
    ['Buy call time', 'Yes', 'Yes'],
    ['Custom voices', '1', '5'],
    ['Import chat', '—', 'Yes'],
    ['Long-term memory', 'Basic', 'Extended'],
  ]);
});

test('the removed rows are gone from the table', () => {
  const table = html.slice(html.indexOf('class="pfTable"'), html.indexOf('id="planList"'));
  for (const gone of ['Standard caller personalities', 'Custom caller personality', 'Advanced Argument Mode', 'Premium voice and emotion controls', 'Call summaries']) {
    assert.ok(!table.includes(gone), gone);
  }
});

test('Import chat is locked for a free account: the entry point and the file picker open Premium, and a server refusal does too', () => {
  assert.match(app, /const importLocked = \(\) => Boolean\(homeBalance\) && !homeBalance\.premium;/);
  const picker = app.slice(app.indexOf('function openImportPicker()'), app.indexOf('function openImportPicker()') + 300);
  assert.match(picker, /if \(importLocked\(\)\) \{ premiumFeatureSheet\('Import chat'\); return; \}/);
  assert.match(app, /\$\('cmFileLabel'\)\.addEventListener\('click', \(e\) => \{\s*if \(!importLocked\(\)\) return;\s*e\.preventDefault\(\);\s*premiumFeatureSheet\('Import chat'\);/);
  // the sheet says it is a Premium feature and its main button opens Premium
  const sheetFn = app.slice(app.indexOf('async function premiumFeatureSheet'), app.indexOf('async function premiumFeatureSheet') + 400);
  assert.match(sheetFn, /confirmLabel: 'Get Premium'/);
  assert.match(sheetFn, /\)\) openPremium\(\);/);
  assert.match(app, /if \(data\.code === 'premium_required'\) err\.premiumRequired = true;/);
  assert.match(app, /if \(err\.premiumRequired\) openPremium\(\);/);
  assert.match(app, /locked \? 'Import chat · Premium' : 'Import chat \(\.txt or \.zip\)'/);
});

test('the locked picker never silently becomes "unlocked" while the plan is unknown: the server still decides', () => {
  // until the balance has loaded the app does not lock, and the server's 403/503 is the authority
  assert.match(app, /Boolean\(homeBalance\) && !homeBalance\.premium/);
});
