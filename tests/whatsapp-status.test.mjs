import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveWhatsappStatus } from '../lib/whatsappStatus.js';

const row = { status: 'disconnected', display_name: null, wacalls_session_id: 'abc' };

test('paired relay overrides a stale "disconnected" flag and heals the row', async () => {
  const r = await resolveWhatsappStatus(row, async () => ({ paired: true, jid: '234@s.whatsapp.net' }));
  assert.equal(r.status, 'connected');
  assert.deepEqual(r.update, { status: 'connected', display_name: '234@s.whatsapp.net' });
});

test('a sleeping or erroring relay never disconnects the user', async () => {
  const slow = Object.assign(new Error('timeout'), { statusCode: undefined });
  const r = await resolveWhatsappStatus({ ...row, status: 'connected' }, async () => { throw slow; });
  assert.equal(r.status, 'connected');
  assert.equal(r.update, null);
  const r5 = await resolveWhatsappStatus({ ...row, status: 'connected' }, async () => { throw Object.assign(new Error('x'), { statusCode: 503 }); });
  assert.equal(r5.status, 'connected');
});

test('only a real 404 clears the link', async () => {
  const r = await resolveWhatsappStatus({ ...row, status: 'connected' }, async () => { throw Object.assign(new Error('no'), { statusCode: 404 }); });
  assert.equal(r.status, 'disconnected');
  assert.equal(r.update.wacalls_session_id, null);
});

test('no session id means disconnected without asking the relay', async () => {
  let asked = false;
  const r = await resolveWhatsappStatus({ status: 'connected' }, async () => { asked = true; });
  assert.equal(r.status, 'disconnected');
  assert.equal(asked, false);
});
