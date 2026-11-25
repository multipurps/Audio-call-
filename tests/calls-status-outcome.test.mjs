import test from 'node:test';
import assert from 'node:assert/strict';
import { database, loadApi } from './helpers.mjs';

async function post(db, callId, body) {
  const api = await loadApi('api/calls-status.js', db, async () => ({ ok: true, json: async () => ({}) }), { WEBHOOK_VALIDATION: 'off' });
  const res = { code: 200, status(c) { this.code = c; return this; }, send() { return this; }, json() { return this; } };
  await api.default({ method: 'POST', query: { callId }, headers: {}, body }, res);
  return res;
}
const seed = (status, extra = {}) => ({
  contacts: [{ id: 'c1', user_id: 'user-1', name: 'Zeez' }],
  calls: [{ id: 'k1', user_id: 'user-1', contact_id: 'c1', session_id: null, status, ...extra }],
});

test('carrier ringing shows ringing; initiated does not', async () => {
  const db = database(seed('queued'));
  await post(db, 'k1', { CallStatus: 'initiated' });
  assert.equal(db.tables.calls[0].status, 'queued');
  await post(db, 'k1', { CallStatus: 'ringing' });
  assert.equal(db.tables.calls[0].status, 'ringing');
});

test('final completed callback keeps a voicemail/no_answer outcome already saved', async () => {
  const summary = 'Zeez did not pick up; it went to voicemail.';
  const db = database(seed('no_answer', { outcome_summary: summary }));
  await post(db, 'k1', { CallStatus: 'completed', CallDuration: '14' });
  assert.equal(db.tables.calls[0].status, 'no_answer');
  assert.equal(db.tables.calls[0].outcome_summary, summary);
});

test('a call that connects for a few seconds then ends says so', async () => {
  const db = database(seed('in_progress'));
  await post(db, 'k1', { CallStatus: 'completed', CallDuration: '3' });
  assert.match(db.tables.calls[0].outcome_summary, /Zeez.*connected for 3 seconds/);
});

test('a late ringing callback cannot reopen a finished call', async () => {
  const db = database(seed('failed', { outcome_summary: 'x' }));
  await post(db, 'k1', { CallStatus: 'ringing' });
  assert.equal(db.tables.calls[0].status, 'failed');
});
