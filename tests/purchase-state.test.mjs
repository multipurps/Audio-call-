// Minutes purchase state machine. "Confirming payment" on Home must show only
// while a payment is genuinely in flight, and must recover the true state from
// the server and the payment provider every time Home asks, never from stale
// client state.
import test from 'node:test';
import assert from 'node:assert/strict';
import { database } from './helpers.mjs';
import handler from '../api/referrals.js';
import {
  classifyCheckoutState, purchaseInProgress,
  PURCHASE_PROGRESS_MAX_MS, PURCHASE_NO_CHECKOUT_GRACE_MS,
} from '../lib/billing.js';

const env = { BACHS_API_KEY: 'sk_sandbox_test', BACHS_WEBHOOK_SECRET: 'whsec_test', PUBLIC_APP_URL: 'https://app.example' };
const user = { id: 'user-1', email: 'zee@example.com' };
const MIN = 60 * 1000;
const REF = 'emy_11111111-1111-4111-8111-111111111111';

function fixture(purchases = []) {
  const db = database({
    user_usage: [{ user_id: 'user-1', call_minutes_used: 12, monthly_minute_limit: 60, bonus_minutes: 0 }],
    minute_purchases: purchases,
  });
  const supabase = {
    from: (t) => db.from(t),
    // mirrors credit_minute_purchase() in sql/025_minute_purchases.sql
    rpc: async (_name, { p_reference }) => {
      const row = db.tables.minute_purchases.find((r) => r.reference === p_reference && r.status === 'pending');
      if (!row) return { data: 0, error: null };
      row.status = 'paid';
      db.tables.user_usage[0].bonus_minutes += row.minutes;
      return { data: row.minutes, error: null };
    },
  };
  return { db, supabase };
}

const purchase = (over = {}) => ({
  id: 'p1', user_id: 'user-1', reference: REF, pack_id: 'x1', minutes: 300, amount: 30, currency: 'USD',
  checkout_id: 'chk_1', checkout_url: 'https://checkout.bachs.io/chk_1', status: 'pending',
  created_at: new Date().toISOString(), ...over,
});
const agoIso = (ms) => new Date(Date.now() - ms).toISOString();
const provider = (status, over = {}) => async () => ({ status, reference: REF, amount: '30.00', currency: 'USD', ...over });

function res() { return { code: 200, data: null, status(c) { this.code = c; return this; }, json(d) { this.data = d; return this; } }; }
async function api(f, action, { method = 'POST', body = {}, extra = {} } = {}) {
  const r = res();
  await handler({ method, query: { action }, headers: {}, rawBody: JSON.stringify(body) }, r, { supabase: f.supabase, user, env, ...extra });
  return r;
}
const status = (f) => f.db.tables.minute_purchases[0].status;

// ---------------------------------------------------------------- 1. successful payment

test('successful payment: in progress while open, then credited and the new balance returned', async () => {
  const f = fixture([purchase()]);
  const during = await api(f, 'billing', { method: 'GET', extra: { getCheckout: provider('OPEN') } });
  assert.equal(during.data.pending, true, 'payment progress shows while the checkout is open');
  assert.equal(during.data.remaining, 48);

  const after = await api(f, 'billing-verify', { extra: { getCheckout: provider('COMPLETED') } });
  assert.equal(after.data.pending, false);
  assert.equal(after.data.credited, 300);
  assert.equal(after.data.remaining, 348, 'balance reflects the purchase');
  assert.deepEqual(JSON.parse(JSON.stringify(after.data.outcome)), { id: 'credited', state: 'paid' });
  assert.equal(status(f), 'paid');
});

test('a paid checkout is credited exactly once however often Home asks', async () => {
  const f = fixture([purchase()]);
  await api(f, 'billing', { method: 'GET', extra: { getCheckout: provider('COMPLETED') } });
  await api(f, 'billing', { method: 'GET', extra: { getCheckout: provider('COMPLETED') } });
  await api(f, 'billing-verify', { extra: { getCheckout: provider('COMPLETED') } });
  assert.equal(f.db.tables.user_usage[0].bonus_minutes, 300);
});

// ---------------------------------------------------------------- 2. failed payment

test('failed payment: progress clears and the failure is reported', async () => {
  const f = fixture([purchase()]);
  const r = await api(f, 'billing', { method: 'GET', extra: { getCheckout: provider('FAILED') } });
  assert.equal(r.data.pending, false);
  assert.equal(r.data.remaining, 48, 'nothing credited');
  assert.equal(r.data.outcome.state, 'failed');
  assert.equal(r.data.outcome.id, 'p1');
  assert.equal(status(f), 'failed');
});

test('failed state needs the optional migration; without it the purchase still closes (as cancelled)', async () => {
  const f = fixture([purchase()]);
  const real = f.supabase.from;
  f.supabase.from = (t) => {
    const q = real(t);
    if (t !== 'minute_purchases') return q;
    return { ...q, update: (patch) => (patch.status === 'failed' ? { eq: () => ({ eq: async () => ({ error: { message: 'violates check constraint' } }) }) } : q.update(patch)) };
  };
  const r = await api(f, 'billing', { method: 'GET', extra: { getCheckout: provider('DECLINED') } });
  assert.equal(r.data.pending, false);
  assert.equal(status(f), 'cancelled');
});

// ---------------------------------------------------------------- 3. cancelled payment

test('cancelled on the provider: progress clears immediately and says so', async () => {
  const f = fixture([purchase()]);
  const r = await api(f, 'billing', { method: 'GET', extra: { getCheckout: provider('CANCELLED') } });
  assert.equal(r.data.pending, false);
  assert.equal(r.data.outcome.state, 'cancelled');
  assert.equal(status(f), 'cancelled');
});

test('cancel page: clears progress at once even while the provider still lists the checkout as open', async () => {
  const f = fixture([purchase()]);
  const c = await api(f, 'billing-cancel', { body: { reference: REF }, extra: { getCheckout: provider('OPEN') } });
  assert.equal(c.code, 200);
  assert.equal(status(f), 'cancelled');
  const home = await api(f, 'billing', { method: 'GET', extra: { getCheckout: provider('OPEN') } });
  assert.equal(home.data.pending, false, 'Home no longer shows confirming payment');
  assert.equal(home.data.outcome.state, 'cancelled');
});

test('cancel page never cancels a payment that was actually made: it is credited', async () => {
  const f = fixture([purchase()]);
  const c = await api(f, 'billing-cancel', { body: { reference: REF }, extra: { getCheckout: provider('COMPLETED') } });
  assert.equal(c.data.credited, 300);
  assert.equal(status(f), 'paid');
});

test('cancel page: needs a valid reference, ignores unknown or already-closed purchases, works without a session', async () => {
  const f = fixture([purchase()]);
  assert.equal((await api(f, 'billing-cancel', { body: { reference: 'nope' } })).code, 400);
  assert.equal((await api(f, 'billing-cancel', { method: 'GET', body: {} })).code, 405);
  const unknown = await api(f, 'billing-cancel', { body: { reference: 'emy_22222222-2222-4222-8222-222222222222' } });
  assert.equal(unknown.code, 200);
  assert.equal(status(f), 'pending', 'someone else\'s reference changes nothing');
  const r = res();
  await handler({ method: 'POST', query: { action: 'billing-cancel' }, headers: {}, rawBody: JSON.stringify({ reference: REF }) }, r, { supabase: f.supabase, user: null, env, getCheckout: provider('OPEN') });
  assert.equal(r.code, 200, 'no session required');
  assert.equal(status(f), 'cancelled');
});

test('a checkout cancelled locally is still credited if the provider later says it was paid', async () => {
  const f = fixture([purchase({ status: 'cancelled' })]);
  const { default: webhookHandler } = { default: handler };
  const crypto = await import('node:crypto');
  const raw = JSON.stringify({ event_type: 'checkout.completed', entity_type: 'checkout', entity_id: 'chk_1', data: { checkout_id: 'chk_1' } });
  const ts = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', 'whsec_test').update(`${ts}.${raw}`).digest('hex');
  const r = res();
  await webhookHandler({ method: 'POST', query: { action: 'webhook' }, headers: { 'x-bachs-signature': sig, 'x-bachs-timestamp': String(ts) }, rawBody: raw }, r, { supabase: f.supabase, env, getCheckout: provider('COMPLETED') });
  assert.equal(r.data.credited, 300, 'someone who really paid never loses their minutes');
  assert.equal(status(f), 'paid');
});

// ---------------------------------------------------------------- 4. abandoned payment

test('abandoned payment: an unpaid checkout stops showing progress after the timeout, without being lost', async () => {
  const f = fixture([purchase({ created_at: agoIso(PURCHASE_PROGRESS_MAX_MS + MIN) })]);
  const r = await api(f, 'billing', { method: 'GET', extra: { getCheckout: provider('OPEN') } });
  assert.equal(r.data.pending, false, 'no stuck "confirming payment"');
  assert.equal(status(f), 'pending', 'still creditable if they pay late');
  const late = await api(f, 'billing-verify', { extra: { getCheckout: provider('COMPLETED') } });
  assert.equal(late.data.credited, 300);
  assert.equal(late.data.remaining, 348);
});

test('abandoned before the checkout ever opened: closed after a short grace, never stuck', async () => {
  const fresh = fixture([purchase({ checkout_id: null, checkout_url: null, created_at: agoIso(10 * 1000) })]);
  assert.equal((await api(fresh, 'billing', { method: 'GET' })).data.pending, true, 'just starting: progress is right');
  const dead = fixture([purchase({ checkout_id: null, checkout_url: null, created_at: agoIso(PURCHASE_NO_CHECKOUT_GRACE_MS + 10 * 1000) })]);
  const r = await api(dead, 'billing', { method: 'GET' });
  assert.equal(r.data.pending, false);
  assert.equal(status(dead), 'cancelled');
});

test('a provider outage can never leave the spinner stuck: only the clock decides', async () => {
  const down = async () => { throw new Error('provider down'); };
  const recent = fixture([purchase()]);
  assert.equal((await api(recent, 'billing', { method: 'GET', extra: { getCheckout: down } })).data.pending, true);
  const old = fixture([purchase({ created_at: agoIso(PURCHASE_PROGRESS_MAX_MS + MIN) })]);
  assert.equal((await api(old, 'billing', { method: 'GET', extra: { getCheckout: down } })).data.pending, false);
});

test('a payment the provider says is processing may take longer than an open checkout', async () => {
  const f = fixture([purchase({ created_at: agoIso(PURCHASE_PROGRESS_MAX_MS + 5 * MIN) })]);
  assert.equal((await api(f, 'billing', { method: 'GET', extra: { getCheckout: provider('PROCESSING') } })).data.pending, true);
});

test('expired checkout: progress clears and the person is told it expired', async () => {
  const f = fixture([purchase()]);
  const r = await api(f, 'billing', { method: 'GET', extra: { getCheckout: provider('EXPIRED') } });
  assert.equal(r.data.pending, false);
  assert.equal(r.data.outcome.state, 'expired');
  assert.equal(status(f), 'expired');
});

// ---------------------------------------------------------------- 5. page refresh during payment

test('refresh mid-payment: each page load recovers the state from the server, with no client state involved', async () => {
  const f = fixture([purchase()]);
  // "page load" 1, 2, 3: brand-new requests, nothing carried between them.
  for (let i = 0; i < 3; i++) {
    const r = await api(f, 'billing', { method: 'GET', extra: { getCheckout: provider('OPEN') } });
    assert.equal(r.data.pending, true, `load ${i + 1} still in progress`);
  }
  // The payment completes while the page is closed and the webhook never arrives.
  const reopened = await api(f, 'billing', { method: 'GET', extra: { getCheckout: provider('COMPLETED') } });
  assert.equal(reopened.data.pending, false);
  assert.equal(reopened.data.remaining, 348, 'reopening picks up the credit');
  assert.equal(reopened.data.credited, 300);
});

test('refresh after a cancel or failure shows the right state, and a stale pending row cannot revive progress', async () => {
  const f = fixture([purchase()]);
  await api(f, 'billing-cancel', { body: { reference: REF }, extra: { getCheckout: provider('OPEN') } });
  for (let i = 0; i < 3; i++) {
    const r = await api(f, 'billing', { method: 'GET', extra: { getCheckout: provider('OPEN') } });
    assert.equal(r.data.pending, false);
  }
});

test('only the signed-in user\'s purchases are reconciled', async () => {
  const f = fixture([purchase({ id: 'other', user_id: 'user-2', reference: 'emy_33333333-3333-4333-8333-333333333333', checkout_id: 'chk_2' })]);
  const r = await api(f, 'billing', { method: 'GET', extra: { getCheckout: provider('COMPLETED') } });
  assert.equal(r.data.pending, false);
  assert.equal(f.db.tables.minute_purchases[0].status, 'pending');
  assert.equal(r.data.remaining, 48);
});

// ---------------------------------------------------------------- pure rules

test('provider states map to purchase states, and only COMPLETED ever means paid', () => {
  assert.equal(classifyCheckoutState('COMPLETED'), 'paid');
  assert.equal(classifyCheckoutState('completed'), 'paid');
  assert.equal(classifyCheckoutState('EXPIRED'), 'expired');
  assert.equal(classifyCheckoutState('CANCELED'), 'cancelled');
  assert.equal(classifyCheckoutState('DECLINED'), 'failed');
  assert.equal(classifyCheckoutState('PROCESSING'), 'processing');
  for (const unknown of ['OPEN', 'CREATED', 'PENDING', '', null, undefined, 'SOMETHING_NEW']) assert.equal(classifyCheckoutState(unknown), 'open');
  assert.equal(purchaseInProgress({ checkoutClass: 'open', ageMs: 60 * 1000 }), true);
  assert.equal(purchaseInProgress({ checkoutClass: 'open', ageMs: PURCHASE_PROGRESS_MAX_MS + 1 }), false);
});
