import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentRoute } from '../lib/agentRoute.js';

function fakeRes() {
  return { code: 0, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
}
function fakeSupabase({ row = null, failRead = false, failWrite = false } = {}) {
  const writes = [];
  const q = {
    select() { return q; }, eq() { return q; },
    maybeSingle: async () => (failRead ? { data: null, error: { message: 'x' } } : { data: row, error: null }),
    upsert: async (payload) => { writes.push(payload); return { error: failWrite ? { message: 'x' } : null }; },
  };
  return { from: () => q, writes };
}

test('status says whether the Agent is on', async () => {
  const res = fakeRes();
  await agentRoute({ method: 'GET', query: { action: 'status' } }, res, fakeSupabase({ row: { active: true } }), 'u1');
  assert.equal(res.code, 200);
  assert.deepEqual(res.body, { active: true });
});

test('status is off when the user has no row', async () => {
  const res = fakeRes();
  await agentRoute({ method: 'GET', query: { action: 'status' } }, res, fakeSupabase(), 'u1');
  assert.deepEqual(res.body, { active: false });
});

test('choose turns the Agent on, with no voice of its own (the agent keeps its ElevenLabs voice)', async () => {
  const sb = fakeSupabase();
  const res = fakeRes();
  await agentRoute({ method: 'PUT', query: { action: 'choose' }, body: {} }, res, sb, 'u1');
  assert.equal(res.code, 200);
  assert.equal(sb.writes[0].active, true);
  assert.equal(sb.writes[0].voice_id, undefined);
});

test('a failed save is reported, not hidden', async () => {
  const res = fakeRes();
  await agentRoute({ method: 'PUT', query: { action: 'choose' }, body: {} }, res, fakeSupabase({ failWrite: true }), 'u1');
  assert.equal(res.code, 500);
});
