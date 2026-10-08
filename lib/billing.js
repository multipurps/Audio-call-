import crypto from 'node:crypto';

// Add-time payments through Bachs (https://bachs.io). Hosted checkout only:
// card details never touch Emysa. Minutes are credited by a signed webhook
// (or by the app asking us to verify with Bachs when the user comes back),
// never by the browser saying "I paid".

// Server-side price. The app only ever sends a quantity (1x, 2x, ...), so a
// client can never choose its own price. One unit is UNIT_MINUTES of call time.
// Pricing is either:
//   - a price table: BACHS_PRICES="15000,28000,43000,53000,63000" where entry N is
//     the total price of N units (so bulk discounts work); max quantity = entries, or
//   - linear: BACHS_UNIT_AMOUNT x quantity, up to BACHS_MAX_QTY.
// Currency: BACHS_CURRENCY. Bachs minimums apply per currency (1000 for NGN).
export const DEFAULTS = { unitMinutes: 300, unitAmount: '30.00', maxQty: 10, currency: 'USD' };

export function getCurrency(env = process.env) {
  return String(env.BACHS_CURRENCY || DEFAULTS.currency).trim().toUpperCase();
}

function parsePrices(env) {
  if (!env.BACHS_PRICES) return null;
  const list = String(env.BACHS_PRICES).split(',').map((v) => Number(v.trim()));
  return list.length && list.every((n) => Number.isFinite(n) && n > 0) ? list.map((n) => n.toFixed(2)) : null;
}

export function getUnit(env = process.env) {
  const minutes = Number(env.BACHS_UNIT_MINUTES || DEFAULTS.unitMinutes);
  const amount = Number(env.BACHS_UNIT_AMOUNT || DEFAULTS.unitAmount);
  const maxQty = Math.floor(Number(env.BACHS_MAX_QTY || DEFAULTS.maxQty));
  const ok = Number.isFinite(minutes) && minutes > 0 && Number.isFinite(amount) && amount > 0 && maxQty >= 1;
  const prices = parsePrices(env);
  return {
    minutes: Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULTS.unitMinutes,
    amount: (ok ? amount : Number(DEFAULTS.unitAmount)).toFixed(2),
    maxQty: prices ? prices.length : (ok ? maxQty : DEFAULTS.maxQty),
    prices, // null = linear
    currency: getCurrency(env),
  };
}

// Whole units only. Returns the purchase the server will charge for, or null.
export function priceFor(quantity, env = process.env) {
  const unit = getUnit(env);
  const qty = Number(quantity);
  if (!Number.isInteger(qty) || qty < 1 || qty > unit.maxQty) return null;
  const amount = unit.prices ? unit.prices[qty - 1] : ((Math.round(Number(unit.amount) * 100) * qty) / 100).toFixed(2);
  return { id: `x${qty}`, quantity: qty, minutes: unit.minutes * qty, amount, currency: unit.currency };
}

export function remainingMinutes(usage) {
  const used = Number(usage?.call_minutes_used ?? 0);
  const limit = Number(usage?.monthly_minute_limit ?? 60) + Number(usage?.bonus_minutes ?? 0);
  return { used, limit, remaining: Math.max(0, limit - used) };
}

export async function minutesLeft(supabase, userId) {
  const { data, error } = await supabase.from('user_usage').select('call_minutes_used, monthly_minute_limit, bonus_minutes').eq('user_id', userId).maybeSingle();
  return error ? null : remainingMinutes(data); // null = could not check; callers let the call through
}

export const NO_MINUTES_MESSAGE = "You're out of call minutes. Add time to keep calling.";

export function bachsBaseUrl(env = process.env) {
  if (env.BACHS_API_URL) return String(env.BACHS_API_URL).replace(/\/+$/, '');
  return String(env.BACHS_API_KEY || '').startsWith('sk_sandbox_')
    ? 'https://sandbox-api.bachs.io'
    : 'https://api.bachs.io';
}

async function bachsRequest(method, path, { body, idempotencyKey, env = process.env, fetchImpl = fetch } = {}) {
  const apiKey = env.BACHS_API_KEY;
  if (!apiKey) throw new Error('payments are not configured yet');
  const headers = { Accept: 'application/json', 'User-Agent': 'emysa-billing/1.0', Authorization: `Bearer ${apiKey}` };
  if (body) headers['Content-Type'] = 'application/json';
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  const resp = await fetchImpl(`${bachsBaseUrl(env)}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await resp.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!resp.ok) {
    const err = new Error(data?.message || data?.error?.message || `Bachs request failed (${resp.status})`);
    err.status = resp.status;
    err.detail = (text || '').slice(0, 300); // Bachs' own explanation, for the server log only (never sent to the browser)
    throw err;
  }
  return data;
}

export function createCheckoutSession(input, opts = {}) {
  const { pack, reference, customer, successUrl, cancelUrl, userId } = input;
  return bachsRequest('POST', '/v1/checkout-sessions', {
    ...opts,
    idempotencyKey: reference,
    body: {
      reference,
      customer,
      success_url: successUrl,
      cancel_url: cancelUrl,
      expires_in_minutes: 60,
      pricing: { currency: pack.currency, amount: pack.amount, price_type: 'fixed' },
      metadata: { app: 'emysa', user_id: userId, pack_id: pack.id, minutes: pack.minutes },
    },
  });
}

export function getCheckout(checkoutId, opts = {}) {
  return bachsRequest('GET', `/v1/checkouts/${encodeURIComponent(checkoutId)}`, opts);
}

// Bachs signs "{timestamp}.{rawBody}" with HMAC-SHA256 (hex) using the
// endpoint's signing secret, sent as X-Bachs-Signature / X-Bachs-Timestamp.
export function verifyWebhookSignature(rawBody, headers, secret, { toleranceSeconds = 300, nowMs = Date.now() } = {}) {
  if (!secret) return false;
  const signature = String(headers['x-bachs-signature'] || '').trim();
  const timestamp = String(headers['x-bachs-timestamp'] || '').trim();
  const ts = Number(timestamp);
  if (!signature || !timestamp || !Number.isFinite(ts)) return false;
  if (Math.abs(Math.floor(nowMs / 1000) - Math.floor(ts)) > toleranceSeconds) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${timestamp}.`).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Pulls the checkout id out of a webhook event without assuming one exact
// shape. The id is only used as a lookup key: the real state is always
// re-read from Bachs before any minutes are credited.
export function checkoutIdFromEvent(event) {
  const obj = event?.data ?? event?.object ?? {};
  return obj.checkout_id
    || (event?.entity_type === 'checkout' ? event.entity_id : null)
    || null;
}

export function eventType(event) {
  return String(event?.event_type || event?.type || '');
}

export function sameAmount(a, b) {
  return Number.isFinite(Number(a)) && Number.isFinite(Number(b)) && Math.abs(Number(a) - Number(b)) < 0.005;
}

// ---------- Purchase lifecycle ----------
//
// A purchase row is created `pending` the moment the user taps Add time, long
// before any money moves. "Confirming payment" on Home must only show while a
// payment is genuinely in flight, so the server decides that from what the
// provider reports plus how long the checkout has been open, never from the
// mere existence of a pending row (which is what used to leave it stuck).

// An unfinished checkout stops counting as "in progress" after this long. The
// provider keeps the checkout payable for 60 minutes, but a person who has not
// paid within 15 has left; the row stays creditable if they pay late.
export const PURCHASE_PROGRESS_MAX_MS = 15 * 60 * 1000;
// A payment the provider says is being processed (submitted, not yet settled)
// may legitimately take until the checkout itself expires.
export const PURCHASE_PROCESSING_MAX_MS = 60 * 60 * 1000;
// A row with no checkout id never reached the provider; give the request that
// is creating it a moment, then it is dead.
export const PURCHASE_NO_CHECKOUT_GRACE_MS = 2 * 60 * 1000;

// Provider checkout status -> what it means for the purchase.
//   paid        credit the minutes
//   expired / cancelled / failed   terminal, nothing was charged
//   processing  payment submitted, waiting for the provider to settle
//   open        checkout exists, nobody has paid
export function classifyCheckoutState(state) {
  const s = String(state || '').toUpperCase();
  if (s === 'COMPLETED') return 'paid';
  if (s === 'EXPIRED') return 'expired';
  if (s === 'CANCELLED' || s === 'CANCELED') return 'cancelled';
  if (['FAILED', 'DECLINED', 'REJECTED', 'ERROR'].includes(s)) return 'failed';
  if (s.includes('PROCESS')) return 'processing';
  return 'open';
}

// Whether "confirming payment" may show for a pending purchase right now.
export function purchaseInProgress({ checkoutClass, ageMs }) {
  if (checkoutClass === 'processing') return ageMs < PURCHASE_PROCESSING_MAX_MS;
  return ageMs < PURCHASE_PROGRESS_MAX_MS; // open, or the provider could not be reached
}
