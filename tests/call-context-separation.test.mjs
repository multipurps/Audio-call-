import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sanitizeObjective, groundSummary, recipientAskedQuestion, isUnintelligible, OBJECTIVE_BOUNDARY_RULES } from '../lib/callContextGuard.js';
import { transcriptForPrompt } from '../lib/callSession.js';

const call = (...lines) => lines.map(([who, content]) => ({ speaker: who, content }));

test('owner asks what Emysa does; objective never claims Matthew asked', () => {
  const objective = 'Tell Matthew what I do. He asked what I do the other day. Answer his question.';
  const clean = sanitizeObjective(objective);
  assert.equal(clean, 'Tell Matthew what I do.');
  assert.ok(!/asked|question|other day/i.test(clean));
});

test('the chat call planner prompt carries the boundary rules and sanitises the objective', () => {
  const src = readFileSync(new URL('../api/assistant.js', import.meta.url), 'utf8');
  assert.ok(src.includes('OBJECTIVE_BOUNDARY_RULES'));
  assert.ok(src.includes('sanitizeObjective(intent.objective'));
  assert.match(OBJECTIVE_BOUNDARY_RULES, /PRIVATE conversation between the owner/);
});

test('owner chat is never part of the summary evidence', () => {
  const t = call(['ai', 'Hi Matthew, it is Emysa.'], ['caller', 'Hi.']);
  const { text } = transcriptForPrompt(t);
  assert.equal(text, 'Me: Hi Matthew, it is Emysa.\nThem: Hi.');
  assert.equal(recipientAskedQuestion(t), false);
});

test('summary drops a recipient question the transcript does not contain', () => {
  const t = call(['ai', 'I do help people decide things.'], ['caller', 'Okay.']);
  const out = groundSummary({ summary: 'I explained what I do. Matthew asked what I do and I answered his question.', unresolved: ['Did it answer his question?'] }, t);
  assert.equal(out.summary, 'I explained what I do.');
  assert.deepEqual(out.unresolved, []);
});

test('summary keeps a recipient question that is really in the transcript', () => {
  const t = call(['caller', 'What do you do?'], ['ai', 'I help people decide.']);
  const s = { summary: 'Matthew asked what I do and I told him.', unresolved: [] };
  assert.deepEqual(groundSummary(s, t), s);
});

test('unintelligible speech is removed before summarising, never turned into facts', () => {
  const t = call(['caller', '[unintelligible]'], ['caller', '...'], ['caller', 'Call me Friday.']);
  assert.equal(isUnintelligible('[inaudible]'), true);
  assert.equal(transcriptForPrompt(t).text, 'Them: Call me Friday.');
});
