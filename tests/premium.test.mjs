import test from 'node:test';
import assert from 'node:assert/strict';
import { database } from './helpers.mjs';
import handler from '../api/referrals.js';
import { planFor, planList, premiumState, expireFreeCredits } from '../lib/billing.js';

const env = { BACHS_API_KEY: 'sk_sandbox_test', PUBLIC_APP_URL: 'https://app.example', BACHS_CURRENCY: 'NGN' };
const user = { id: 'user-1', email: 'zee@example.com' };

// In-memory Supabase + the plan-aware credit_minute_purchase() from sql/037_premium.sql.
function fixture() {
  const db = database({ user_usage: [{ user_id: 'user-1', call_minutes_used: 0, monthly_minute_limit: 60, bonus_minutes: 0, premium_until: null }] });
  const rpcCalls = [];
  const supabase = {
    from: (t) => db.from(t),
    rpc: async (name, args) => {
      rpcCalls.push(name);
      if (name === 'expire_free_credits') return { data: null, error: null };
      const row = db.tables.minute_purchases.find((r) => r.reference === args.p_reference && r.status === 'pending');
      if (!row) return { data: 0, error: null };
      row.status = 'paid';
      const usage = db.tables.user_usage.find((u) => u.user_id === row.user_id);
      if (row.plan_months) { usage.premium_until = new Date(Date.now() + row.plan_months * 30 * 864e5).toISOString(); return { data: row.plan_months, error: null }; }
      usage.bonus_minutes += row.minutes;
      return { data: row.minutes, error: null };
    },
  };
  return { db, supabase, rpcCalls };
}
const res = () => ({ code: 200, data: null, status(c) { this.code = c; return this; }, json(d) { this.data = d; return this; } });
async function call(f, { action, method = 'POST', body = {}, extra = {} }) {
  const r = res();
  await handler({ method, query: { action }, headers: {}, rawBody: JSON.stringify(body) }, r, { supabase: f.supabase, user, env, ...extra });
  return r;
}

test('plans: server-side prices and percent off against paying monthly', () => {
  assert.deepEqual(planList(env).map((p) => [p.months, p.amount, p.percentOff]), [[1, 15000, 0], [3, 33000, 27], [6, 60000, 33], [12, 100000, 44]]);
  assert.equal(planFor(6, env).amount, '60000.00');
  assert.equal(planFor(6, env).currency, 'NGN');
  assert.equal(planFor(2, env), null);
  assert.equal(planFor('12; drop', env), null);
});

test('billing status lists the plans and premium state', async () => {
  const f = fixture();
  const r = await call(f, { action: 'billing', method: 'GET' });
  assert.equal(r.data.premium, false);
  assert.equal(r.data.plans.length, 4);
  assert.ok(f.rpcCalls.includes('expire_free_credits'));
});

test('premium checkout: price comes from the server, a client amount is ignored, bad plans refused', async () => {
  const f = fixture();
  let sent;
  const createCheckoutSession = async (input) => { sent = input; return { checkout_id: 'chk_p', checkout_url: 'https://checkout.bachs.io/chk_p' }; };
  const r = await call(f, { action: 'checkout', body: { plan: 3, amount: 1, minutes: 999 }, extra: { createCheckoutSession } });
  assert.equal(r.code, 200);
  assert.equal(sent.pack.amount, '33000.00');
  const row = f.db.tables.minute_purchases[0];
  assert.deepEqual([row.plan_months, row.minutes, row.pack_id, row.amount], [3, 0, 'premium-3m', 33000]);
  assert.equal((await call(f, { action: 'checkout', body: { plan: 5 }, extra: { createCheckoutSession } })).code, 400);
});

test('minute packs still work for premium and free users alike (no plan field, no plan_months)', async () => {
  const f = fixture();
  const createCheckoutSession = async () => ({ checkout_id: 'chk_m', checkout_url: 'https://checkout.bachs.io/chk_m' });
  const r = await call(f, { action: 'checkout', body: { quantity: 1 }, extra: { createCheckoutSession } });
  assert.equal(r.code, 200);
  assert.equal(f.db.tables.minute_purchases[0].plan_months, undefined);
  assert.ok(f.db.tables.minute_purchases[0].minutes > 0);
});

test('verify: a paid plan switches premium on once; no minutes are added; a replay changes nothing', async () => {
  const f = fixture();
  f.db.tables.minute_purchases = [{ id: 'p1', user_id: 'user-1', reference: 'emy_1', pack_id: 'premium-12m', minutes: 0, plan_months: 12, amount: 100000, currency: 'NGN', checkout_id: 'chk_1', status: 'pending', created_at: new Date().toISOString() }];
  const getCheckout = async () => ({ status: 'COMPLETED', reference: 'emy_1', amount: '100000.00', currency: 'NGN' });
  const first = await call(f, { action: 'billing-verify', extra: { getCheckout } });
  assert.equal(first.data.planActivated, 12);
  assert.equal(first.data.premium, true);
  assert.equal(first.data.remaining, 60); // no minutes credited by a plan
  const again = await call(f, { action: 'billing-verify', extra: { getCheckout } });
  assert.equal(again.data.planActivated, 0);
  assert.equal(again.data.premium, true);
});

test('premium state and expiry helper', async () => {
  assert.equal(premiumState({ premium_until: new Date(Date.now() + 1e6).toISOString() }).premium, true);
  assert.equal(premiumState({ premium_until: new Date(Date.now() - 1e6).toISOString() }).premium, false);
  assert.equal(premiumState(null).premiumUntil, null);
  const calls = [];
  await expireFreeCredits({ rpc: async (n, a) => { calls.push([n, a]); } }, 'u1');
  assert.deepEqual(calls, [['expire_free_credits', { p_user: 'u1' }]]);
  await expireFreeCredits({ rpc: async () => { throw new Error('not migrated'); } }, 'u1'); // must not throw
});

test('only a free user sees an expiry date on their credits', async () => {
  const f = fixture();
  const usage = f.db.tables.user_usage[0];
  usage.bonus_minutes = 30; usage.credit_expires_at = '2026-11-01T00:00:00Z';
  assert.equal((await call(f, { action: 'billing', method: 'GET' })).data.creditExpiresAt, '2026-11-01T00:00:00Z');
  usage.premium_until = new Date(Date.now() + 1e9).toISOString();
  assert.equal((await call(f, { action: 'billing', method: 'GET' })).data.creditExpiresAt, null);
});
