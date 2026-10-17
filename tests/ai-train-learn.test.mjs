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
  assert.equal(parseLessons(`{"lessons":[${Array.from({ length: 15 }, () => '{"title":"a"}').join(',')}]}`).length, 12);
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


// ---- a long call must yield many lessons, not two ----
function stubModelCapture(contentFor) {
  const orig = globalThis.fetch; const prompts = [];
  process.env.LUNA_API_KEY = 'k';
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body); const user = body.messages.at(-1).content; prompts.push({ system: body.messages[0].content, user });
    return { ok: true, status: 200, headers: new Map(), text: async () => '', json: async () => ({ choices: [{ message: { content: contentFor(user, prompts.length) } }] }) };
  };
  return { prompts, restore: () => { globalThis.fetch = orig; } };
}
const lesson = (title, body) => ({ kind: 'rule', title, body, tags: ['x'], always: false });

test('learn: every distinct lesson in one pass is saved (up to 12), not just a couple', async () => {
  const many = Array.from({ length: 9 }, (_, i) => lesson(`Rule number ${i} about topic${i}`, `Always handle situation${i} by doing action${i} carefully and politely`));
  const { restore } = stubModelCapture(() => JSON.stringify({ lessons: many }));
  try {
    const db = fakeDb({ transcript: talk });
    const r = mkRes();
    await handleAiAction('ai-train-learn', { method: 'POST', body: { callId: 'c1', fromIndex: 0 } }, r, db, access);
    assert.equal(r.body.saved.length, 9);
    assert.equal(db.log.inserts.length, 9);
  } finally { restore(); }
});

test('learn: the model sees the lines before the new ones as context only', async () => {
  const lines = Array.from({ length: 12 }, (_, i) => ({ speaker: i % 2 ? 'ai' : 'contact', content: i % 2 ? `Emysa line ${i}` : `Trainer says something long enough about handling case ${i} properly` }));
  const { prompts, restore } = stubModelCapture(() => '{"lessons":[]}');
  try {
    const r = mkRes();
    await handleAiAction('ai-train-learn', { method: 'POST', body: { callId: 'c1', fromIndex: 10 } }, r, fakeDb({ transcript: lines }), access);
    assert.equal(prompts.length, 1);
    const [before, after] = prompts[0].user.split('New transcript:');
    assert.match(before, /Earlier context[^]*case 8 properly/, 'earlier lines are given as context');
    assert.doesNotMatch(after, /case 8/);
    assert.match(after, /case 10 properly/);
    assert.match(prompts[0].system, /At most 12 lessons/);
  } finally { restore(); }
});

test('learn: too little said yet keeps the lines for the next pass instead of dropping them', async () => {
  const { prompts, restore } = stubModelCapture(() => '{"lessons":[]}');
  try {
    const r = mkRes();
    await handleAiAction('ai-train-learn', { method: 'POST', body: { callId: 'c1', fromIndex: 4 } },
      r, fakeDb({ transcript: [...talk, ...talk, { speaker: 'contact', content: 'Okay' }, { speaker: 'ai', content: 'Sure.' }] }), access);
    assert.equal(prompts.length, 0);
    assert.equal(r.body.nextIndex, 4, 'did not move past what was not read');
  } finally { restore(); }
});

test('learn: the final pass reads the whole call from the start and skips what is already saved', async () => {
  const lines = [
    { speaker: 'contact', content: 'Never say no problem, always say of course when someone thanks you.' },
    { speaker: 'ai', content: 'Okay.' },
    { speaker: 'contact', content: 'Our minimum top up is five dollars and minutes never expire for paid users.' },
  ];
  const { prompts, restore } = stubModelCapture(() => JSON.stringify({ lessons: [
    lesson('Say of course when thanked', 'Never say no problem, always say of course when someone thanks you'),
    lesson('Minimum top up', 'Minimum top up is five dollars and paid minutes never expire'),
  ] }));
  try {
    const db = fakeDb({ transcript: lines, existing: [{ id: 'k1', kind: 'rule', title: 'Say of course when thanked', body: 'Never say no problem, always say of course when someone thanks you', status: 'draft' }] });
    const r = mkRes();
    await handleAiAction('ai-train-learn', { method: 'POST', body: { callId: 'c1', fromIndex: 3, final: true } }, r, db, access);
    assert.match(prompts[0].user, /Never say no problem/, 'final pass starts at line 0 even though fromIndex was 3');
    assert.equal(r.body.saved.length, 1, 'only the lesson that was not saved yet');
    assert.equal(r.body.saved[0].title, 'Minimum top up');
    assert.equal(r.body.skipped.duplicate, 1);
    assert.equal(r.body.nextIndex, 3);
  } finally { restore(); }
});

test('learn: the same lesson returned twice in one pass is saved once, but a new detail on the topic is kept', async () => {
  const { restore } = stubModelCapture(() => JSON.stringify({ lessons: [
    lesson('Refund wording', 'When a customer asks for a refund apologise first then explain the process clearly'),
    lesson('Refund wording', 'When a customer asks for a refund apologise first then explain the process clearly'),
    lesson('Refund time limit', 'Refunds are only possible within fourteen days of purchase for unused minutes'),
  ] }));
  try {
    const db = fakeDb({ transcript: talk });
    const r = mkRes();
    await handleAiAction('ai-train-learn', { method: 'POST', body: { callId: 'c1', fromIndex: 0 } }, r, db, access);
    assert.deepEqual(r.body.saved.map((x) => x.title), ['Refund wording', 'Refund time limit']);
  } finally { restore(); }
});

test('learn: the training pages send final: true when the call ends and wait for a running pass first', () => {
  for (const f of ['../admin/call.js', '../app.js']) {
    const src = readFileSync(new URL(f, import.meta.url), 'utf8');
    assert.match(src, /final: true/, f);
    assert.match(src, /JSON\.stringify\(\{ callId, fromIndex: t\.nextIndex, final \}\)/, f);
    assert.match(src, /t\.busy; i\+\+\) await new Promise/, f);
  }
});
