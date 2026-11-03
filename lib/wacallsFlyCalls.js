// WhatsApp calls through WaCalls on Fly, for the browser media leg (wacalls-media.js).
// Every step checks that the call belongs to the signed-in person before WaCalls is touched.
import { startFlyCall, submitFlyOffer, flyVideoStart, flyVideoAccept, flyEndCall, flyCallState } from './wacallsFly.js';
import { createCallRecord, markCallPlaced, markCallFailed } from './callSession.js';

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
    extra: { media: video ? 'video' : 'audio', contactName },
  });
  try {
    const { callId } = await start({ sid, phone: to, video: !!video });
    await mark(supabase, dbCall.id, { platformCallId: callId, status: 'ringing' });
    return { callId, dbCallId: dbCall.id, video: !!video };
  } catch (err) {
    await fail(supabase, dbCall.id, err.message).catch(() => {});
    throw err;
  }
}

// Relays the browser's SDP offer for this call and returns WaCalls' answer.
export async function relayFlyOffer({ supabase, userId, callId, sdpOffer, renegotiate = false, deps = {} }) {
  if (!sdpOffer) throw httpError(400, 'sdp_offer required');
  const { sid } = await resolveOwnedFlyCall(supabase, userId, callId);
  const submit = deps.submitFlyOffer || submitFlyOffer;
  const { sdpAnswer } = await submit({ sid, callId, sdpOffer, renegotiate });
  return { sdp_answer: sdpAnswer };
}

export async function videoStartFly({ supabase, userId, callId, deps = {} }) {
  const { sid } = await resolveOwnedFlyCall(supabase, userId, callId);
  await (deps.flyVideoStart || flyVideoStart)({ sid, callId });
  return { ok: true };
}

export async function videoAcceptFly({ supabase, userId, callId, deps = {} }) {
  const { sid } = await resolveOwnedFlyCall(supabase, userId, callId);
  await (deps.flyVideoAccept || flyVideoAccept)({ sid, callId });
  return { ok: true };
}

export async function endFlyCall({ supabase, userId, callId, deps = {} }) {
  const { sid, dbCallId } = await resolveOwnedFlyCall(supabase, userId, callId);
  await (deps.flyEndCall || flyEndCall)({ sid, callId }).catch((err) => {
    // Already gone on WaCalls is the same as ended.
    if (err?.statusCode !== 404) throw err;
  });
  await supabase.from('calls').update({ status: 'completed', ended_at: new Date().toISOString() }).eq('id', dbCallId);
  return { ok: true };
}

// Whether the callee has picked up (or the call ended), read from WaCalls. When the call has ended,
// the calls row is closed so the history matches.
export async function stateFlyCall({ supabase, userId, callId, deps = {} }) {
  const { sid, dbCallId } = await resolveOwnedFlyCall(supabase, userId, callId);
  const { state } = await (deps.flyCallState || flyCallState)({ sid, callId });
  if (state === 'ended') {
    await supabase.from('calls').update({ status: 'completed', ended_at: new Date().toISOString() }).eq('id', dbCallId).neq('status', 'completed');
  }
  return { state };
}
