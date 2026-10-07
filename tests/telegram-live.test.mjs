import { test, mock } from 'node:test';
import assert from 'node:assert';

// Row written by the retired relay: says connected, but mp-relay has no login for this user.
let row = { user_id: 'u1', status: 'connected', display_name: 'Old Me', phone_last4: '1234', last_error: null };
const writes = [];
const chain = (table) => {
  const api = new Proxy({}, { get: (_t, k) => {
    if (k === 'then') return (res) => res({ data: table === 'telegram_accounts' ? row : null, error: null });
    if (k === 'maybeSingle' || k === 'single') return async () => ({ data: table === 'telegram_accounts' ? row : null, error: null });
    if (k === 'upsert' || k === 'update' || k === 'insert') return (r) => { writes.push([table, k, r]); return api; };
    return () => api;
  } });
  return api;
};
mock.module(new URL('../lib/supabaseAdmin.js', import.meta.url).href, { namedExports: {
  getServiceClient: () => ({ from: chain, rpc: async () => ({ data: null, error: null }) }), getAuthedUserId: async () => 'u1' } });

let relayStatus = { status: 'disconnected' };      // what mp-relay answers for /sessions/u1/status
let relayDown = false;
const fetched = [];
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url); fetched.push(`${opts.method || 'GET'} ${u.replace('http://relay', '')}`);
  if (u.startsWith('http://relay')) {
    if (relayDown) throw new Error('relay asleep');
    if (u.endsWith('/sessions/u1/status')) return { ok: true, status: 200, json: async () => relayStatus };
    if (u.endsWith('/calls')) return { ok: true, status: 200, json: async () => ({ callId: 'c1', status: 'ringing' }) };
  }
  return { ok: true, status: 200, json: async () => ({}) };
};
process.env.MP_RELAY_URL = 'http://relay'; process.env.MP_RELAY_INTERNAL_SECRET = 's';
const { default: handler } = await import('../api/social-calling.js');
const call = async (action, body = {}, method = 'GET') => {
  let code, out; const res = { status(c) { code = c; return res; }, json(b) { out = b; return res; } };
  await handler({ method, query: { action }, body, headers: {} }, res);
  return { code, body: out };
};

test('stale "connected" row is shown as not connected when mp-relay has no login', async () => {
  relayStatus = { status: 'disconnected' };
  const r = await call('status');
  assert.equal(r.body.telegram.status, 'disconnected');
  assert.match(r.body.telegram.error, /reconnected/i);
  assert.equal(writes.filter(([t]) => t === 'telegram_accounts').length, 0, 'must not wipe the row on a status read');
});

test('call placement is refused with a clear message and never dials', async () => {
  relayStatus = { status: 'disconnected' }; fetched.length = 0;
  const r = await call('place-call', { platform: 'telegram', to: '+2348012345678' }, 'POST');
  assert.equal(r.code, 409);
  assert.match(r.body.error, /reconnect Telegram/i);
  assert.ok(!fetched.some((f) => f === 'POST /calls'), 'POST /calls must not be sent');
});

test('a real session passes through to mp-relay', async () => {
  relayStatus = { status: 'connected', firstName: 'Ada' };
  assert.equal((await call('status')).body.telegram.status, 'connected');
  fetched.length = 0;
  const r = await call('place-call', { platform: 'telegram', to: '+2348012345678' }, 'POST');
  assert.notEqual(r.code, 409);
  assert.ok(fetched.includes('POST /calls'), 'call reaches mp-relay');
});

test('relay asleep/unreachable never flips a good link to disconnected', async () => {
  relayDown = true;
  assert.equal((await call('status')).body.telegram.status, 'connected');
  relayDown = false;
});
