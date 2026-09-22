// Thin client for api/social-calling.js to reach mp-relay
// (github.com/multipurps/mp-relay), the MadelineProto-based Telegram login
// service that replaced the old fake-stub relay (server-social/social-relay.js's
// telegramCall, which sent a real RequestCall but with a placeholder/random
// g_a_hash instead of an actual Diffie-Hellman exchange - it could never
// have worked). This file only covers login; call-placing is a deliberately
// separate, later piece of work (see mp-relay's own README/commit history).

const MP_RELAY_URL = process.env.MP_RELAY_URL; // e.g. https://mp-relay.onrender.com
const MP_RELAY_SECRET = process.env.MP_RELAY_INTERNAL_SECRET;

export async function mpRelayRequest(path, { method = 'GET', body } = {}) {
  if (!MP_RELAY_URL || !MP_RELAY_SECRET) {
    const err = new Error('Telegram login relay not configured');
    err.statusCode = 500;
    throw err;
  }
  const resp = await fetch(`${MP_RELAY_URL}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Internal-Secret': MP_RELAY_SECRET,
    },
    body: body ? JSON.stringify(body) : undefined,
    // MadelineProto's login steps involve real round trips to Telegram's
    // own servers (not just our relay), plus a Render free-tier cold start
    // on top of that - same reasoning as the other two relays.
    signal: AbortSignal.timeout(35_000),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const err = new Error(data.error || `mp-relay request failed (${resp.status})`);
    err.statusCode = resp.status;
    throw err;
  }
  return data;
}
