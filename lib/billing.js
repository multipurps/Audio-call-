import crypto from 'node:crypto';

// Add-time payments through Bachs (https://bachs.io). Hosted checkout only:
// card details never touch Emysa. Minutes are credited by a signed webhook
// (or by the app asking us to verify with Bachs when the user comes back),
// never by the browser saying "I paid".

// Server-side price list. The app only ever sends WHICH pack it wants (1 = the
// first pack, 2 = the second, ...), so a client can never choose its own price
// or minutes. Packs are explicit (minutes + total price), so any length can have
// any price, bulk discounts included.
//
// Default packs, in the currency below (Nigerian naira):
//   30 min 15,000 · 1 h 28,000 · 2 h 43,000 · 3 h 56,000 · 4 h 68,000 · 5 h 80,000
// To change them without a code change, set BACHS_PACKS in Vercel as
// "minutes:price,minutes:price,...", for example "30:15000,60:28000". A table
// that does not parse is ignored, never half used, so a typo cannot charge 0.
// The older BACHS_PRICES / BACHS_UNIT_* settings are no longer read.
// Currency: BACHS_CURRENCY (default NGN). Bachs minimums apply per currency
// (1000 for NGN).
export const DEFAULT_PACKS = [
  { minutes: 30, amount: 15000 },
  { minutes: 60, amount: 28000 },
  { minutes: 120, amount: 43000 },
  { minutes: 180, amount: 56000 },
  { minutes: 240, amount: 68000 },
  { minutes: 300, amount: 80000 },
];
export const DEFAULTS = { currency: 'NGN' };

export function getCurrency(env = process.env) {
  return String(env.BACHS_CURRENCY || DEFAULTS.currency).trim().toUpperCase();
}

function parsePacks(env) {
  if (!env.BACHS_PACKS) return null;
  const packs = String(env.BACHS_PACKS).split(',').map((part) => {
    const [m, a, extra] = part.split(':').map((v) => v.trim());
    return { minutes: Number(m), amount: Number(a), bad: extra !== undefined || m === '' || a === '' || a === undefined };
  });
  const ok = packs.length > 0 && packs.every((p) => !p.bad && Number.isInteger(p.minutes) && p.minutes > 0 && Number.isFinite(p.amount) && p.amount > 0)
    && new Set(packs.map((p) => p.minutes)).size === packs.length;
  return ok ? packs.map(({ minutes, amount }) => ({ minutes, amount })) : null;
}

// What the app shows and what the server will charge, in one place.
export function getPacks(env = process.env) {
  const list = parsePacks(env) || DEFAULT_PACKS;
  return {
    currency: getCurrency(env),
    packs: list.map((p) => ({ id: `p${p.minutes}`, minutes: p.minutes, amount: Number(p.amount).toFixed(2) })),
  };
}

// `quantity` is the 1-based position in the pack list. Returns the purchase the
// server will charge for, or null.
export function priceFor(quantity, env = process.env) {
  const { packs, currency } = getPacks(env);
  const n = Number(quantity);
  if (!Number.isInteger(n) || n < 1 || n > packs.length) return null;
  const pack = packs[n - 1];
  return { id: pack.id, quantity: n, minutes: pack.minutes, amount: pack.amount, currency };
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
