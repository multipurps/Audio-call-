import test from 'node:test';
import assert from 'node:assert/strict';
import { handleAiAction, parseLessons } from '../lib/aiBehaviorAdmin.js';

const access = { email: 'admin@x.test', user: { id: 'admin-1' } };
const mkRes = () => { const r = { code: 0, body: null, status(c) { r.code = c; return r; }, json(b) { r.body = b; return r; } }; return r; };

function fakeDb({ transcript, existing = [], callOk = true }) {
  const log = { inserts: [], updates: [], deletes: [] };
  let n = 0;
  const from = (table) => {
    let mode = 'select'; let payload = null;
    const b = {
      select() { return b; }, eq() { return b; }, in() { return b; }, order() { return b; }, limit() { return b; },
      insert(p) { mode = 'insert'; payload = p; if (table === 'ai_knowledge') log.inserts.push(p); return b; },
      update(p) { mode = 'update'; payload = p; if (table === 'ai_knowledge') log.updates.push(p); return b; },
      async maybeSingle() {
        if (table === 'calls') return { data: callOk ? { id: 'c1', transcript } : null };
        if (table === 'ai_knowledge') return { data: existing[0] || null };
        return { data: null };
      },
      async single() { return { data: { id: payload?.id || `new-${++n}`, title: payload?.title, kind: payload?.kind }, error: null }; },
      then(f) { return f({ data: table === 'ai_knowledge' && mode === 'select' ? existing : null, error: null }); },
    };
    return b;
  };
  return { from, log };
}

function stubModel(content) {
  const orig = globalThis.fetch;
  process.env.LUNA_API_KEY = 'k';
  globalThis.fetch = async () => ({ ok: true, status: 200, headers: new Map(), text: async () => '', json: async () => ({ choices: [{ message: { content } }] }) });
  return () => { globalThis.fetch = orig; };
}

const talk = [
  { speaker: 'contact', content: 'When someone says thanks, never say no problem, say of course.' },
  { speaker: 'ai', content: 'Okay, of course.' },
];

test('parseLessons reads fenced or bare JSON and rejects junk', () => {
  assert.equal(parseLessons('nope'), null);
  assert.deepEqual(parseLessons('```json\n{"lessons":[]}\n```'), []);
  assert.equal(parseLessons('{"lessons":[{"title":"a"},{},{},{},{},{}]}').length, 5);
});

test('learn: saves a lesson as a DRAFT tagged from-training-call and advances the index', async () => {
  const restore = stubModel(JSON.stringify({ lessons: [{ kind: 'rule', title: 'Say of course, not no problem', body: 'When thanked, reply "of course".', tags: ['thanks'], always: false }] }));
  try {
    const db = fakeDb({ transcript: talk });
    const r = mkRes();
    await handleAiAction('ai-train-learn', { method: 'POST', body: { callId: 'c1', fromIndex: 0 } }, r, db, access);
    assert.equal(r.code, 200);
    assert.equal(r.body.nextIndex, 2);
    assert.equal(r.body.saved.length, 1);
    const row = db.log.inserts[0];
    assert.equal(row.status, 'draft');
    assert.ok(row.tags.includes('from-training-call'));
    assert.match(row.created_by, /training call/);
  } finally { restore(); }
});

test('learn: nothing taught by the trainer means no model call and no save', async () => {
  let called = false;
  const restore = stubModel('{"lessons":[]}');
  const f = globalThis.fetch; globalThis.fetch = async (...a) => { called = true; return f(...a); };
  try {
    const db = fakeDb({ transcript: [{ speaker: 'ai', content: 'Hello there, how can I help?' }, { speaker: 'contact', content: 'Hi' }] });
    const r = mkRes();
    await handleAiAction('ai-train-learn', { method: 'POST', body: { callId: 'c1', fromIndex: 0 } }, r, db, access);
    assert.equal(called, false);
    assert.deepEqual(r.body.saved, []);
    assert.equal(db.log.inserts.length, 0);
  } finally { restore(); }
});

test('learn: secrets are dropped, duplicates skipped, a bad model reply retries without advancing', async () => {
  let restore = stubModel(JSON.stringify({ lessons: [
    { kind: 'fact', title: 'Staging login', body: 'The password is hunter2 and the key is sk-abcdefghijklmnopqrstuvwxyz123456' },
    { kind: 'rule', title: 'Say of course', body: 'When thanked, reply of course instead of no problem' },
  ] }));
  try {
    const db = fakeDb({ transcript: talk, existing: [{ id: 'k1', kind: 'rule', title: 'Say of course', body: 'When thanked, reply of course instead of no problem', status: 'published' }] });
    const r = mkRes();
    await handleAiAction('ai-train-learn', { method: 'POST', body: { callId: 'c1', fromIndex: 0 } }, r, db, access);
    assert.equal(db.log.inserts.length, 0, 'secret dropped and duplicate skipped');
  } finally { restore(); }
  restore = stubModel('I could not do that');
  try {
    const r = mkRes();
    await handleAiAction('ai-train-learn', { method: 'POST', body: { callId: 'c1', fromIndex: 0 } }, r, fakeDb({ transcript: talk }), access);
    assert.equal(r.body.retry, true);
    assert.equal(r.body.nextIndex, 0);
  } finally { restore(); }
});

test('learn: only the admin who owns a training call can use it', async () => {
  const r = mkRes();
  await handleAiAction('ai-train-learn', { method: 'POST', body: { callId: 'c1' } }, r, fakeDb({ transcript: talk, callOk: false }), access);
  assert.equal(r.code, 404);
  const r2 = mkRes();
  await handleAiAction('ai-train-learn', { method: 'POST', body: {} }, r2, fakeDb({ transcript: talk }), access);
  assert.equal(r2.code, 400);
});

import { readFileSync } from 'node:fs';
test('real call screen: training mode uses the admin start, is never a briefing, and learns while the call runs', () => {
  const src = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  assert.match(src, /trainerCall \? '\/api\/admin\?action=ai-train-call-start' : '\/api\/calls\?action=app-call-start'/);
  assert.match(src, /call\.briefable = !trainerCall/);
  assert.match(src, /ai-train-learn/);
  assert.match(src, /setInterval\(\(\) => trainerLearn\(t, call\.callId\), 15000\)/);
  assert.match(src, /!trainer && needsTopUp\(\)/);
});
