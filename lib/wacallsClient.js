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

import { resolveVoiceChoice } from './voiceChoice.js';
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

export async function wacallsDetail(userId, sessionId, { timeoutMs } = {}) {
  return wacallsRequest(`/api/sessions/${sessionId}`, { userId, ...(timeoutMs ? { timeoutMs } : {}) });
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

// Recent calls for a session, newest first, each with endedAt/endReason once
// finished. The relay drops a call from its live registry the instant it
// ends, so this is the only place the reason survives.
export async function wacallsHistory(userId, sessionId, { timeoutMs = 6_000 } = {}) {
  return wacallsRequest(`/api/sessions/${sessionId}/history`, { userId, timeoutMs });
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
  // The relay only gets a voiceId when the user's cloned voice is the one they
  // CHOSE. A Standard (GPT-Live) choice sends none, so the clone can never force
  // the classic engine; the Pipecat service reads the same saved choice itself.
  // A lookup failure never blocks the call.
  let voiceId;
  let choice = null;
  try {
    choice = await resolveVoiceChoice(getServiceClient(), userId);
    if (choice.mode === 'custom') voiceId = choice.voiceId;
  } catch (err) {
    console.warn('[wacalls] voice lookup failed', { callId, error: err?.message });
  }
  console.log('[wacalls] attaching assistant', { callId, provider: choice?.provider || 'unknown', voice: choice ? (choice.mode === 'custom' ? 'clone' : choice.voiceId) : 'unknown', source: choice?.source || 'lookup-failed' });
  return wacallsRequest(`/api/sessions/${sessionId}/calls/${callId}/ai`, {
    userId,
    method: 'POST',
    body: { userId, sessionId: appSessionId, contactName, peerNumber, voiceId },
    timeoutMs: ATTACH_TIMEOUT_MS,
  });
}

// What the relay's end reasons mean to the person who asked for the call.
const END_REASON_TEXT = {
  declined: 'they declined the call',
  busy: 'their line was busy',
  timeout: "they didn't pick up",
  do_not_disturb: 'their phone is on Do Not Disturb',
  cancelled: 'the call was cancelled before it connected',
  user_ended: 'the call was ended before it connected',
  failed: "WhatsApp couldn't connect the call - check the number is on WhatsApp and that WhatsApp is still linked in Profile",
  unknown: 'WhatsApp ended the call before it connected',
};
export function describeEndReason(reason) {
  return END_REASON_TEXT[reason] || END_REASON_TEXT.unknown;
}

// Looks the call up in the relay's history. Never throws - this only adds
// detail to an error that is already being reported.
async function lookupCallOutcome(userId, sessionId, callId) {
  try {
    const { rows } = await wacallsHistory(userId, sessionId);
    const row = (rows || []).find((r) => r.callId === callId);
    if (!row) return { known: false };
    const ended = Boolean(row.endedAt || row.endReason);
    return { known: true, ended, endReason: row.endReason || 'unknown' };
  } catch (err) {
    console.warn('[wacalls] call history lookup failed', { callId, error: err?.message });
    return { known: false };
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const ATTACH_RETRY_DELAY_MS = 800;

const isTimeout = (err) => err?.name === 'TimeoutError' || err?.name === 'AbortError';
const maskPhone = (phone) => `***${String(phone || '').replace(/\D/g, '').slice(-2)}`;

// Places a WhatsApp call AND connects the assistant to it, as one step, so no
// caller can place a call that rings with nobody behind it (this is what
// api/social-calling.js's `call` action used to do).
//
//   * The relay's start response is { call: { callId } }; a response without
//     an id is an error, not a silent null.
//   * `onCallStarted({ callId })`, when provided, is awaited after the call
//     exists but BEFORE the assistant is attached. Callers use it to persist
//     the provider call id against their own `calls` row - the assistant
//     pipeline identifies its call by that id (bridge session "call-<id>"),
//     so the row must carry it before the bridge dials in.
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
const OPERATOR_BUSY = /operator already on a call/i;
const LEFTOVER_STATUSES = ['queued', 'ringing', 'in_progress'];

// The relay refuses a new call while it still counts an older call of this user
// as live. Hang up every recent WhatsApp call we know of for the user (ending a
// call on the relay is idempotent) and close any row still marked live. Shared
// by every path that places a WhatsApp call (chat, call screen, plans).
export async function releaseLeftoverWhatsappCalls(userId, sessionId, { exceptCallId = null } = {}) {
  const supabase = getServiceClient();
  const since = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
  const { data: rows } = await supabase
    .from('calls')
    .select('id, status, platform_call_id, created_at')
    .eq('user_id', userId)
    .eq('platform', 'whatsapp')
    .not('platform_call_id', 'is', null)
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(10);
  let stillOnCall = false;
  for (const c of rows || []) {
    if (exceptCallId && c.platform_call_id === exceptCallId) continue;
    const age = Date.now() - new Date(c.created_at).getTime();
    // Never cut a call the person is genuinely in, or one that is still dialling.
    if (c.status === 'in_progress') {
      // Our row says connected. Trust the relay: if it already ended the call
      // the row is a ghost; if it is genuinely live and recent, leave it alone.
      let ended = false;
      try { ended = !!(await lookupCallOutcome(userId, sessionId, c.platform_call_id))?.ended; } catch { /* unknown */ }
      if (!ended && age < 15 * 60_000) { stillOnCall = true; continue; }
    } else if (LEFTOVER_STATUSES.includes(c.status) && age < 150_000) { stillOnCall = true; continue; }
    await wacallsHangup(userId, sessionId, c.platform_call_id).catch((e) => {
      console.warn('[wacalls] leftover hangup failed', { callId: c.platform_call_id, error: e?.message });
    });
    if (LEFTOVER_STATUSES.includes(c.status)) {
      await supabase.from('calls').update({ status: 'canceled', ended_at: new Date().toISOString() })
        .eq('id', c.id).in('status', LEFTOVER_STATUSES);
    }
  }
  return { stillOnCall };
}

export async function wacallsPlaceAICall(userId, sessionId, phone, { appSessionId, contactName, onCallStarted, onOperatorBusy, busyRetryWaitsMs = [1200, 2500, 4000] } = {}) {
  let started;
  try {
    started = await wacallsStartCall(userId, sessionId, phone);
  } catch (err) {
    // The relay still counts an earlier call of this user as live (a call that
    // never reported its end). Hang those up, give the relay a moment, and try
    // once more instead of showing the user an error they cannot act on.
    if (err?.statusCode !== 409 || !OPERATOR_BUSY.test(String(err.message))) throw err;
    console.warn('[wacalls] relay says operator busy; clearing leftover calls and retrying once', { session: sessionId });
    try { await (onOperatorBusy ? onOperatorBusy() : releaseLeftoverWhatsappCalls(userId, sessionId)); } catch (cleanupErr) { console.warn('[wacalls] leftover-call cleanup failed', { error: cleanupErr?.message }); }
    let lastErr = err;
    let onAnotherCall = false;
    for (const wait of busyRetryWaitsMs) {
      await sleep(wait);
      try {
        started = await wacallsStartCall(userId, sessionId, phone);
        lastErr = null;
        break;
      } catch (retryErr) {
        if (!(retryErr?.statusCode === 409 && OPERATOR_BUSY.test(String(retryErr.message)))) throw retryErr;
        lastErr = retryErr;
        try { onAnotherCall = (await releaseLeftoverWhatsappCalls(userId, sessionId))?.stillOnCall || onAnotherCall; } catch { /* best effort */ }
      }
    }
    if (lastErr) {
      const busy = new Error(onAnotherCall
        ? 'you are still on another call - end it first, then try again'
        : 'a previous WhatsApp call is still being closed - say \"try again\" in a minute');
      busy.statusCode = 409;
      throw busy;
    }
  }
  const callId = started?.call?.callId || started?.callId || null;
  if (!callId) {
    console.error('[wacalls] start-call response had no call id', { session: sessionId });
    const err = new Error('WhatsApp relay did not return a call id');
    err.statusCode = 502;
    throw err;
  }
  console.log('[wacalls] call started', { callId, session: sessionId, to: maskPhone(phone) });

  if (typeof onCallStarted === 'function') {
    try {
      await onCallStarted({ callId });
    } catch (err) {
      // Without the persisted id the assistant cannot find its call row, so
      // the call would run blind. Hang up and fail loudly instead.
      console.error('[wacalls] persisting call id failed; hanging up', { callId, error: err.message });
      try {
        await wacallsHangup(userId, sessionId, callId);
      } catch (hangupErr) {
        console.error('[wacalls] hangup after persist failure also failed', { callId, error: hangupErr.message });
      }
      const failure = new Error(`the call started but could not be tracked (${err.message}); I hung up`);
      failure.statusCode = err.statusCode && err.statusCode >= 400 ? err.statusCode : 502;
      throw failure;
    }
  }

  try {
    try {
      await wacallsAttachAI(userId, sessionId, callId, { appSessionId, contactName, peerNumber: phone });
    } catch (firstErr) {
      // "no such call" (404) means the relay no longer has the call live.
      // Either it ENDED already (declined / busy / unreachable / WhatsApp
      // dropped it) or the attach simply beat the relay's own bookkeeping.
      // Ask the relay which, instead of guessing and reporting a vague error.
      if (firstErr?.statusCode !== 404) throw firstErr;
      const outcome = await lookupCallOutcome(userId, sessionId, callId);
      if (outcome.ended) {
        console.warn('[wacalls] call ended before the assistant could join', { callId, endReason: outcome.endReason });
        const ended = new Error(`the call ended before the assistant could join - ${describeEndReason(outcome.endReason)}`);
        // Deliberately NOT 404: callers read a 404 as "stale WhatsApp
        // session" and unlink the account. The session is fine here.
        ended.statusCode = 502;
        ended.callEnded = true;
        throw ended;
      }
      console.warn('[wacalls] attach said no such call but the call is not ended; retrying once', { callId, known: outcome.known });
      await sleep(ATTACH_RETRY_DELAY_MS);
      await wacallsAttachAI(userId, sessionId, callId, { appSessionId, contactName, peerNumber: phone });
    }
    console.log('[wacalls] assistant attached', { callId });
    return { callId, aiAttached: true, started };
  } catch (err) {
    if (err?.callEnded) throw err; // already ended - nothing to hang up
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
    // A 404 here is the relay's "no such call", not a dead session (that is
    // only ever reported by the start request) - never let it unlink WhatsApp.
    failure.statusCode = err.statusCode === 404 ? 502 : (err.statusCode && err.statusCode >= 400 ? err.statusCode : 502);
    throw failure;
  }
}
