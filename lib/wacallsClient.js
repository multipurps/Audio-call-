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

import { getServiceClient } from './supabaseAdmin.js';

const WACALLS_URL = process.env.WACALLS_RELAY_URL; // e.g. https://wacalls-relay.onrender.com
const WACALLS_SECRET = process.env.WACALLS_INTERNAL_SECRET;

async function wacallsRequest(path, { userId, method = 'GET', body, timeoutMs = 35_000 } = {}) {
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
    signal: AbortSignal.timeout(timeoutMs),
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

// Connects a just-placed call to the Pipecat assistant instead of a human
// operator's browser, so Emysa can talk on it - the WhatsApp equivalent of
// mp-relay's POST /calls for Telegram. appSessionId/contactName/peerNumber
// are purely so WaCalls can report the call's end back into this app's own
// chat thread (see api/social-calling.js's relay-call-status action) -
// unrelated to placing or running the call itself.
//
// Timeout: the relay dials the assistant with up to 5 attempts, 6s each,
// 4s apart (cmd/server/aibridge.go) so it can ride out a cold Render
// instance - up to ~46s in the worst case. The default 35s request timeout
// used to abort this fetch first, which surfaced as a failed attach even
// though the relay was still going to connect the call. Vercel's function
// limit is 60s, so this stays under that.
export const ATTACH_TIMEOUT_MS = 52_000;

export async function wacallsAttachAI(userId, sessionId, callId, { appSessionId, contactName, peerNumber } = {}) {
  if (!callId) {
    // Without an id the URL would be /calls//ai and the relay would answer
    // "no such call", hiding the real problem (the start response had no id).
    const err = new Error('No call id to attach the assistant to');
    err.statusCode = 502;
    throw err;
  }
  // Every call speaks in the user's own cloned voice (Profile -> Voice), the
  // same rule the Twilio relay already follows. A lookup failure must never
  // block the call - it just falls back to the assistant's default voice.
  let voiceId;
  try {
    const { data: voice } = await getServiceClient()
      .from('voice_profiles').select('status, provider_voice_id').eq('user_id', userId).maybeSingle();
    if (voice?.status === 'ready' && voice.provider_voice_id) voiceId = voice.provider_voice_id;
  } catch (err) {
    console.warn('[wacalls] voice lookup failed; using default voice', { callId, error: err?.message });
  }
  console.log('[wacalls] attaching assistant', { callId, customVoice: Boolean(voiceId) });
  return wacallsRequest(`/api/sessions/${sessionId}/calls/${callId}/ai`, {
    userId,
    method: 'POST',
    body: { userId, sessionId: appSessionId, contactName, peerNumber, voiceId },
    timeoutMs: ATTACH_TIMEOUT_MS,
  });
}

const isTimeout = (err) => err?.name === 'TimeoutError' || err?.name === 'AbortError';
const maskPhone = (phone) => `***${String(phone || '').replace(/\D/g, '').slice(-2)}`;

// Places a WhatsApp call AND connects the assistant to it, as one step, so no
// caller can place a call that rings with nobody behind it (this is what
// api/social-calling.js's `call` action used to do).
//
//   * The relay's start response is { call: { callId } }; a response without
//     an id is an error, not a silent null.
//   * A definite attach failure (relay said no, network error) hangs the call
//     up and throws, so the user is told the truth instead of "Calling now"
//     followed by a silent line.
//   * An attach TIMEOUT is different: the relay may still be finishing its
//     retries and connect the call moments later, so hanging up could kill a
//     call that is about to work. It is reported as unconfirmed and the call
//     is left alone.
//
// Logs carry ids and outcomes only - never the secret, the token or the full
// phone number.
export async function wacallsPlaceAICall(userId, sessionId, phone, { appSessionId, contactName } = {}) {
  const started = await wacallsStartCall(userId, sessionId, phone);
  const callId = started?.call?.callId || started?.callId || null;
  if (!callId) {
    console.error('[wacalls] start-call response had no call id', { session: sessionId });
    const err = new Error('WhatsApp relay did not return a call id');
    err.statusCode = 502;
    throw err;
  }
  console.log('[wacalls] call started', { callId, session: sessionId, to: maskPhone(phone) });

  try {
    await wacallsAttachAI(userId, sessionId, callId, { appSessionId, contactName, peerNumber: phone });
    console.log('[wacalls] assistant attached', { callId });
    return { callId, aiAttached: true, started };
  } catch (err) {
    if (isTimeout(err)) {
      console.warn('[wacalls] assistant attach timed out; leaving the call up, attach is unconfirmed', { callId });
      return { callId, aiAttached: 'unconfirmed', started };
    }
    console.error('[wacalls] assistant attach failed; hanging up', { callId, status: err.statusCode, error: err.message });
    let hungUp = true;
    try {
      await wacallsHangup(userId, sessionId, callId);
    } catch (hangupErr) {
      hungUp = false;
      console.error('[wacalls] hangup after failed attach also failed', { callId, error: hangupErr.message });
    }
    const failure = new Error(`the call was placed but the assistant could not join it (${err.message})${hungUp ? '; I hung up' : '; hang up manually if it is still ringing'}`);
    failure.statusCode = err.statusCode && err.statusCode >= 400 ? err.statusCode : 502;
    throw failure;
  }
}
