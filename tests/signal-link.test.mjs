import { test, mock } from 'node:test';
import assert from 'node:assert';
const rows = {}; // signal_accounts store
const q = (table) => {
  const st = { table, filters: {} };
  const api = {
    select() { return api; }, eq(k, v) { st.filters[k] = v; return api; },
    maybeSingle: async () => ({ data: table === 'signal_accounts' ? rows.u1 || null : null }),
    upsert: async (r) => { rows.u1 = { ...(rows.u1||{}), ...r }; return {}; },
    update(r) { return { eq: async () => { rows.u1 = { ...(rows.u1||{}), ...r }; return {}; } }; },
  };
  return api;
};
mock.module(new URL('../lib/supabaseAdmin.js', import.meta.url).href, { namedExports: {
  getServiceClient: () => ({ from: q }), getAuthedUserId: async () => 'u1' } });
let bridgeState = 'pending';
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  const ok = (b) => ({ ok: true, status: 200, json: async () => b });
  if (u.endsWith('/signal/link/start')) return ok({ id: 'L1', qr: 'data:image/png;base64,AAA', uri: 'sgnl://x' });
  if (u.includes('/signal/link/L1')) return ok({ status: bridgeState, number: bridgeState === 'linked' ? '+2348012345678' : undefined });
  if (u.includes('/signal/accounts/') && opts.method === 'DELETE') return ok({ ok: true });
  throw new Error('unexpected fetch ' + u);
};
process.env.SIGNAL_BRIDGE_URL = 'http://bridge'; process.env.SIGNAL_BRIDGE_SECRET = 's';
const { default: handler } = await import('../api/social-calling.js');
const call = async (action, method = 'POST') => {
  let code, body; const res = { status(c) { code = c; return res; }, json(b) { body = b; return res; } };
  await handler({ method, query: { action }, body: {}, headers: {} }, res);
  return { code, body };
};
test('signal link flow', async () => {
  let r = await call('signal-start'); assert.equal(r.body.status, 'pending_qr'); assert.ok(r.body.qr);
  r = await call('signal-status', 'GET'); assert.equal(r.body.status, 'pending_qr');
  bridgeState = 'linked';
  r = await call('signal-status', 'GET'); assert.equal(r.body.status, 'connected'); assert.equal(r.body.phoneLast4, '5678');
  assert.equal(rows.u1.signal_number, '+2348012345678');
  r = await call('signal-start'); assert.equal(r.body.status, 'connected'); // no second QR when already linked
  r = await call('signal-disconnect'); assert.equal(r.body.status, 'disconnected'); assert.equal(rows.u1.signal_number, null);
  bridgeState = 'expired'; await call('signal-start');
  r = await call('signal-status', 'GET'); assert.equal(r.body.status, 'expired'); assert.equal(rows.u1.status, 'disconnected');
});
