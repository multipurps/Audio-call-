// New accounts start with 0 minutes and nothing hands them any until they buy some.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { database } from './helpers.mjs';
import handler from '../api/referrals.js';
import { remainingMinutes, minutesLeft, minutesGate, MINUTES_CHECK_FAILED_MESSAGE, STARTING_MINUTES } from '../lib/billing.js';
import { placeCall } from '../lib/phoneCalls.js';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const newUser = { id: 'new-user', email: 'new@example.com' };
const res = () => ({ code: 200, data: null, status(c) { this.code = c; return this; }, json(d) { this.data = d; return this; } });
const asSupabase = (db) => ({ from: (t) => db.from(t), rpc: async () => ({ data: null, error: null }) });

test('the starting balance is zero, and a missing usage row never means free minutes', () => {
  assert.equal(STARTING_MINUTES, 0);
  assert.equal(remainingMinutes(null).remaining, 0);
  assert.equal(remainingMinutes(undefined).remaining, 0);
  assert.equal(remainingMinutes({}).remaining, 0);
  assert.equal(remainingMinutes({ call_minutes_used: 0 }).remaining, 0);
});

test('a brand-new account (no usage row) has 0 minutes on the server', async () => {
  const db = database({}, { funded: false });
  const left = await minutesLeft(asSupabase(db), newUser.id);
  assert.equal(left.remaining, 0);
  assert.equal(db.tables.user_usage.length, 0, 'checking a balance creates nothing');
});

test('the billing screen shows 0 for a brand-new account', async () => {
  const db = database({}, { funded: false });
  const r = res();
  await handler({ method: 'GET', query: { action: 'billing' }, headers: {}, rawBody: '' }, r, { supabase: asSupabase(db), user: newUser, env: { BACHS_API_KEY: 'sk_sandbox_t', PUBLIC_APP_URL: 'https://app.example' } });
  assert.equal(r.code, 200);
  assert.equal(r.data.remaining, 0);
});

test('a phone call is refused for an account with no minutes, before anything reaches Twilio', async () => {
  const db = database({ phone_lines: [{ user_id: newUser.id, mode: 'own', phone_number: '+14155550000', status: 'verified' }] }, { funded: false });
  const out = await placeCall(asSupabase(db), newUser.id, { toNumber: '+14155552671', objective: 'hi', contactId: null });
  assert.match(out.error, /minutes exhausted/);
});

test('all three server entry points refuse a call at 0 minutes, and when the balance cannot be read', () => {
  for (const file of ['api/calls.js', 'api/social-calling.js', 'api/assistant.js']) {
    const src = read(file);
    assert.match(src, /minutesGate\(await minutesLeft\(supabase, userId\)\)/, file);
    assert.doesNotMatch(src, /left && left\.remaining <= 0/, `${file} must not let a call through when the balance is unreadable`);
  }
});

test('minutesGate: unreadable balance and empty balance both block; only a positive balance passes', () => {
  assert.deepEqual({ ...minutesGate(null) }, { ok: false, status: 503, code: 'minutes-unchecked', error: MINUTES_CHECK_FAILED_MESSAGE });
  assert.equal(minutesGate({ remaining: 0 }).status, 402);
  assert.equal(minutesGate({ remaining: 0 }).code, 'no-minutes');
  assert.equal(minutesGate({ remaining: 0.5 }).ok, true);
  assert.equal(minutesGate({ remaining: 30 }).ok, true);
});

test('minutesLeft reports a failed lookup as null (which the gate then refuses)', async () => {
  const broken = { rpc: async () => ({ data: null, error: null }), from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { message: 'connection reset' } }) }) }) }) };
  assert.equal(await minutesLeft(broken, 'u1'), null);
  assert.equal(minutesGate(await minutesLeft(broken, 'u1')).ok, false);
});

test('redeeming a referral code gives nobody minutes, and still records who referred whom', async () => {
  const db = database({ profiles: [{ user_id: 'friend', referral_code: 'ABC234' }, { user_id: newUser.id }] }, { funded: false });
  const r = res();
  await handler({ method: 'POST', query: { action: 'redeem' }, headers: {}, rawBody: JSON.stringify({ code: 'ABC234' }) }, r, { supabase: asSupabase(db), user: newUser, env: {} });
  assert.equal(r.code, 200);
  assert.equal(r.data.bonusMinutes, 0);
  assert.equal(db.tables.profiles.find((p) => p.user_id === newUser.id).referred_by, 'friend');
  assert.equal((db.tables.user_usage || []).length, 0, 'no usage row, so no minutes, for the new account or for the referrer');
});

test('the referral screen no longer promises minutes', () => {
  const html = read('index.html');
  const app = read('app.js');
  assert.doesNotMatch(html, /each get bonus calling minutes/);
  assert.doesNotMatch(app, /we both get bonus calling minutes/);
  assert.match(read('api/referrals.js'), /const BONUS_MINUTES = 0;/);
});

test('no code path falls back to a free allowance', () => {
  for (const file of ['lib/billing.js', 'lib/phoneCalls.js', 'api/admin.js', 'api/referrals.js', 'api/calls.js', 'api/assistant.js', 'api/social-calling.js']) {
    const src = read(file);
    assert.doesNotMatch(src, /monthly_minute_limit\s*\?\?\s*[1-9]/, `${file} must not default the limit above 0`);
    assert.doesNotMatch(src, /minutes_limit:[^\n]*\?\?\s*60/, file);
  }
});

test('the migration gives nobody free minutes and never reduces what was bought', () => {
  const sql = read('sql/044_new_users_start_at_zero.sql');
  assert.match(sql, /alter column monthly_minute_limit set default 0/);
  assert.match(sql, /set call_minutes_used = greatest\(0, call_minutes_used - monthly_minute_limit\),\s+monthly_minute_limit = 0/);
  assert.match(sql, /where monthly_minute_limit = 60;/);
  assert.doesNotMatch(sql, /set default 60/);
  assert.doesNotMatch(sql, /insert into user_usage/, 'no account is given a free 60 any more, approved or not');
  // nothing after this migration puts the 60 back
  const later = readdirSync(new URL('../sql/', import.meta.url)).filter((f) => f > '044');
  for (const f of later) assert.doesNotMatch(read(`sql/${f}`), /monthly_minute_limit[^\n]*default 60/, f);
});

test('there is no approval step left for new accounts', () => {
  const app = read('app.js');
  assert.doesNotMatch(app, /user_approvals/);
  assert.doesNotMatch(app, /checkApproval|startPendingPoll/);
  assert.doesNotMatch(app, /wait for approval/i);
  assert.match(app, /Check your email to confirm your account, then sign in\./);
});

import { loadApi, request } from './helpers.mjs';

test('starting a live call is refused (503) when the balance lookup fails, and nothing external is called', async () => {
  const db = database({}, { funded: false });
  const failing = { tables: db.tables, rpc: async () => ({ data: null, error: null }), from(table) {
    if (table !== 'user_usage') return db.from(table);
    const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: null, error: { message: 'connection reset' } }), then: (r) => r({ data: null, error: { message: 'connection reset' } }) };
    return q;
  } };
  const network = [];
  const { default: handler } = await loadApi('api/calls.js', failing, async (url) => { network.push(String(url)); return { ok: true, status: 200, json: async () => ({}) }; });
  const r = await request(handler, 'app-call-start', {});
  assert.equal(r.code, 503);
  assert.equal(r.data.code, 'minutes-unchecked');
  assert.equal(network.length, 0);
});

test('starting a live call with no minutes is refused (402) before anything is set up', async () => {
  const db = database({}, { funded: false });
  const { default: handler } = await loadApi('api/calls.js', db, async () => ({ ok: true, status: 200, json: async () => ({}) }));
  const r = await request(handler, 'app-call-start', {});
  assert.equal(r.code, 402);
  assert.equal(r.data.code, 'no-minutes');
});
