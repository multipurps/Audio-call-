import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CLIP_MIN_SECONDS, CLIP_MAX_SECONDS } from '../lib/voiceClip.js';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const pane = html.slice(html.indexOf('id="voicePaneCustom"'), html.indexOf('id="voicePaneLive"'));

test('the Custom voice page is clean: one intro line and a create card with Record and Upload', () => {
  assert.match(pane, /A voice you create from a recording\. Emysa speaks as you\./);
  assert.match(pane, /class="voiceCreateTitle">Create your voice</);
  assert.match(pane, /id="recordVoiceBtn"[^>]*>Record</);
  assert.match(pane, /id="uploadVoiceBtn"[^>]*>Upload</);
  // no "+ Add New Voice" row, no redundant "Voice" label above the intro, no slot counter
  assert.ok(!pane.includes('Add New Voice'));
  assert.ok(!pane.includes('sectionLabel'));
  assert.ok(!pane.includes('voiceSlots'));
  assert.doesNotMatch(app, /Custom voices: /);
  assert.doesNotMatch(app, /\$\('voiceSlots'\)/);
});

test('cloning shows one state, on the button, rather than the same words twice', () => {
  assert.ok(!app.includes("'Reading your clip…'"));
  assert.ok(!app.includes("'Cloning your voice…'"));
  assert.match(app, /setBtnLoading\(btn, true, 'Cloning…'\);/);
});

test('the old clutter is gone: no name field, consent checkbox, native file picker or Clone button', () => {
  for (const id of ['cloneName', 'cloneConsent', 'cloneBtn']) assert.ok(!html.includes(`id="${id}"`), id);
  assert.ok(!pane.includes('Clone your voice'));
  assert.ok(!pane.includes('type="checkbox"'));
  // the file input stays, but hidden: Upload opens it
  assert.match(pane, /id="cloneFile"[^>]*style="display:none;"/);
});

test('the page says how much audio is needed, and the numbers come from the clip rules', () => {
  assert.match(html, /id="voiceNeeds"/);
  assert.equal(CLIP_MAX_SECONDS, 30);
  assert.equal(CLIP_MIN_SECONDS, 3);
  assert.match(app, /<b>10 to \$\{CLIP_MAX_SECONDS\} seconds<\/b> of clear speech works best/);
  // the 3 second minimum is enforced where it matters, with a message, instead of sitting in the hint
  assert.match(app, /Record at least \$\{CLIP_MIN_SECONDS\} seconds/);
});

test('recording shows a live timer against the clip-length cap and stops by itself', () => {
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

test('custom voice slots: adding is replaced by Delete / Get Premium only when the slots are full', () => {
  const add = pane.slice(pane.indexOf('id="voiceAddSection"'), pane.indexOf('id="voiceFullSection"'));
  for (const piece of ['Create your voice', 'id="recordVoiceBtn"', 'id="uploadVoiceBtn"', 'id="voiceNeeds"']) assert.ok(add.includes(piece), piece);
  assert.match(pane, /id="voiceFullSection" class="hidden"[\s\S]*id="voiceGetPremiumBtn"/);
  // the screen mirrors the server's count; a free account is 1 voice, Premium 5 (decided on the server)
  assert.match(app, /const full = !custom\.error && slots\.used >= slots\.max;/);
  assert.match(app, /\$\('voiceAddSection'\)\.classList\.toggle\('hidden', full \|\| !!custom\.error\);/);
  assert.match(app, /Free accounts have 1 custom voice\. Delete it, or get Premium for 5\./);
  // a clone over the limit is refused in the app too, not only on the server
  assert.match(app, /if \(slots && slots\.used >= slots\.max\) \{/);
  // Premium users are not offered Premium
  assert.match(app, /voiceGetPremiumBtn'\)\.classList\.toggle\('hidden', !!slots\.premium\)/);
  // each voice gets its own name
  assert.match(app, /n === 1 \? 'My voice' : `My voice \$\{n\}`/);
});

test('Delete is per voice: it asks first, tells the server which voice, and only changes the screen once the server says it is gone', () => {
  const handler = app.slice(app.indexOf('async function deleteCustomVoice'), app.indexOf("$('voiceGetPremiumBtn').addEventListener"));
  assert.match(handler, /confirmSheet\(\{ title: `Delete \\u201c\$\{voice\.name\}\\u201d\?`/);
  assert.match(handler, /authedFetch\(`\/api\/voice-clone\?target=agent&action=delete&voiceId=\$\{encodeURIComponent\(voice\.id\)\}`, \{ method: 'DELETE' \}\)/);
  // a refusal returns before the list is reloaded or any local state is cleared
  assert.ok(handler.indexOf('if (!resp.ok)') < handler.indexOf('voicePending ='));
  assert.ok(handler.indexOf('if (!resp.ok)') < handler.indexOf('await loadAgentState()'));
  // only a selection pointing at the deleted voice is cleared
  assert.match(handler, /voicePending\.agentVoiceId === voice\.id/);
  assert.ok(app.includes("del.addEventListener('click', (e) => { e.stopPropagation(); deleteCustomVoice(v, del); });"));
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
