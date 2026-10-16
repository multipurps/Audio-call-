// Admin "Call Emysa": the call screen lives inside the admin PWA's scope (/admin/), never in the app.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const trainer = read('admin/trainerCall.js');
const html = read('admin/call.html');
const js = read('admin/call.js');

test('the admin opens the call screen inside its own scope, in the same window', () => {
  assert.ok(existsSync(new URL('../admin/call.html', import.meta.url)));
  assert.match(trainer, /href="\.\/call\.html"/);
  assert.match(trainer, /href="\.\/call\.html\?engine=luna"/);
  assert.doesNotMatch(trainer, /\?trainer=1/, 'a link to the app is outside the admin PWA scope and breaks out of it on iOS');
  assert.doesNotMatch(trainer, /target="_blank"/);
  assert.match(read('admin/manifest.json'), /"scope":\s*"\.\/"/);
});

test('the call screen is the app\'s own markup and stylesheet, with a working End button', () => {
  assert.match(html, /href="\.\.\/styles\.css"/);
  for (const id of ['callScreen', 'callEndBtn', 'callMuteBtn', 'callFaceTimeBtn', 'transcriptPanel', 'callStatePill', 'trainGate', 'trainEnd']) {
    assert.match(html, new RegExp(`id="${id}"`), `#${id}`);
  }
  const app = read('index.html');
  const endBtn = (s) => s.match(/<button[^>]*id="callEndBtn".*?<\/button>/s)[0].replace(/\s+/g, ' ');
  assert.equal(endBtn(html), endBtn(app), 'End button is a copy of the app\'s');
});

test('the audio engine is the shared one, not a rewrite', () => {
  for (const lib of ['appCallAudio', 'appCallOutput', 'appCallPlayback', 'callStatus']) assert.match(js, new RegExp(`\\.\\./lib/${lib}\\.js`));
});

test('End works in every state and the microphone is always released', () => {
  assert.match(js, /if \(phase === 'idle' \|\| phase === 'over'\) \{ goBack\(\); return; \}/);
  assert.match(js, /addEventListener\('pagehide', \(\) => \{ stopSession\(\{ hangUp: true \}\); \}\)/);
  assert.match(js, /getTracks\(\)\.forEach\(\(t\) => t\.stop\(\)\)/);
  assert.match(js, /ai-train-call-start/);
  assert.match(js, /ai-train-learn/);
});

test('the admin page is served uncached like the rest of the admin', () => {
  assert.match(read('vercel.json'), /admin\/call\\\\\.html/);
  assert.match(html, /import\('\.\/call\.js\?v=/);
});
