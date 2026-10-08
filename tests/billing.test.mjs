import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { database } from './helpers.mjs';
import handler from '../api/referrals.js';
import { verifyWebhookSignature, getUnit, priceFor, remainingMinutes } from '../lib/billing.js';

const SECRET = 'whsec_test';
const env = { BACHS_API_KEY: 'sk_sandbox_test', BACHS_WEBHOOK_SECRET: SECRET, PUBLIC_APP_URL: 'https://app.example' };
const user = { id: 'user-1', email: 'zee@example.com' };

// In-memory Supabase plus the credit_minute_purchase() Postgres function,
// mirroring sql/025_minute_purchases.sql.
function fixture(seed = {}) {
  const db = database({ user_usage: [{ user_id: 'user-1', call_minutes_used: 12, monthly_minute_limit: 60, bonus_minutes: 0 }], ...seed });
  const supabase = {
    from: (t) => db.from(t),
    rpc: async (name, { p_reference }) => {
      assert.equal(name, 'credit_minute_purchase');
      const row = db.tables.minute_purchases.find((r) => r.reference === p_reference && r.status === 'pending');
      if (!row) return { data: 0, error: null };
      row.status = 'paid';
      const usage = db.tables.user_usage.find((u) => u.user_id === row.user_id);
      if (usage) usage.bonus_minutes += row.minutes; else db.tables.user_usage.push({ user_id: row.user_id, bonus_minutes: row.minutes });
      return { data: row.minutes, error: null };
    },
  };
  return { db, supabase };
}

function res() { return { code: 200, data: null, status(c) { this.code = c; return this; }, json(d) { this.data = d; return this; } }; }
async function call(f, { action, method = 'POST', body = {}, extra = {}, headers = {} }) {
  const r = res();
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  await handler({ method, query: { action }, headers, rawBody: raw }, r, { supabase: f.supabase, user, env, ...extra });
  return r;
}
function signed(body, { secret = SECRET, ts = Math.floor(Date.now() / 1000) } = {}) {
  const raw = JSON.stringify(body);
  const sig = crypto.createHmac('sha256', secret).update(`${ts}.${raw}`).digest('hex');
  return { raw, headers: { 'x-bachs-signature': sig, 'x-bachs-timestamp': String(ts) } };
}
const pending = (over = {}) => ({ id: 'p1', user_id: 'user-1', reference: 'emy_1', pack_id: 'm60', minutes: 60, amount: 9, currency: 'USD', checkout_id: 'chk_1', checkout_url: 'https://checkout.bachs.io/chk_1', status: 'pending', created_at: new Date().toISOString(), ...over });
const completed = (over = {}) => async () => ({ status: 'COMPLETED', reference: 'emy_1', amount: '9.00', currency: 'USD', ...over });

async function webhook(f, event, opts = {}, extra = {}) {
  const { raw, headers } = signed(event, opts);
  const r = res();
  await handler({ method: 'POST', query: { action: 'webhook' }, headers, rawBody: raw }, r, { supabase: f.supabase, env, ...extra });
  return r;
}
const event = { event_type: 'checkout.completed', entity_type: 'checkout', entity_id: 'chk_1', data: { checkout_id: 'chk_1' } };

test('signature: valid, tampered, stale and missing', () => {
  const body = JSON.stringify({ a: 1 });
  const { headers } = signed({ a: 1 });
  assert.equal(verifyWebhookSignature(Buffer.from(body), headers, SECRET), true);
  assert.equal(verifyWebhookSignature(Buffer.from(body + ' '), headers, SECRET), false);
  assert.equal(verifyWebhookSignature(Buffer.from(body), headers, 'other'), false);
  assert.equal(verifyWebhookSignature(Buffer.from(body), {}, SECRET), false);
  assert.equal(verifyWebhookSignature(Buffer.from(body), headers, ''), false);
  const old = signed({ a: 1 }, { ts: Math.floor(Date.now() / 1000) - 3600 });
  assert.equal(verifyWebhookSignature(Buffer.from(body), old.headers, SECRET), false);
});

test('balance is limit + bonus - used, never negative', () => {
  assert.deepEqual(remainingMinutes({ call_minutes_used: 12, monthly_minute_limit: 60, bonus_minutes: 0 }), { used: 12, limit: 60, remaining: 48 });
  assert.equal(remainingMinutes({ call_minutes_used: 90, monthly_minute_limit: 60, bonus_minutes: 0 }).remaining, 0);
  assert.equal(remainingMinutes(null).remaining, 60);
});

test('billing status returns balance and the server price list', async () => {
  const f = fixture();
  const r = await call(f, { action: 'billing', method: 'GET', body: '' });
  assert.equal(r.code, 200);
  assert.equal(r.data.remaining, 48);
  assert.equal(r.data.payments, true);
  assert.deepEqual(r.data.unit, getUnit(env));
  assert.deepEqual(r.data.unit, { minutes: 300, amount: '30.00', maxQty: 10, prices: null, currency: 'USD' });
});

test('checkout: server decides the price from the quantity; bad quantities and missing config are refused', async () => {
  const f = fixture();
  let sent;
  const createCheckoutSession = async (input) => { sent = input; return { checkout_id: 'chk_new', checkout_url: 'https://checkout.bachs.io/chk_new' }; };
  for (const quantity of [0, -1, 1.5, 11, '2; drop', null, undefined]) {
    const bad = await call(f, { action: 'checkout', body: { quantity }, extra: { createCheckoutSession } });
    assert.equal(bad.code, 400, String(quantity));
  }
  const off = await call(f, { action: 'checkout', body: { quantity: 1 }, extra: { env: { PUBLIC_APP_URL: 'https://app.example' } } });
  assert.equal(off.code, 503);
  const ok = await call(f, { action: 'checkout', body: { quantity: 2, amount: '0.01', minutes: 9999 }, extra: { createCheckoutSession } });
  assert.equal(ok.code, 200);
  assert.equal(ok.data.url, 'https://checkout.bachs.io/chk_new');
  assert.equal(sent.pack.amount, '60.00');
  assert.equal(sent.pack.minutes, 600);
  assert.equal(sent.successUrl, 'https://app.example/pay-return.html');
  assert.equal(sent.cancelUrl, `https://app.example/pay-return.html?pay=cancel&ref=${sent.reference}`, 'the cancel page carries the purchase reference so it can tell the server');
  const row = f.db.tables.minute_purchases[0];
  assert.equal(row.minutes, 600);
  assert.equal(row.amount, 60);
  assert.equal(row.user_id, 'user-1');
  assert.equal(row.checkout_id, 'chk_new');
});

test('price table: Emysa NGN tiers, bulk discounts, capped at the last tier', () => {
  const cfg = { BACHS_CURRENCY: 'NGN', BACHS_UNIT_MINUTES: '60', BACHS_PRICES: '15000,28000,43000,53000,63000' };
  const got = [1, 2, 3, 4, 5].map((q) => priceFor(q, cfg));
  assert.deepEqual(got.map((p) => p.amount), ['15000.00', '28000.00', '43000.00', '53000.00', '63000.00']);
  assert.deepEqual(got.map((p) => p.minutes), [60, 120, 180, 240, 300]);
  assert.equal(got[0].currency, 'NGN');
  assert.equal(priceFor(6, cfg), null);
  assert.equal(getUnit(cfg).maxQty, 5);
  assert.equal(getUnit({ BACHS_PRICES: '10,abc' }).prices, null); // bad table falls back, never charges 0
});

test('price: unit x quantity, configurable, no float drift', () => {
  assert.deepEqual(priceFor(1, {}), { id: 'x1', quantity: 1, minutes: 300, amount: '30.00', currency: 'USD' });
  assert.equal(priceFor(10, {}).amount, '300.00');
  assert.equal(priceFor(11, {}), null);
  const cfg = { BACHS_UNIT_MINUTES: '60', BACHS_UNIT_AMOUNT: '9.99', BACHS_MAX_QTY: '3', BACHS_CURRENCY: 'ngn' };
  assert.deepEqual(priceFor(3, cfg), { id: 'x3', quantity: 3, minutes: 180, amount: '29.97', currency: 'NGN' });
  assert.equal(priceFor(4, cfg), null);
  assert.equal(getUnit({ BACHS_UNIT_AMOUNT: 'abc' }).amount, '30.00'); // bad config falls back, never charges 0
});

test('checkout: a second tap reuses the open checkout instead of creating another', async () => {
  const f = fixture();
  let created = 0;
  const createCheckoutSession = async () => { created += 1; return { checkout_id: `chk_${created}`, checkout_url: `https://checkout.bachs.io/chk_${created}` }; };
  const a = await call(f, { action: 'checkout', body: { quantity: 1 }, extra: { createCheckoutSession } });
  const b = await call(f, { action: 'checkout', body: { quantity: 1 }, extra: { createCheckoutSession } });
  assert.equal(created, 1);
  assert.equal(a.data.url, b.data.url);
  assert.equal(f.db.tables.minute_purchases.length, 1);
});

test('checkout: a Bachs failure cancels the purchase and returns a plain error', async () => {
  const f = fixture();
  const createCheckoutSession = async () => { throw new Error('boom'); };
  const r = await call(f, { action: 'checkout', body: { quantity: 1 }, extra: { createCheckoutSession } });
  assert.equal(r.code, 502);
  assert.equal(f.db.tables.minute_purchases[0].status, 'cancelled');
  assert.ok(!/boom/.test(JSON.stringify(r.data)));
});

test('webhook: credits the minutes once, replays add nothing', async () => {
  const f = fixture({ minute_purchases: [pending()] });
  const extra = { getCheckout: completed() };
  const first = await webhook(f, event, {}, extra);
  assert.equal(first.code, 200);
  assert.equal(first.data.credited, 60);
  assert.equal(f.db.tables.user_usage[0].bonus_minutes, 60);
  const replay = await webhook(f, event, {}, extra);
  assert.equal(replay.code, 200);
  assert.equal(replay.data.credited, 0);
  assert.equal(f.db.tables.user_usage[0].bonus_minutes, 60);
});

test('webhook: bad signature is refused and nothing is credited', async () => {
  const f = fixture({ minute_purchases: [pending()] });
  const r = await webhook(f, event, { secret: 'attacker' }, { getCheckout: completed() });
  assert.equal(r.code, 401);
  assert.equal(f.db.tables.user_usage[0].bonus_minutes, 0);
});

test('webhook: other events are acknowledged without crediting', async () => {
  const f = fixture({ minute_purchases: [pending()] });
  const r = await webhook(f, { ...event, event_type: 'collection.failed' }, {}, { getCheckout: completed() });
  assert.equal(r.code, 200);
  assert.equal(f.db.tables.user_usage[0].bonus_minutes, 0);
});

test('webhook: Bachs must confirm COMPLETED, the right reference and the right amount', async () => {
  for (const state of [{ status: 'OPEN' }, { amount: '1.00' }, { currency: 'NGN' }, { reference: 'emy_other' }]) {
    const f = fixture({ minute_purchases: [pending()] });
    const r = await webhook(f, event, {}, { getCheckout: completed(state) });
    assert.equal(r.code, 200);
    assert.equal(f.db.tables.user_usage[0].bonus_minutes, 0, JSON.stringify(state));
  }
});

test('webhook: an expired checkout is marked, a Bachs outage returns 500 so Bachs retries', async () => {
  const f = fixture({ minute_purchases: [pending()] });
  await webhook(f, event, {}, { getCheckout: completed({ status: 'EXPIRED' }) });
  assert.equal(f.db.tables.minute_purchases[0].status, 'expired');
  const g = fixture({ minute_purchases: [pending()] });
  const r = await webhook(g, event, {}, { getCheckout: async () => { throw new Error('down'); } });
  assert.equal(r.code, 500);
  assert.equal(g.db.tables.minute_purchases[0].status, 'pending');
});

test('verify (user returns to the app): credits a paid checkout without waiting for the webhook, only once', async () => {
  const f = fixture({ minute_purchases: [pending(), pending({ id: 'p2', reference: 'emy_other', user_id: 'user-2', checkout_id: 'chk_2' })] });
  const r1 = await call(f, { action: 'billing-verify', extra: { getCheckout: completed() } });
  assert.equal(r1.data.credited, 60);
  assert.equal(r1.data.remaining, 108);
  assert.equal(r1.data.pending, false);
  const r2 = await call(f, { action: 'billing-verify', extra: { getCheckout: completed() } });
  assert.equal(r2.data.credited, 0);
  assert.equal(r2.data.remaining, 108);
  // another user's purchase is never touched
  assert.equal(f.db.tables.minute_purchases.find((p) => p.id === 'p2').status, 'pending');
});

test('verify: an unpaid checkout stays pending and credits nothing', async () => {
  const f = fixture({ minute_purchases: [pending()] });
  const r = await call(f, { action: 'billing-verify', extra: { getCheckout: completed({ status: 'OPEN' }) } });
  assert.equal(r.data.credited, 0);
  assert.equal(r.data.pending, true);
});

test('actions that need a user are refused when signed out; webhook never needs a session', async () => {
  const f = fixture();
  const r = res();
  await handler({ method: 'POST', query: { action: 'checkout' }, headers: {}, rawBody: '{}' }, r, { supabase: f.supabase, user: null, env });
  assert.equal(r.code, 401);
});
