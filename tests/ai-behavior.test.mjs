import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeConfig, sanitizeKnowledge, AI_ACTIONS } from '../lib/aiBehaviorAdmin.js';
import { fetchGlobalAi, globalAiSection } from '../lib/globalAi.js';

test('sanitizeConfig clamps sizes and drops unknown keys', () => {
  const c = sanitizeConfig({ global: { style: 'x'.repeat(5000), bogus: 'no' }, must: ['a', '', 'b'], avoid: 'one\ntwo', models: { live: { extra: 'L' }, other: { extra: 'O' } } });
  assert.equal(c.global.style.length, 700);
  assert.equal(c.global.bogus, undefined);
  assert.deepEqual(c.must, ['a', 'b']);
  assert.deepEqual(c.avoid, ['one', 'two']);
  assert.equal(c.models.live.extra, 'L');
  assert.equal(c.models.other, undefined);
});

test('sanitizeKnowledge validates and normalises', () => {
  assert.throws(() => sanitizeKnowledge({ title: '  ' }), /title/i);
  const k = sanitizeKnowledge({ kind: 'weird', title: 'T', tags: ['Pricing', 'x'], models: ['nope'], modes: ['app'] });
  assert.equal(k.kind, 'fact');
  assert.deepEqual(k.tags, ['pricing', 'x']);
  assert.deepEqual(k.models, ['live', 'luna']);
  assert.deepEqual(k.modes, ['app']);
});

test('every ai admin action is declared', () => {
  for (const a of ['ai-config-publish', 'ai-config-rollback', 'ai-knowledge-save', 'ai-test']) assert.ok(AI_ACTIONS.has(a));
});

test('fetchGlobalAi returns the block and caches; failures return an empty block', async () => {
  let calls = 0;
  const ok = { rpc: async () => { calls += 1; return { data: { version: 3, block: 'Style: warm' }, error: null }; } };
  const a = await fetchGlobalAi({ model: 'luna', mode: 'phone', query: 'cache test one', supabase: ok });
  const b = await fetchGlobalAi({ model: 'luna', mode: 'phone', query: 'cache test one', supabase: ok });
  assert.equal(a.version, 3); assert.equal(b.block, 'Style: warm'); assert.equal(calls, 1);
  const bad = { rpc: async () => ({ data: null, error: { message: 'boom' } }) };
  const c = await fetchGlobalAi({ model: 'live', mode: 'app', query: 'fail case', supabase: bad });
  assert.deepEqual(c, { version: 0, block: '' });
  assert.equal(globalAiSection(''), '');
  assert.match(globalAiSection('x'), /House guidance/);
});

test('trainer call start refuses without bridge secret and signs a trainer-prefixed token', async () => {
  const { handleAiAction } = await import('../lib/aiBehaviorAdmin.js');
  const mkRes = () => { const r = { code: 0, body: null, status(c) { r.code = c; return r; }, json(b) { r.body = b; return r; } }; return r; };
  const saved = { s: process.env.ASSISTANT_BRIDGE_SECRET, u: process.env.PUBLIC_ASSISTANT_WS_URL };
  const inserted = [];
  const sb = { from: (t) => ({
    insert: (row) => { inserted.push([t, row]); return { select: () => ({ single: async () => ({ data: { id: 'row-1' }, error: null }) }), then: (f) => f({ error: null }) }; },
  }) };
  const access = { email: 'a@b.c', user: { id: 'admin-1' } };
  try {
    delete process.env.ASSISTANT_BRIDGE_SECRET; process.env.PUBLIC_ASSISTANT_WS_URL = 'wss://voice.example.com';
    let r = mkRes(); await handleAiAction('ai-train-call-start', { method: 'POST', body: {} }, r, sb, access);
    assert.equal(r.code, 501);
    process.env.ASSISTANT_BRIDGE_SECRET = 'shh';
    r = mkRes(); await handleAiAction('ai-train-call-start', { method: 'POST', body: { engine: 'luna' } }, r, sb, access);
    assert.equal(r.code, 200);
    assert.equal(r.body.engine, 'luna');
    const url = new URL(r.body.url);
    assert.equal(url.searchParams.get('engine'), 'luna');
    const [exp, uid, sig] = url.searchParams.get('token').split('.');
    const { createHmac } = await import('crypto');
    const want = createHmac('sha256', 'shh').update(`trainercall:${r.body.sessionId}:${uid}:${exp}`).digest('hex');
    assert.equal(sig, want);
    assert.equal(uid, 'admin-1');
    const callRow = inserted.find(([t]) => t === 'calls')[1];
    assert.equal(callRow.platform, 'app'); assert.equal(callRow.user_id, 'admin-1'); assert.equal(callRow.to_number, 'Emysa training');
    r = mkRes(); await handleAiAction('ai-train-call-start', { method: 'GET', body: {} }, r, sb, access);
    assert.equal(r.code, 405);
  } finally {
    if (saved.s === undefined) delete process.env.ASSISTANT_BRIDGE_SECRET; else process.env.ASSISTANT_BRIDGE_SECRET = saved.s;
    if (saved.u === undefined) delete process.env.PUBLIC_ASSISTANT_WS_URL; else process.env.PUBLIC_ASSISTANT_WS_URL = saved.u;
  }
});
