// WhatsApp calls through WaCalls on Fly, for the browser media leg (wacalls-media.js).
// Every step checks that the call belongs to the signed-in person before WaCalls is touched.
import { startFlyCall, submitFlyOffer, flyVideoStart, flyVideoAccept, flyEndCall, flyCallState, flyClearCalls } from './wacallsFly.js';
import { createCallRecord, markCallPlaced, markCallFailed, maybeGenerateCallSummary, formatSummaryForChat, postCallChatMessage } from './callSession.js';

// Keeps the transcript the browser sends to a sane size: only text turns, bounded length and count.
export function sanitizeTranscript(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  for (const t of input.slice(0, 500)) {
    const content = String(t?.content ?? t?.text ?? '').trim().slice(0, 2000);
    if (!content) continue;
    const role = t?.role === 'user' ? 'user' : 'assistant';
    out.push({ role, content });
  }
  return out;
}

function httpError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

// The person's WhatsApp session on WaCalls (set when they linked WhatsApp). 409 when not linked.
export async function resolveFlyAccount(supabase, userId) {
  const { data: row } = await supabase
    .from('whatsapp_accounts')
    .select('wacalls_session_id')
    .eq('user_id', userId)
    .maybeSingle();
  if (!row?.wacalls_session_id) throw httpError(409, 'WhatsApp is not linked. Connect it in Connected accounts first.');
  return row.wacalls_session_id;
}

// Looks a WaCalls call up in this person's calls. 404 when it is not theirs or does not exist.
export async function resolveOwnedFlyCall(supabase, userId, platformCallId) {
  if (!platformCallId) throw httpError(400, 'callId required');
  const sid = await resolveFlyAccount(supabase, userId);
  const { data: row } = await supabase
    .from('calls')
    .select('id')
    .eq('user_id', userId)
    .eq('platform', 'whatsapp')
    .eq('platform_call_id', platformCallId)
    .maybeSingle();
  if (!row?.id) throw httpError(404, 'no such call');
  return { sid, dbCallId: row.id };
}

// Places the call on WaCalls (audio or video) after the calls row exists, so the call screen can follow it.
// Turns WaCalls' technical error into a sentence a person can act on.
export function plainCallError(message = '') {
  const m = String(message);
  if (/HTTP 404|no such session/i.test(m)) return 'WhatsApp is not connected anymore. Open Connected accounts and link WhatsApp again.';
  if (/not linked/i.test(m)) return 'WhatsApp is not connected. Open Connected accounts and link WhatsApp first.';
  if (/operator already on a call/i.test(m)) return 'Another WhatsApp call is still open. Wait a moment, then try again.';
  if (/usync|no LID|not on WhatsApp|peer unreachable/i.test(m)) return "WhatsApp couldn't find that number. Check the number is right and is on WhatsApp, then try again.";
  if (/websocket not connected|disconnected/i.test(m)) return 'WhatsApp is disconnected right now. Open Connected accounts to check it, then try again.';
  return 'The WhatsApp call could not start. Try again in a moment.';
}

// A failure to start is recorded on the row and rethrown with the real reason.
export async function startFlyWhatsappCall({
  supabase, userId, to, video = false, objective = '', instructions = null, contactId = null, contactName = null, sessionId = null,
  deps = {},
}) {
  const start = deps.startFlyCall || startFlyCall;
  const create = deps.createCallRecord || createCallRecord;
  const mark = deps.markCallPlaced || markCallPlaced;
  const fail = deps.markCallFailed || markCallFailed;
  if (!to) throw httpError(400, 'to required');
  const sid = await resolveFlyAccount(supabase, userId);
  const dbCall = await create(supabase, userId, {
    platform: 'whatsapp', toNumber: to, objective, instructions, contactId, sessionId,
  });
  try {
    let started;
    try {
      started = await start({ sid, phone: to, video: !!video, clientId: userId });
    } catch (err) {
      // WaCalls allows one call per session. An earlier call it still counts as live blocks this one
      // (409). Those calls are ours and already over, so clear them and try once more.
      if (err?.statusCode !== 409 || !/operator already on a call/i.test(String(err.message))) throw err;
      await closeStaleFlyCalls({ supabase, userId, sid, deps });
      started = await start({ sid, phone: to, video: !!video, clientId: userId });
    }
    const { callId } = started;
    await mark(supabase, dbCall.id, { platformCallId: callId, status: 'ringing' });
    return { callId, dbCallId: dbCall.id, video: !!video };
  } catch (err) {
    // The person sees a plain sentence. The technical text goes to the server log only.
    console.warn('[wacalls-fly] call failed', { error: err?.message, statusCode: err?.statusCode });
    // Only WaCalls' own 'no such session' answer clears the link. Any other 404 (for example a wrong route) keeps it.
    if (err?.statusCode === 404 && /no such session/i.test(String(err.message))) {
      try {
        await supabase.from('whatsapp_accounts').update({ wacalls_session_id: null, status: 'disconnected', display_name: null }).eq('user_id', userId);
      } catch (_) { /* the call error is still shown */ }
    }
    const plain = plainCallError(err?.message);
    await fail(supabase, dbCall.id, plain).catch(() => {});
    throw Object.assign(new Error(plain), { statusCode: err?.statusCode || 500 });
  }
}

// Clears the session on WaCalls and closes this person's WhatsApp rows that still look live.
async function closeStaleFlyCalls({ supabase, userId, sid, deps = {} }) {
  await (deps.flyClearCalls || flyClearCalls)({ sid, clientId: userId }).catch((err) => console.warn('[wacalls-fly] clear calls failed', { error: err?.message }));
  await supabase.from('calls').update({ status: 'canceled', ended_at: new Date().toISOString() })
    .eq('user_id', userId).eq('platform', 'whatsapp').in('status', ['queued', 'ringing', 'in_progress']);
}

// Relays the browser's SDP offer for this call and returns WaCalls' answer.
export async function relayFlyOffer({ supabase, userId, callId, sdpOffer, renegotiate = false, deps = {} }) {
  if (!sdpOffer) throw httpError(400, 'sdp_offer required');
  const { sid } = await resolveOwnedFlyCall(supabase, userId, callId);
  const submit = deps.submitFlyOffer || submitFlyOffer;
  const { sdpAnswer } = await submit({ sid, callId, sdpOffer, renegotiate, clientId: userId });
  return { sdp_answer: sdpAnswer };
}

export async function videoStartFly({ supabase, userId, callId, deps = {} }) {
  const { sid } = await resolveOwnedFlyCall(supabase, userId, callId);
  await (deps.flyVideoStart || flyVideoStart)({ sid, callId, clientId: userId });
  return { ok: true };
}

export async function videoAcceptFly({ supabase, userId, callId, deps = {} }) {
  const { sid } = await resolveOwnedFlyCall(supabase, userId, callId);
  await (deps.flyVideoAccept || flyVideoAccept)({ sid, callId, clientId: userId });
  return { ok: true };
}

export async function endFlyCall({ supabase, userId, callId, transcript = [], deps = {} }) {
  const { sid, dbCallId } = await resolveOwnedFlyCall(supabase, userId, callId);
  await (deps.flyEndCall || flyEndCall)({ sid, callId, clientId: userId }).catch((err) => {
    // Already gone on WaCalls is the same as ended.
    if (err?.statusCode !== 404) throw err;
  });
  await supabase.from('calls').update({
    status: 'completed', ended_at: new Date().toISOString(), transcript: sanitizeTranscript(transcript),
  }).eq('id', dbCallId).neq('status', 'completed');
  const summary = await finishFlyCallSummary({ supabase, userId, dbCallId, deps });
  return { ok: true, summary: summary.status };
}

// Makes the summary for a finished WhatsApp call and posts it to the chat, as the relay path does.
async function finishFlyCallSummary({ supabase, userId, dbCallId, deps = {} }) {
  const summarise = deps.maybeGenerateCallSummary || maybeGenerateCallSummary;
  const post = deps.postCallChatMessage || postCallChatMessage;
  const format = deps.formatSummaryForChat || formatSummaryForChat;
  try {
    const result = await summarise(supabase, dbCallId, { notify: true });
    if (result?.status !== 'completed' || !result.summary) return { status: result?.status || 'none' };
    const { data: row } = await supabase.from('calls').select('session_id').eq('id', dbCallId).maybeSingle();
    await post(supabase, { userId, sessionId: row?.session_id || null, callId: dbCallId, text: format(result.summary, result.summaryJson || {}) });
    return { status: 'posted' };
  } catch (err) {
    console.warn('[wacalls-fly] summary failed', { callId: dbCallId, error: err?.message });
    return { status: 'error' };
  }
}

// Whether the callee has picked up (or the call ended), read from WaCalls. When the call has ended,
// the calls row is closed so the history matches.
export async function stateFlyCall({ supabase, userId, callId, deps = {} }) {
  const { sid, dbCallId } = await resolveOwnedFlyCall(supabase, userId, callId);
  const { state } = await (deps.flyCallState || flyCallState)({ sid, callId, clientId: userId });
  if (state === 'ended') {
    await supabase.from('calls').update({ status: 'completed', ended_at: new Date().toISOString() }).eq('id', dbCallId).neq('status', 'completed');
  }
  return { state };
}
