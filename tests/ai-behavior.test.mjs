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
