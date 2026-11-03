import test from 'node:test';
import assert from 'node:assert/strict';
import { plainCallError, startFlyWhatsappCall } from '../lib/wacallsFlyCalls.js';

test('a number WhatsApp cannot find gets a plain sentence, not the technical text', () => {
  const raw = 'WaCalls POST /api/sessions/x/calls failed (HTTP 500): usync returned no LID for 2349038226059 (peer unreachable or not on WhatsApp)';
  const plain = plainCallError(raw);
  assert.match(plain, /couldn't find that number/);
  assert.doesNotMatch(plain, /usync|HTTP|WaCalls|LID/);
});

test('a busy WhatsApp line gets a wait-and-retry sentence', () => {
  assert.match(plainCallError('operator already on a call'), /Another WhatsApp call is still open/);
});

test('an unlinked account gets a link-first sentence', () => {
  assert.match(plainCallError('WhatsApp is not linked. Connect it in Connected accounts first.'), /link WhatsApp first/);
});

test('a disconnected WhatsApp gets a check-connection sentence', () => {
  assert.match(plainCallError('websocket not connected'), /disconnected right now/);
});

test('an unknown failure gets a generic plain sentence', () => {
  assert.equal(plainCallError('something odd'), 'The WhatsApp call could not start. Try again in a moment.');
  assert.equal(plainCallError(undefined), 'The WhatsApp call could not start. Try again in a moment.');
});

test('a session WaCalls no longer has says so plainly', () => {
  assert.match(plainCallError('WaCalls POST /api/sessions/x/calls failed (HTTP 404): no such session'), /not connected anymore/);
});

// Minimal Supabase stand-in: every query chain resolves to the same row; updates are recorded.
function fakeSupabase(row, updates) {
  const result = { data: row, error: null };
  const chain = new Proxy(function () {}, {
    get(_, k) { if (k === 'then') return (res) => res(result); return () => chain; },
    apply() { return chain; },
  });
  return { from: (table) => ({ select: () => chain, update: (v) => { updates.push({ table, v }); return chain; } }) };
}

test('a 404 from WaCalls marks the account disconnected and fails with the plain message', async () => {
  const updates = [];
  const supabase = fakeSupabase({ wacalls_session_id: 'sess-gone', status: 'connected' }, updates);
  const deps = {
    createCallRecord: async () => ({ id: 'db-new' }),
    startFlyCall: async () => { throw Object.assign(new Error('WaCalls POST /api/sessions/sess-gone/calls failed (HTTP 404): no such session'), { statusCode: 404 }); },
    markCallFailed: async () => {},
  };
  await assert.rejects(startFlyWhatsappCall({ supabase, userId: 'u1', to: '1', deps }), (e) => e.statusCode === 404 && /not connected anymore/.test(e.message));
  assert.deepEqual(updates.find((u) => u.table === 'whatsapp_accounts'), { table: 'whatsapp_accounts', v: { wacalls_session_id: null, status: 'disconnected', display_name: null } });
});
