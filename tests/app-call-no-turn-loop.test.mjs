// The in-app call is a live GPT-Live session. The old turn-based loop (record -> transcribe -> text model ->
// speech) must not exist in the client call path any more.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const app = await readFile(new URL('../app.js', import.meta.url), 'utf8');

test('the call screen has no record/transcribe/speak turn loop', () => {
  for (const banned of ['startAssistantListening', 'speakReply', 'waveRecorder', 'action=speak', 'action=transcribe']) {
    assert.ok(!app.includes(banned), `app.js must not reference ${banned}`);
  }
});

test('the call is started as a live session', () => {
  assert.ok(app.includes('startAppCallSession'), 'live session entry point is present');
  assert.ok(app.includes('mic-tap'), 'mic is streamed through an AudioWorklet');
});
