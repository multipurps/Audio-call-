import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CLIP_MIN_SECONDS, CLIP_MAX_SECONDS } from '../lib/voiceClip.js';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const pane = html.slice(html.indexOf('id="voicePaneCustom"'), html.indexOf('id="voicePaneLive"'));

test('the Custom voice page is the clean layout: hint, Add New Voice, Record and Upload', () => {
  assert.match(pane, /A voice you create from a recording\. Emysa speaks as you\./);
  assert.match(pane, /Add New Voice/);
  assert.match(pane, /id="recordVoiceBtn"[^>]*>Record</);
  assert.match(pane, /id="uploadVoiceBtn"[^>]*>Upload</);
});

test('the old clutter is gone: no name field, consent checkbox, native file picker or Clone button', () => {
  for (const id of ['cloneName', 'cloneConsent', 'cloneBtn']) assert.ok(!html.includes(`id="${id}"`), id);
  assert.ok(!pane.includes('Clone your voice'));
  assert.ok(!pane.includes('type="checkbox"'));
  // the file input stays, but hidden: Upload opens it
  assert.match(pane, /id="cloneFile"[^>]*style="display:none;"/);
});

test('the page says how much audio is needed, and the numbers come from the clip rules', () => {
  assert.match(pane, /id="voiceNeeds"[^>]*>[^<]*<b>5 to 15 seconds<\/b>/);
  assert.equal(CLIP_MAX_SECONDS, 15);
  assert.equal(CLIP_MIN_SECONDS, 3);
  assert.match(app, /Needs <b>5 to \$\{CLIP_MAX_SECONDS\} seconds<\/b>[^`]*\$\{CLIP_MIN_SECONDS\} seconds is the minimum/);
});

test('recording shows a live timer against the 15 second cap and stops by itself', () => {
  assert.match(app, /Stop · \$\{fmtClock\(sec\)\} \/ \$\{fmtClock\(CLIP_MAX_SECONDS\)\}/);
  assert.match(app, /if \(sec >= CLIP_MAX_SECONDS\) stopVoiceRecording\(\)/);
  assert.match(app, /Record at least \$\{CLIP_MIN_SECONDS\} seconds/);
});

test('leaving the Custom tab mid-recording releases the microphone', () => {
  assert.match(app, /function showVoiceTab\(which\) \{\n  if \(which !== 'custom'\) cancelVoiceRecording\(\);/);
  assert.match(app, /stream\.getTracks\(\)\.forEach\(\(t\) => t\.stop\(\)\)/);
});

test('an empty Custom page shows no "no voices yet" sentence', () => {
  assert.ok(!app.includes('You have no custom voices yet'));
});

test('every code shown on a page has a Copy button', () => {
  // value element -> its copy button
  const pairs = {
    lineCodeValue: 'lineCodeCopy',            // Verify Your Number
    whatsappPairingCodeValue: 'whatsappPairingCopy', // Connected accounts > WhatsApp
    waCodeValue: 'waCodeCopy',                // Link WhatsApp (first-time setup)
  };
  for (const [value, copy] of Object.entries(pairs)) {
    assert.ok(html.includes(`id="${value}"`), value);
    assert.ok(html.includes(`id="${copy}"`), copy);
  }
  assert.match(html, /id="whatsappPairingCopy"[^>]*data-copy-from="whatsappPairingCodeValue"/);
  assert.match(html, /id="lineCodeCopy"[^>]*data-copy-from="lineCodeValue"/);
  assert.match(html, /id="referralCopyBtn"/); // Referrals
  // the shared handler copies the raw code, and the pages that show a code store it
  assert.match(app, /document\.querySelectorAll\('\[data-copy-from\]'\)/);
  assert.match(app, /\$\('whatsappPairingCodeValue'\)\.dataset\.code = code;\n  \$\('whatsappPairingCopy'\)\.disabled = !code;/);
  assert.match(app, /\$\('lineCodeValue'\)\.dataset\.code = line\.validationCode \|\| '';/);
});
