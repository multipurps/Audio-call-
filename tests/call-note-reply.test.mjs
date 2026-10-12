import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { callNoteReply } from '../lib/callNote.js';

const ok = { ok: true };

test('what you type to a live call is answered in one voice, never about "Emysa" or "she"', () => {
  for (const text of ['Round up the call', 'tell him I will be late', 'ask about the invoice']) {
    const reply = callNoteReply(text, ok);
    assert.doesNotMatch(reply, /Emysa|\bshe\b|\bher\b|passed to/i, reply);
  }
});

test('a wrap-up request is answered as a wrap-up', () => {
  for (const text of ['Round up the call', 'round it up', 'wrap it up', 'wrap up', 'please wrap this up', 'finish up now', 'bring it to a close']) {
    assert.equal(callNoteReply(text, ok), "Okay, I'll wrap it up.", text);
  }
});

test('anything else is simply taken on board', () => {
  assert.equal(callNoteReply('Tell him the venue moved', ok), "Got it. I'll work that in.");
  assert.equal(callNoteReply('', ok), "Got it. I'll work that in.");
});

test('a failure is first person too and keeps the real reason', () => {
  assert.equal(callNoteReply('round up', { ok: false, error: 'the call has ended' }), "I couldn't get that to the call: the call has ended.");
  assert.doesNotMatch(callNoteReply('x', { ok: false, error: 'boom' }), /Emysa/);
});

test('the chat handler uses it (the old third-person line is gone)', () => {
  const src = readFileSync(new URL('../api/assistant.js', import.meta.url), 'utf8');
  assert.match(src, /callNoteReply\(text, result\)/);
  assert.ok(!src.includes('Passed to Emysa'));
  assert.ok(!src.includes("I couldn't pass that to Emysa"));
});
