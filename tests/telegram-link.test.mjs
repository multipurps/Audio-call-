import { test, mock } from 'node:test';
import assert from 'node:assert';

let row = null;                 // telegram_accounts row for user u1
let upsertError = null;
const q = (table) => {
  const api = {
    select() { return api; }, eq() { return api; },
    maybeSingle: async () => ({ data: table === 'telegram_accounts' ? row : null }),
    upsert: async (r) => { if (upsertError) return { error: upsertError }; row = { ...(row || {}), ...r }; return {}; },
  };
  return api;
};
mock.module(new URL('../lib/supabaseAdmin.js', import.meta.url).href, { namedExports: {
  getServiceClient: () => ({ from: q }), getAuthedUserId: async () => 'u1' } });

let relay = { verify: 'connected', failVerify: false, statusBody: { status: 'connected', firstName: 'Ada', username: 'ada' } };
const relayCalls = [];
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url); relayCalls.push(`${opts.method || 'GET'} ${u.replace('http://relay', '')}`);
  const ok = (b) => ({ ok: true, status: 200, json: async () => b });
  if (u.endsWith('/sessions/u1/start')) return ok({ status: 'code_sent' });
  if (u.endsWith('/sessions/u1/verify')) return relay.failVerify
    ? { ok: false, status: 400, json: async () => ({ error: 'PHONE_CODE_INVALID' }) } : ok({ status: relay.verify });
  if (u.endsWith('/sessions/u1/2fa')) return ok({ status: 'connected' });
  if (u.endsWith('/sessions/u1/status')) return ok(relay.statusBody);
  if (u.endsWith('/sessions/u1') && opts.method === 'DELETE') return ok({ ok: true });
  throw new Error('unexpected fetch ' + u);
};
process.env.MP_RELAY_URL = 'http://relay'; process.env.MP_RELAY_INTERNAL_SECRET = 's';
const { default: handler } = await import('../api/social-calling.js');
const call = async (action, body = {}, method = 'POST') => {
  let code, out; const res = { status(c) { code = c; return res; }, json(b) { out = b; return res; } };
  await handler({ method, query: { action }, body, headers: {} }, res);
  return { code, body: out };
};

test('start records pending_otp + last 4 digits', async () => {
  const r = await call('telegram-start', { phone: '+234 801 234 5678' });
  assert.equal(r.body.status, 'pending_otp');
  assert.equal(row.status, 'pending_otp'); assert.equal(row.phone_last4, '5678');
});

test('verify (no 2FA) marks connected and the status screen shows it', async () => {
  const r = await call('telegram-verify', { code: '12345' });
  assert.equal(r.body.status, 'connected');
  assert.equal(row.status, 'connected'); assert.equal(row.display_name, 'Ada');
  const s = await call('status', {}, 'GET');
  assert.equal(s.body.telegram.status, 'connected');
  assert.equal(s.body.telegram.displayName, 'Ada'); assert.equal(s.body.telegram.phoneLast4, '5678');
});

test('2FA: code step does NOT connect, password step does', async () => {
  row = null; relay.verify = 'need_2fa';
  await call('telegram-start', { phone: '+2348012345678' });
  let r = await call('telegram-verify', { code: '12345' });
  assert.equal(r.body.status, 'needs_password'); assert.equal(row.status, 'pending_otp');
  r = await call('telegram-verify', { password: 'pw' });
  assert.equal(r.body.status, 'connected'); assert.equal(row.status, 'connected');
  relay.verify = 'connected';
});

test('wrong code: relay error surfaces, account is not marked connected', async () => {
  row = null; relay.failVerify = true;
  await call('telegram-start', { phone: '+2348012345678' });
  const r = await call('telegram-verify', { code: '00000' });
  assert.equal(r.code, 400); assert.match(r.body.error, /PHONE_CODE_INVALID/);
  assert.equal(row.status, 'pending_otp'); relay.failVerify = false;
});

test('a login that succeeded is not failed just because the name lookup fails', async () => {
  row = null; relay.statusBody = null;
  const orig = globalThis.fetch;
  globalThis.fetch = async (u, o) => String(u).endsWith('/status') ? { ok: false, status: 500, json: async () => ({}) } : orig(u, o);
  const r = await call('telegram-verify', { code: '1' });
  assert.equal(r.body.status, 'connected'); assert.equal(row.status, 'connected'); assert.equal(row.display_name, null);
  globalThis.fetch = orig;
});

test('database write failure is reported, never silently "connected"', async () => {
  upsertError = { message: 'rls denied' };
  const r = await call('telegram-verify', { code: '1' });
  assert.equal(r.code, 500); assert.match(r.body.error, /Could not save/);
  upsertError = null;
});

test('disconnect clears the row', async () => {
  const r = await call('telegram-disconnect');
  assert.equal(r.body.status, 'disconnected');
  assert.equal(row.status, 'disconnected'); assert.equal(row.display_name, null);
  assert.ok(relayCalls.includes('DELETE /sessions/u1'));
});
