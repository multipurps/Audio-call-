import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { database } from './helpers.mjs';
import handler from '../api/referrals.js';
import { verifyWebhookSignature, getPacks, priceFor, remainingMinutes, DEFAULT_PACKS } from '../lib/billing.js';

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
  assert.deepEqual(r.data.packs, getPacks(env).packs);
  assert.equal(r.data.currency, 'NGN');
  assert.deepEqual(r.data.packs.map((p) => [p.minutes, p.amount]), [
    [30, '15000.00'], [60, '28000.00'], [120, '43000.00'], [180, '56000.00'], [240, '68000.00'], [300, '80000.00'],
  ]);
});

test('checkout: server decides the price from the quantity; bad quantities and missing config are refused', async () => {
  const f = fixture();
  let sent;
  const createCheckoutSession = async (input) => { sent = input; return { checkout_id: 'chk_new', checkout_url: 'https://checkout.bachs.io/chk_new' }; };
  for (const quantity of [0, -1, 1.5, 7, 11, '2; drop', null, undefined]) {
    const bad = await call(f, { action: 'checkout', body: { quantity }, extra: { createCheckoutSession } });
    assert.equal(bad.code, 400, String(quantity));
  }
  const off = await call(f, { action: 'checkout', body: { quantity: 1 }, extra: { env: { PUBLIC_APP_URL: 'https://app.example' } } });
  assert.equal(off.code, 503);
  const ok = await call(f, { action: 'checkout', body: { quantity: 2, amount: '0.01', minutes: 9999 }, extra: { createCheckoutSession } });
  assert.equal(ok.code, 200);
  assert.equal(ok.data.url, 'https://checkout.bachs.io/chk_new');
  assert.equal(sent.pack.amount, '28000.00', 'the server price for pack 2, whatever the client sent');
  assert.equal(sent.pack.minutes, 60);
  assert.equal(sent.successUrl, 'https://app.example/pay-return.html');
  assert.equal(sent.cancelUrl, `https://app.example/pay-return.html?pay=cancel&ref=${sent.reference}`, 'the cancel page carries the purchase reference so it can tell the server');
  const row = f.db.tables.minute_purchases[0];
  assert.equal(row.minutes, 60);
  assert.equal(row.amount, 28000);
  assert.equal(row.user_id, 'user-1');
  assert.equal(row.checkout_id, 'chk_new');
});

test('price list: the six Emysa packs in naira, in order', () => {
  const got = [1, 2, 3, 4, 5, 6].map((q) => priceFor(q, {}));
  assert.deepEqual(got.map((p) => p.minutes), [30, 60, 120, 180, 240, 300]);
  assert.deepEqual(got.map((p) => p.amount), ['15000.00', '28000.00', '43000.00', '56000.00', '68000.00', '80000.00']);
  assert.ok(got.every((p) => p.currency === 'NGN'));
  assert.deepEqual(priceFor(2, {}), { id: 'p60', quantity: 2, minutes: 60, amount: '28000.00', currency: 'NGN' });
  assert.equal(priceFor(7, {}), null);
  assert.equal(priceFor(0, {}), null);
  assert.equal(DEFAULT_PACKS.length, 6);
  // Bigger packs cost more in total but less per minute.
  const perMin = got.map((p) => Number(p.amount) / p.minutes);
  assert.ok(perMin.every((v, i) => i === 0 || v < perMin[i - 1]), 'bulk packs must be cheaper per minute');
});

test('price list: BACHS_PACKS overrides the defaults, and a bad table never charges 0', () => {
  const cfg = { BACHS_PACKS: '30:1000,60:1800', BACHS_CURRENCY: 'usd' };
  assert.deepEqual(getPacks(cfg).packs.map((p) => [p.minutes, p.amount]), [[30, '1000.00'], [60, '1800.00']]);
  assert.equal(getPacks(cfg).currency, 'USD');
  assert.equal(priceFor(2, cfg).minutes, 60);
  assert.equal(priceFor(3, cfg), null);
  for (const bad of ['30:abc', '30', '30:0', '0:100', '30:100:5', '30:100,30:200', ':100', '30:-5', '']) {
    assert.deepEqual(getPacks({ BACHS_PACKS: bad }).packs, getPacks({}).packs, `ignored: ${JSON.stringify(bad)}`);
  }
  // The old per-unit settings are retired: leftover values in Vercel change nothing.
  assert.deepEqual(getPacks({ BACHS_PRICES: '1,2,3', BACHS_UNIT_MINUTES: '5', BACHS_UNIT_AMOUNT: '1' }), getPacks({}));
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

test('admins are alerted once per paid purchase: not on a replay, a failure, or a pending checkout', async () => {
  const f = fixture({ minute_purchases: [pending()] });
  const alerts = [];
  const notifyAdmins = async (_db, purchase) => { alerts.push(purchase.reference); };
  const extra = { getCheckout: completed(), notifyAdmins };
  const first = await webhook(f, event, {}, extra);
  assert.equal(first.code, 200);
  assert.deepEqual(alerts, ['emy_1'], 'one alert for the purchase that was credited');
  assert.equal(f.db.tables.minute_purchases[0].status, 'paid');
  await webhook(f, event, {}, extra);
  await webhook(f, event, {}, extra);
  assert.deepEqual(alerts, ['emy_1'], 'a replayed webhook never alerts again');

  const g = fixture({ minute_purchases: [pending()] });
  const none = [];
  await webhook(g, event, {}, { getCheckout: async () => ({ status: 'PENDING', reference: 'emy_1', amount: '9.00', currency: 'USD' }), notifyAdmins: async (_d, p) => { none.push(p.reference); } });
  assert.deepEqual(none, [], 'an unpaid checkout sends no alert');
});

test('a failing admin alert never costs the buyer their minutes or fails the webhook', async () => {
  const f = fixture({ minute_purchases: [pending()] });
  const r = await webhook(f, event, {}, { getCheckout: completed(), notifyAdmins: async () => { throw new Error('push service down'); } });
  assert.equal(r.code, 200);
  assert.equal(f.db.tables.minute_purchases[0].status, 'paid');
  assert.equal(f.db.tables.user_usage[0].bonus_minutes, 60, 'the minutes were credited');
});
