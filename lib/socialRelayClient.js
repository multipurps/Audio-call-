// Thin client for api/social-calling.js to reach the always-on relay
// service (server-social/social-relay.js, deployed on Render). Vercel's
// serverless functions can't hold a long-lived Telegram/WhatsApp session
// between requests, so all of that state lives in the relay process — this
// file just forwards the authenticated user's request to it.
//
// Auth: a shared secret header, not the Supabase user JWT — the relay
// trusts Vercel as a whole and re-derives which user is asking from the
// userId this file passes explicitly (already verified upstream via
// getAuthedUserId). Never forward the raw user JWT to the relay.

const RELAY_URL = process.env.SOCIAL_RELAY_URL; // e.g. https://social-calling-relay.onrender.com
const RELAY_SECRET = process.env.SOCIAL_RELAY_INTERNAL_SECRET;

export async function relayRequest(path, { userId, method = 'GET', body } = {}) {
  if (!RELAY_URL || !RELAY_SECRET) {
    const err = new Error('Social calling relay not configured');
    err.statusCode = 500;
    throw err;
  }
  const resp = await fetch(`${RELAY_URL}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Internal-Secret': RELAY_SECRET,
      'X-User-Id': userId,
    },
    body: body ? JSON.stringify(body) : undefined,
    // Telegram OTP / WhatsApp QR round trips can take a few seconds, and a
    // Render free-tier instance can be cold (asleep) on top of that — give
    // the relay real room before giving up rather than aborting mid-wake.
    signal: AbortSignal.timeout(35_000),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const err = new Error(data.error || `Relay request failed (${resp.status})`);
    err.statusCode = resp.status;
    throw err;
  }
  return data;
}
