// Thin client for api/social-calling.js to reach the WaCalls relay
// (github.com/multipurps/WaCalls, deployed on Render as `wacalls-relay`).
// Replaces the old Baileys-based WhatsApp path entirely - Baileys never
// reliably paired; WaCalls is whatsmeow-based (the library actually used
// in production by real WhatsApp multi-device clients) and supports both
// QR and numeric pairing-code linking.
//
// Unlike the Telegram/old-WhatsApp relay, WaCalls has no concept of "which
// of our users is this" - it only knows session ids. This file is what
// keeps that mapping (read/written to whatsapp_accounts.wacalls_session_id
// by the caller), and does the actual HTTP calls to WaCalls itself.

const WACALLS_URL = process.env.WACALLS_RELAY_URL; // e.g. https://wacalls-relay.onrender.com
const WACALLS_SECRET = process.env.WACALLS_INTERNAL_SECRET;

async function wacallsRequest(path, { userId, method = 'GET', body } = {}) {
  if (!WACALLS_URL || !WACALLS_SECRET) {
    const err = new Error('WhatsApp calling relay not configured');
    err.statusCode = 500;
    throw err;
  }
  const resp = await fetch(`${WACALLS_URL}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Internal-Secret': WACALLS_SECRET,
      // WaCalls scopes its "operator already on a call" conflict check by
      // this header, defaulting to a shared empty string if it's missing -
      // which would mean one user's active call wrongly blocks every other
      // user from placing one. Always send our own userId here so each of
      // our users is actually a distinct operator to WaCalls, not all of
      // them colliding into the same identity.
      ...(userId ? { 'X-Client-Id': userId } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    // Same reasoning as the other relay: a Render free-tier instance can be
    // cold, and pairing round trips take a few seconds regardless.
    signal: AbortSignal.timeout(35_000),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const err = new Error(data.error || `WaCalls relay request failed (${resp.status})`);
    err.statusCode = resp.status;
    throw err;
  }
  return data;
}

export async function wacallsCreateSession(userId, name, phone) {
  return wacallsRequest('/api/sessions', { userId, method: 'POST', body: { name, phone: phone || undefined } });
}

export async function wacallsDetail(userId, sessionId) {
  return wacallsRequest(`/api/sessions/${sessionId}`, { userId });
}

export async function wacallsPairWithCode(userId, sessionId, phone) {
  return wacallsRequest(`/api/sessions/${sessionId}/pair/code`, { userId, method: 'POST', body: { phone } });
}

export async function wacallsDelete(userId, sessionId) {
  return wacallsRequest(`/api/sessions/${sessionId}`, { userId, method: 'DELETE' });
}

export async function wacallsStartCall(userId, sessionId, phone) {
  // WaCalls' request field is literally named "phone", not "to" - checked
  // against the real handler (doStartCall in httpapi.go) rather than
  // assumed, since guessing this wrong would fail every single call.
  return wacallsRequest(`/api/sessions/${sessionId}/calls`, { userId, method: 'POST', body: { phone } });
}

export async function wacallsHangup(userId, sessionId, callId) {
  return wacallsRequest(`/api/sessions/${sessionId}/calls/${callId}`, { userId, method: 'DELETE' });
}
