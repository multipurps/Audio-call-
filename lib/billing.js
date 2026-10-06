import crypto from 'node:crypto';

// Add-time payments through Bachs (https://bachs.io). Hosted checkout only:
// card details never touch Emysa. Minutes are credited by a signed webhook
// (or by the app asking us to verify with Bachs when the user comes back),
// never by the browser saying "I paid".

// Server-side price list. The app only ever sends a pack id, so a client can
// never choose its own price. Edit these, or override the whole list with the
// BACHS_PACKS env var (JSON array of { id, minutes, amount }).
// NOTE: Bachs minimums apply per currency (for example 1000 for NGN).
export const DEFAULT_PACKS = [
  { id: 'm30', minutes: 30, amount: '5.00' },
  { id: 'm60', minutes: 60, amount: '9.00' },
  { id: 'm120', minutes: 120, amount: '16.00' },
];

export function getCurrency(env = process.env) {
  return String(env.BACHS_CURRENCY || 'USD').trim().toUpperCase();
}

export function getPacks(env = process.env) {
  let packs = DEFAULT_PACKS;
  if (env.BACHS_PACKS) {
    try {
      const parsed = JSON.parse(env.BACHS_PACKS);
      if (Array.isArray(parsed) && parsed.length) packs = parsed;
    } catch { /* bad JSON: fall back to the defaults rather than break checkout */ }
  }
  const currency = getCurrency(env);
  return packs
    .map((p) => ({ id: String(p.id), minutes: Number(p.minutes), amount: String(p.amount), currency }))
    .filter((p) => p.id && Number.isFinite(p.minutes) && p.minutes > 0 && Number(p.amount) > 0);
}

export function remainingMinutes(usage) {
  const used = Number(usage?.call_minutes_used ?? 0);
  const limit = Number(usage?.monthly_minute_limit ?? 60) + Number(usage?.bonus_minutes ?? 0);
  return { used, limit, remaining: Math.max(0, limit - used) };
}

export function bachsBaseUrl(env = process.env) {
  if (env.BACHS_API_URL) return String(env.BACHS_API_URL).replace(/\/+$/, '');
  return String(env.BACHS_API_KEY || '').startsWith('sk_sandbox_')
    ? 'https://sandbox-api.bachs.io'
    : 'https://api.bachs.io';
}

async function bachsRequest(method, path, { body, idempotencyKey, env = process.env, fetchImpl = fetch } = {}) {
  const apiKey = env.BACHS_API_KEY;
  if (!apiKey) throw new Error('payments are not configured yet');
  const headers = { Accept: 'application/json', Authorization: `Bearer ${apiKey}` };
  if (body) headers['Content-Type'] = 'application/json';
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  const resp = await fetchImpl(`${bachsBaseUrl(env)}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await resp.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!resp.ok) {
    const err = new Error(data?.message || data?.error?.message || `Bachs request failed (${resp.status})`);
    err.status = resp.status;
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
