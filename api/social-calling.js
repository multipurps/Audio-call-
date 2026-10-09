import { getServiceClient, getAuthedUserId } from '../lib/supabaseAdmin.js';
import { minutesLeft, NO_MINUTES_MESSAGE } from '../lib/billing.js';
import { resolveWhatsappStatus } from '../lib/whatsappStatus.js';
import { attemptStateForProviderStatus } from '../lib/callAttempts.js';
import { describeSocialCallEnd } from '../lib/socialCallEnd.js';
import { wacallsCreateSession, wacallsDetail, wacallsPairWithCode, wacallsDelete, wacallsPlaceAICall, wacallsHangup } from '../lib/wacallsClient.js';
import { mpRelayRequest } from '../lib/mpRelayClient.js';
import { signalStartLink, signalLinkStatus, signalRemoveAccount, signalPlaceCall, signalHangup } from '../lib/signalClient.js';
import { resolvePersonSession } from '../lib/personSession.js';
import {
  createCallRecord,
  markCallPlaced,
  markCallFailed,
  recordAttemptEvent,
  findDuplicateActiveCall,
  appendTranscriptEntry,
  maybeGenerateCallSummary,
  formatSummaryForChat,
  waitForCallSummary,
  postCallChatMessage,
} from '../lib/callSession.js';

// Telegram + WhatsApp account linking and calling, combined into one file
// behind ?action=... — same reason as api/admin.js and api/call-answering.js:
// Vercel's Hobby plan caps a deployment at 12 serverless functions, and this
// app was already at that cap before this feature. Splitting Telegram and
// WhatsApp into separate files would push it over.
//
// Telegram: login (phone/OTP/2FA) now goes through mp-relay
// (github.com/multipurps/mp-relay), a MadelineProto-based service, separate
// Render deployment - not the old relay. The old relay's telegramCall sent
// a real RequestCall but with a placeholder/random g_a_hash instead of an
// actual Diffie-Hellman exchange (see that file's own comments); it could
// never have produced a working call. This file still forwards Telegram
// *call-placing* to that old relay for now (line ~181) - fixing login
// first, call-placing is deliberately its own separate next step, not
// bundled into this pass.
//
// WhatsApp: moved off that same old relay (it used Baileys, which never
// reliably paired) onto WaCalls (github.com/multipurps/WaCalls, a
// whatsmeow-based Go service, separate Render deployment). WaCalls has no
// concept of "which of our users is this" - only session ids - so this
// file owns that mapping via whatsapp_accounts.wacalls_session_id.
// auth_state_encrypted is the old Baileys column and is no longer written.
export default async function handler(req, res) {
  const supabase = getServiceClient();

  // Server-to-server callback from mp-relay reporting a Telegram call's
  // outcome (see mp-relay's CallBridge::reportOutcome) - not a
  // user-authenticated browser request, so this runs before the
  // getAuthedUserId gate below and checks its own shared secret instead.
  if ((req.query?.action || req.body?.action) === 'relay-call-status') {
    return relayCallStatus(req, res, supabase);
  }

  const userId = await getAuthedUserId(req, supabase);
  if (!userId) return res.status(401).json({ error: 'Not signed in' });

  const action = req.query?.action || req.body?.action;

  try {
    switch (action) {
      case 'telegram-start': return await telegramStart(req, res, supabase, userId);
      case 'telegram-verify': return await telegramVerify(req, res, supabase, userId);
      case 'telegram-disconnect': return await telegramDisconnect(req, res, supabase, userId);
      case 'whatsapp-start': return await whatsappStart(req, res, supabase, userId);
      case 'whatsapp-start-phone': return await whatsappStartWithPhone(req, res, supabase, userId);
      case 'whatsapp-status': return await whatsappStatus(req, res, supabase, userId);
      case 'whatsapp-disconnect': return await whatsappDisconnect(req, res, supabase, userId);
      case 'signal-start': return await signalStart(req, res, supabase, userId);
      case 'signal-status': return await signalStatus(req, res, supabase, userId);
      case 'signal-disconnect': return await signalDisconnect(req, res, supabase, userId);
      case 'call':
      case 'place-call': return await placeCall(req, res, supabase, userId);
      case 'hangup': return await hangupSocialCall(req, res, supabase, userId);
      default: return await status(req, res, supabase, userId);
    }
  } catch (err) {
    // Both relayRequest() (Telegram) and the wacalls* client (WhatsApp)
    // throw with statusCode set for anything the relay itself reported.
    return res.status(err.statusCode || 500).json({ error: err.message || 'Social calling request failed' });
  }
}

// mp-relay's reportOutcome doesn't have this app's calls.id (it never gets
// one back from POST /calls - see that handler), so the in-flight call is
// matched the same way a person would: this user's most recent still-ringing
// Telegram call to that same number. Set RELAY_CALLBACK_SECRET the same on
// both mp-relay and here for this to be checked, and APP_API_URL on mp-relay
// to this app's real deployed domain.
const PLATFORM_LABELS = { whatsapp: 'WhatsApp', telegram: 'Telegram', signal: 'Signal', app: 'Emysa' };

async function relayCallStatus(req, res, supabase) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const incomingSecret = req.headers?.['x-relay-secret'] || req.headers?.['x-internal-secret'];
  const validSecrets = [
    process.env.RELAY_CALLBACK_SECRET,
    process.env.MP_RELAY_INTERNAL_SECRET,
    process.env.SOCIAL_RELAY_INTERNAL_SECRET,
    process.env.WACALLS_INTERNAL_SECRET,
    // The pipecat assistant service authenticates with the same bridge
    // secret mp-relay/WaCalls use. It reports a call's end (with the final
    // transcript) when the carrier's own callback never arrived, so a call
    // that the assistant ended itself still gets its status, summary and
    // chat follow-up instead of being stuck on "ringing" forever.
    process.env.ASSISTANT_BRIDGE_SECRET,
  ].filter(Boolean);
  if (!incomingSecret || !validSecrets.includes(incomingSecret)) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  // platform was hardcoded to 'telegram' here, from when only mp-relay
  // called this. wacalls-relay (WhatsApp) now calls it too and does send
  // platform - generalized so a WhatsApp report doesn't get mislabeled as
  // Telegram (wrong social_calls row, and it would never match a `calls`
  // row since that lookup also hardcoded 'telegram'). Defaults to
  // 'telegram' only for an older mp-relay build that predates this field.
  const {
    userId: bodyUserId,
    sessionId,
    callId: incomingCallId,
    platformCallId,
    status: rawCallStatus,
    peerIdentifier,
    contactName,
    durationSeconds,
    transcript,
    transcriptEntry,
    platform = 'telegram',
    reason: rawReason,
  } = req.body || {};
  if ((!bodyUserId && !incomingCallId && !platformCallId) || (!peerIdentifier && !incomingCallId && !platformCallId) || !rawCallStatus) {
    return res.status(400).json({ error: 'userId (or callId), peerIdentifier (or callId) and status required' });
  }
  if (!['whatsapp', 'telegram', 'signal', 'app'].includes(platform)) return res.status(400).json({ error: 'platform must be whatsapp, telegram, signal or app' });

  // A real chat-session uuid. WaCalls sends the app's own chat session id
  // here; the pipecat end-report and mp-relay send carrier bridge ids
  // ("call-42") instead — never insert those as a chat session id (FK).
  const bodySessionId = typeof sessionId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId) ? sessionId : null;

  const statusNormalizeMap = {
    ringing: 'ringing',
    answered: 'in_progress',
    active: 'in_progress',
    'in-progress': 'in_progress',
    in_progress: 'in_progress',
    transcript: 'in_progress',
    completed: 'completed',
    ended: 'completed',
    'no-answer': 'no_answer',
    no_answer: 'no_answer',
    unanswered: 'no_answer',
    // A rejection is its own outcome so the call screen can say "Call rejected".
    rejected: 'rejected',
    declined: 'rejected',
    busy: 'busy',
    canceled: 'canceled',
    cancelled: 'canceled',
    failed: 'failed',
    // "disconnected" with talk time is a completed call cut by the network;
    // with no talk time it never connected at all. It MUST normalize to a
    // terminal status — an unmapped value leaves the row stuck forever and
    // no summary is ever generated.
    disconnected: Number(durationSeconds) > 0 ? 'completed' : 'failed',
  };
  const callStatus = statusNormalizeMap[String(rawCallStatus).toLowerCase()] || rawCallStatus;
  const isTerminal = ['completed', 'rejected', 'no_answer', 'failed', 'busy', 'canceled'].includes(callStatus);
  const isAnswer = ['in_progress'].includes(callStatus);

  // The provider call id may arrive directly, or encoded in the bridge
  // session id ("call-42" -> "42"). Try every form so a report can always
  // find the exact row it is about rather than falling back to "the most
  // recent call to this number", which can hit the wrong call.
  const platformCallIdCandidates = [];
  if (platformCallId) platformCallIdCandidates.push(String(platformCallId));
  if (typeof sessionId === 'string' && sessionId.startsWith('call-') && sessionId.length > 5) {
    platformCallIdCandidates.push(sessionId.slice('call-'.length));
  }

  let call = null;
  if (incomingCallId) {
    let q = supabase
      .from('calls')
      .select('id, user_id, contact_id, status, transcript, session_id, answered_at, created_at, platform_call_id')
      .eq('id', incomingCallId);
    if (bodyUserId) q = q.eq('user_id', bodyUserId);
    const { data } = await q.maybeSingle();
    call = data;
  }
  for (const candidate of platformCallIdCandidates) {
    if (call) break;
    let q = supabase
      .from('calls')
      .select('id, user_id, contact_id, status, transcript, session_id, answered_at, created_at, platform_call_id')
      .eq('platform', platform)
      .eq('platform_call_id', candidate);
    if (bodyUserId) q = q.eq('user_id', bodyUserId);
    const { data } = await q
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    call = data;
  }
  const userId = bodyUserId || call?.user_id || null;
  const activeStatuses = ['ringing', 'in_progress', 'queued'];
  // Session-scoped matching first: this call was placed from a known chat
  // conversation, so that conversation's own call is the one being reported
  // on — never some other conversation's more recent call to the same person.
  if (!call && bodySessionId && userId) {
    let q = supabase
      .from('calls')
      .select('id, user_id, contact_id, status, transcript, session_id, answered_at, created_at, platform_call_id')
      .eq('user_id', userId)
      .eq('platform', platform)
      .eq('session_id', bodySessionId)
      .in('status', activeStatuses)
      .order('created_at', { ascending: false })
      .limit(10);
    if (peerIdentifier) q = q.eq('to_number', peerIdentifier);
    const { data: rows } = await q;
    call = rows?.[0] || null;
    // Fall back to the session's own latest active call even when the peer
    // number formatting differs slightly between report and row.
    if (!call && peerIdentifier) {
      const { data: looseRows } = await supabase
        .from('calls')
        .select('id, user_id, contact_id, status, transcript, session_id, answered_at, created_at, platform_call_id')
        .eq('user_id', userId)
        .eq('platform', platform)
        .eq('session_id', bodySessionId)
        .in('status', activeStatuses)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      call = looseRows;
    }
  }
  if (!call && peerIdentifier && userId) {
    const { data } = await supabase
      .from('calls')
      .select('id, user_id, contact_id, status, transcript, session_id, answered_at, created_at, platform_call_id')
      .eq('user_id', userId)
      .eq('platform', platform)
      .eq('to_number', peerIdentifier)
      .in('status', activeStatuses)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    call = data;
  }

  // A report that names a provider call id belongs to THAT call only. If the row we
  // landed on (by number / session fallback) is a different provider call, the event is
  // from an earlier attempt: ignore it instead of letting it end or alter this one.
  const reportedId = platformCallIdCandidates[0] || null;
  if (call && reportedId && call.platform_call_id && !platformCallIdCandidates.includes(String(call.platform_call_id))) {
    return res.status(200).json({ ok: true, callId: call.id, ignored: 'event from another attempt' });
  }

  // A late "ringing" report must never pull an answered/finished call back.
  if (callStatus === 'ringing' && call && !['queued', 'ringing'].includes(call.status)) {
    return res.status(200).json({ ok: true, callId: call.id, ignored: 'late ringing' });
  }

  if (call) {
    const callUpdate = { status: callStatus };
    if (durationSeconds) callUpdate.duration_seconds = durationSeconds;
    // The answer event stamps answered_at once — the conversation timer and
    // the recorded talk duration both run from the actual answer.
    if (isAnswer && !call.answered_at) {
      callUpdate.answered_at = new Date().toISOString();
    }
    if (isTerminal && !call.answered_at && !(Number(durationSeconds) > 0) && !(Array.isArray(call.transcript) && call.transcript.length)) {
      // Never connected: record the real reason now. summary_status 'skipped'
      // lets a later real transcript still be summarised.
      const { data: contactRow } = call.contact_id
        ? await supabase.from('contacts').select('name').eq('id', call.contact_id).maybeSingle()
        : { data: null };
      const neverConnected = describeSocialCallEnd({
        rawStatus: rawCallStatus, reason: rawReason,
        who: contactName || contactRow?.name || peerIdentifier || 'them',
        channel: PLATFORM_LABELS[platform] || 'Telegram',
      });
      if (neverConnected) { callUpdate.outcome_summary = neverConnected; callUpdate.summary_status = 'skipped'; }
    }
    if (isTerminal) {
      callUpdate.ended_at = new Date().toISOString();
      // No provider duration? Derive the talk time from the answer; a call
      // that never connected keeps zero rather than counting ring time.
      if (!durationSeconds && call.answered_at) {
        const talked = Math.round((Date.now() - new Date(call.answered_at).getTime()) / 1000);
        if (Number.isFinite(talked) && talked > 0) callUpdate.duration_seconds = talked;
      }
    }

    if (Array.isArray(transcript)) {
      callUpdate.transcript = transcript;
    } else if (transcriptEntry && typeof transcriptEntry === 'object' && transcriptEntry.content) {
      // Deduped append: a retried callback must not double the last turn.
      const appended = appendTranscriptEntry(call.transcript, transcriptEntry);
      if (appended) callUpdate.transcript = appended;
    }
    await supabase.from('calls').update(callUpdate).eq('id', call.id);
    const attemptState = attemptStateForProviderStatus(rawCallStatus, { durationSeconds });
    if (rawCallStatus !== 'transcript') await recordAttemptEvent(supabase, call.id, { state: attemptState, source: 'relay', code: String(rawCallStatus).toLowerCase().slice(0, 30) });
  }

  if (peerIdentifier) {
    const socialCallUpdate = { status: callStatus };
    if (durationSeconds) socialCallUpdate.duration_seconds = durationSeconds;
    const { data: updatedSocialCalls } = await supabase
      .from('social_calls')
      .update(socialCallUpdate)
      .eq('user_id', userId)
      .eq('platform', platform)
      .eq('peer_identifier', peerIdentifier)
      .order('created_at', { ascending: false })
      .limit(1)
      .select('id');
    if (!updatedSocialCalls?.length) {
      await supabase.from('social_calls').insert({ user_id: userId, platform, peer_identifier: peerIdentifier, ...socialCallUpdate });
    }
  }

  // Post the call outcome into whichever chat session placed the call, once,
  // only when transitioning into a terminal state. Prefer the session id
  // stored on the row (a real chat_sessions uuid); bodySessionId is the same
  // kind of id (WaCalls reports it), while mp-relay/assistant bridge ids like
  // "call-42" are filtered out above — inserting those as a chat session id
  // would violate the FK and the follow-up would silently never appear.
  const effectiveSessionId = call?.session_id || bodySessionId || null;
  const transitionedToTerminal = isTerminal && call?.status !== callStatus;

  // Finished calls get their structured summary (+ memory extraction) from
  // the same shared service every other platform uses. Idempotent, so a
  // duplicate callback costs nothing. Generated BEFORE the chat message so
  // the message can carry the real summary instead of a generic "finished".
  let summaryResult = { status: 'noop' };
  let storedReason = null;
  // An in-app call with Emysa is the user briefing their own assistant, not a
  // conversation with someone else, so it never gets a summary or a chat report.
  const isAppCall = call?.platform === 'app' || platform === 'app';
  if (call && isTerminal && !isAppCall) {
    summaryResult = await maybeGenerateCallSummary(supabase, call.id);
    // Another trigger (the End button, the carrier callback) may already own
    // the generation. Wait for its result instead of posting the generic
    // "Finished the call" line - that is why the chat showed no summary.
    if (summaryResult?.status === 'claimed-elsewhere') {
      summaryResult = await waitForCallSummary(supabase, call.id);
    }
    // The real never-connected reason (declined, rang out, ...) beats the
    // generic line.
    if (summaryResult?.status !== 'completed') {
      const { data: after } = await supabase.from('calls').select('outcome_summary').eq('id', call.id).maybeSingle();
      if (after?.outcome_summary && !/^No summary/i.test(after.outcome_summary)) storedReason = after.outcome_summary;
    }
    // A failed generation (LLM hiccup) is worth one more attempt before
    // giving up on the summary.
    if (summaryResult?.status === 'failed' || summaryResult?.status === 'error') {
      const retry = await maybeGenerateCallSummary(supabase, call.id);
      if (retry?.status === 'completed') summaryResult = retry;
    }
  }

  if (effectiveSessionId && transitionedToTerminal && userId && !isAppCall) {
    const who = contactName || peerIdentifier || 'your contact';
    const channelName = PLATFORM_LABELS[platform] || 'Telegram';
    const mins = durationSeconds ? Math.max(1, Math.round(durationSeconds / 60)) : null;
    let text;
    if (summaryResult?.status === 'completed' && summaryResult.summary) {
      // The real summary IS the report — never a generic "Call finished".
      text = formatSummaryForChat(summaryResult.summary, summaryResult.summaryJson);
    } else if (storedReason) {
      text = storedReason;
    } else if (summaryResult?.status === 'skipped') {
      text = callStatus === 'completed'
        ? `Finished the call with ${who} on ${channelName}, but the conversation was not captured, so there is no summary.`
        : `There is no summary for the call with ${who} on ${channelName} — there was no conversation to capture.`;
    } else if (callStatus === 'completed') {
      text = mins ? `Finished the call with ${who} on ${channelName} (about ${mins} min).` : `Finished the call with ${who} on ${channelName}.`;
    } else if (callStatus === 'rejected') {
      text = `${who} rejected the call on ${channelName}.`;
    } else if (callStatus === 'no_answer') {
      text = `I called ${who} on ${channelName}, but there was no answer.`;
    } else if (callStatus === 'busy') {
      text = `${who} was busy on ${channelName}.`;
    } else if (callStatus === 'canceled') {
      text = `The call with ${who} on ${channelName} was canceled.`;
    } else {
      text = `Couldn't complete the call with ${who} on ${channelName}.`;
    }
    await postCallChatMessage(supabase, { userId, sessionId: effectiveSessionId, callId: call?.id || null, text });
  }

  return res.status(200).json({ ok: true, callId: call?.id || null, summary: summaryResult?.status || null });
}

// Status is read straight from Supabase (fast, no relay round trip) — the
// relay is the source of truth for *connecting*, but once connected, the
// row it wrote is enough to render "Connected as X".
async function status(req, res, supabase, userId) {
  const [{ data: tg }, { data: wa }, { data: sg }] = await Promise.all([
    supabase.from('telegram_accounts').select('status, display_name, phone_last4, last_error').eq('user_id', userId).maybeSingle(),
    supabase.from('whatsapp_accounts').select('status, display_name, last_error, wacalls_session_id').eq('user_id', userId).maybeSingle(),
    // Table is created by sql/023; until it is run, treat Signal as not connected.
    supabase.from('signal_accounts').select('status, signal_number, last_error').eq('user_id', userId).maybeSingle(),
  ]);
  // Ask the relay what WhatsApp's real state is (short timeout: the relay can
  // be asleep). The saved flag alone showed "Not connected" while the relay
  // was paired and placing calls.
  let waLive = { status: wa?.status || 'disconnected', displayName: wa?.display_name || null, update: null, unreachable: false };
  try {
    waLive = await resolveWhatsappStatus(wa, () => wacallsDetail(userId, wa.wacalls_session_id, { timeoutMs: 4000 }));
    if (waLive.update) await supabase.from('whatsapp_accounts').update(waLive.update).eq('user_id', userId);
  } catch { /* keep the saved state */ }
  let tgStatus = tg?.status || 'disconnected';
  let tgError = tg?.last_error || null;
  if (tgStatus === 'connected' && await telegramLiveState(userId, 4000) === 'disconnected') {
    tgStatus = 'disconnected';
    tgError = 'Telegram needs to be reconnected';
  }
  return res.status(200).json({
    telegram: {
      status: tgStatus,
      displayName: tg?.display_name || null,
      phoneLast4: tg?.phone_last4 || null,
      error: tgError,
    },
    signal: {
      status: sg?.status === 'pending_qr' ? 'disconnected' : (sg?.status || 'disconnected'),
      phoneLast4: sg?.signal_number ? sg.signal_number.slice(-4) : null,
      error: sg?.last_error || null,
    },
    whatsapp: {
      status: waLive.status,
      displayName: waLive.displayName,
      error: waLive.unreachable ? 'Checking connection…' : (wa?.last_error || null),
    },
  });
}

// The saved row says "connected" but only mp-relay knows whether it holds a
// logged-in Telegram session for this user (accounts linked through the retired
// relay were never logged in there, so a call "placed" through them rang nothing
// and reported nothing). Returns 'connected' | 'disconnected' | 'unknown'.
// Only an explicit "disconnected" answer counts: a slow or asleep relay is 'unknown'.
async function telegramLiveState(userId, timeoutMs) {
  try {
    const me = await mpRelayRequest(`/sessions/${userId}/status`, { timeoutMs });
    return me.status === 'connected' ? 'connected' : me.status === 'disconnected' ? 'disconnected' : 'unknown';
  } catch { return 'unknown'; }
}

const TELEGRAM_RECONNECT_MESSAGE = 'Telegram session expired - please reconnect Telegram and try again';

async function telegramStart(req, res, supabase, userId) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const { phone } = req.body || {};
  if (!phone || !phone.trim()) return res.status(400).json({ error: 'phone required (with country code, e.g. +234...)' });
  await mpRelayRequest(`/sessions/${userId}/start`, { method: 'POST', body: { phone: phone.trim() } });
  // mp-relay only keeps MadelineProto's own session; this table is what the
  // Connected accounts screen and call placement read, so it must be written here.
  await saveTelegramAccount(supabase, userId, {
    status: 'pending_otp', phone_last4: phone.replace(/\D/g, '').slice(-4) || null, last_error: null,
  });
  return res.status(200).json({ status: 'pending_otp' });
}

// Persist the linked state mp-relay never writes (it has no access to this table).
async function saveTelegramAccount(supabase, userId, patch) {
  const { error } = await supabase.from('telegram_accounts').upsert(
    { user_id: userId, updated_at: new Date().toISOString(), ...patch },
    { onConflict: 'user_id' },
  );
  if (error) {
    const err = new Error(`Could not save Telegram connection: ${error.message}`);
    err.statusCode = 500;
    throw err;
  }
}

async function markTelegramConnected(supabase, userId) {
  let displayName = null;
  try { // best effort: a missing name must never fail a login that already succeeded
    const me = await mpRelayRequest(`/sessions/${userId}/status`);
    displayName = me.firstName || (me.username ? `@${me.username}` : null);
  } catch { /* keep null; UI falls back to "Telegram user" */ }
  await saveTelegramAccount(supabase, userId, { status: 'connected', display_name: displayName, last_error: null });
}

async function telegramVerify(req, res, supabase, userId) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const { code, password } = req.body || {};
  // The frontend calls this endpoint twice in the 2FA case: first with just
  // the code, then again with just the password once it shows that field.
  // mp-relay itself has two separate endpoints for this (verify, then 2fa)
  // since they're genuinely different MadelineProto calls - this bridges
  // that back to the single-endpoint shape the frontend already expects.
  if (password && password.trim()) {
    await mpRelayRequest(`/sessions/${userId}/2fa`, { method: 'POST', body: { password: password.trim() } });
    await markTelegramConnected(supabase, userId);
    return res.status(200).json({ status: 'connected' });
  }
  if (!code || !code.trim()) return res.status(400).json({ error: 'code required' });
  const data = await mpRelayRequest(`/sessions/${userId}/verify`, { method: 'POST', body: { code: code.trim() } });
  if (data.status === 'need_2fa') return res.status(200).json({ status: 'needs_password' });
  await markTelegramConnected(supabase, userId);
  return res.status(200).json({ status: 'connected' });
}

async function telegramDisconnect(req, res, supabase, userId) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  await mpRelayRequest(`/sessions/${userId}`, { method: 'DELETE' });
  await saveTelegramAccount(supabase, userId, { status: 'disconnected', display_name: null, last_error: null });
  return res.status(200).json({ status: 'disconnected' });
}

// Every function below persists the WaCalls session id it's working with to
// whatsapp_accounts.wacalls_session_id as its first move - WaCalls itself
// has no idea which of our users a session belongs to, so that mapping has
// to live on our side, and it has to survive a serverless function ending
// between one request and the next (session creation and pairing are
// necessarily two separate requests).
//
// That stored id can go stale - it did for every existing user the moment
// WaCalls' session storage moved off local disk onto Postgres, since the
// old disk-backed sessions weren't (couldn't be) carried over. Blindly
// trusting the stored id and forwarding it to WaCalls is exactly what
// produced "no such session": WaCalls 404s, and this file used to let that
// 404 bubble straight to the frontend instead of noticing the id is dead
// and minting a new one. Only a confirmed 404 counts as "dead" - a
// timeout, a 5xx, or the relay being unreachable must NOT clear a
// perfectly good mapping just because of a blip.
async function getOrCreateWacallsSession(supabase, userId, phone) {
  const { data: row } = await supabase.from('whatsapp_accounts').select('wacalls_session_id').eq('user_id', userId).maybeSingle();
  if (row?.wacalls_session_id) {
    try {
      await wacallsDetail(userId, row.wacalls_session_id);
      return row.wacalls_session_id;
    } catch (err) {
      if (err.statusCode !== 404) throw err;
      // fall through and mint a fresh session below
    }
  }
  const created = await wacallsCreateSession(userId, `user-${userId}`, phone);
  await supabase.from('whatsapp_accounts').upsert(
    { user_id: userId, wacalls_session_id: created.id, status: 'pending_qr' },
    { onConflict: 'user_id' },
  );
  return created.id;
}

async function whatsappStart(req, res, supabase, userId) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const sessionId = await getOrCreateWacallsSession(supabase, userId, null);
  const detail = await wacallsDetail(userId, sessionId);
  return res.status(200).json({ qr: detail.qr || null, status: detail.paired ? 'connected' : 'pending_qr' });
}

async function whatsappStartWithPhone(req, res, supabase, userId) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const phone = (req.body?.phone || '').trim();
  if (!phone) return res.status(400).json({ error: 'phone required (with country code, e.g. +234...)' });
  const { data: row } = await supabase.from('whatsapp_accounts').select('wacalls_session_id').eq('user_id', userId).maybeSingle();
  let sessionId = row?.wacalls_session_id;
  if (sessionId) {
    try {
      await wacallsDetail(userId, sessionId);
    } catch (err) {
      if (err.statusCode !== 404) throw err;
      sessionId = null; // stale - relay has no memory of this id, mint a fresh one below
    }
  }
  let detail;
  if (!sessionId) {
    const created = await wacallsCreateSession(userId, `user-${userId}`, phone);
    sessionId = created.id;
    await supabase.from('whatsapp_accounts').upsert({ user_id: userId, wacalls_session_id: sessionId, status: 'pending_qr' }, { onConflict: 'user_id' });
    detail = await wacallsDetail(userId, sessionId);
  } else {
    await wacallsPairWithCode(userId, sessionId, phone);
    detail = await wacallsDetail(userId, sessionId);
  }
  return res.status(200).json({ status: detail.paired ? 'connected' : 'pending_code', pairingCode: detail.code || null });
}

async function whatsappStatus(req, res, supabase, userId) {
  const { data: row } = await supabase.from('whatsapp_accounts').select('status, wacalls_session_id, display_name').eq('user_id', userId).maybeSingle();
  if (!row?.wacalls_session_id) return res.status(200).json({ status: 'disconnected' });
  let detail = null;
  const live = await resolveWhatsappStatus(row, async () => { detail = await wacallsDetail(userId, row.wacalls_session_id); return detail; });
  if (live.update) {
    // Upsert, not update, and check the result: the app decides whether setup
    // is finished from this row, so a silently failed write left people on
    // the link screen even though the relay was paired.
    const { error: saveErr } = await supabase.from('whatsapp_accounts').upsert({ user_id: userId, ...live.update }, { onConflict: 'user_id' });
    if (saveErr) console.error('whatsapp-status: could not save status:', saveErr.message);
  }
  return res.status(200).json({ status: live.status, qr: detail?.qr || null, pairingCode: detail?.code || null, displayName: live.displayName, unreachable: Boolean(live.unreachable) });
}

async function whatsappDisconnect(req, res, supabase, userId) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const { data: row } = await supabase.from('whatsapp_accounts').select('wacalls_session_id').eq('user_id', userId).maybeSingle();
  if (row?.wacalls_session_id) {
    await wacallsDelete(userId, row.wacalls_session_id).catch(() => {}); // already gone on the relay side is fine, still clear our row
  }
  await supabase.from('whatsapp_accounts').update({ wacalls_session_id: null, status: 'disconnected', display_name: null }).eq('user_id', userId);
  return res.status(200).json({ status: 'disconnected' });
}

// Signal: QR linking through the signal-bridge service (a linked device, the
// same idea as WhatsApp's QR). The QR is shown once and expires in ~2 minutes;
// the bridge reports when it was scanned. Placing Signal calls is NOT wired
// here yet - it waits until a real linked-device call has been proven.
async function signalStart(req, res, supabase, userId) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const { data: row } = await supabase.from('signal_accounts').select('status').eq('user_id', userId).maybeSingle();
  if (row?.status === 'connected') return res.status(200).json({ status: 'connected' });
  const link = await signalStartLink();
  await supabase.from('signal_accounts').upsert(
    { user_id: userId, link_id: link.id, status: 'pending_qr', last_error: null, updated_at: new Date().toISOString() },
    { onConflict: 'user_id' },
  );
  return res.status(200).json({ qr: link.qr, status: 'pending_qr' });
}

async function signalStatus(req, res, supabase, userId) {
  const { data: row } = await supabase.from('signal_accounts').select('status, signal_number, link_id').eq('user_id', userId).maybeSingle();
  if (!row || row.status === 'disconnected') return res.status(200).json({ status: 'disconnected' });
  if (row.status === 'connected') return res.status(200).json({ status: 'connected', phoneLast4: row.signal_number?.slice(-4) || null });
  if (row.status !== 'pending_qr' || !row.link_id) return res.status(200).json({ status: row.status });

  let link;
  try {
    link = await signalLinkStatus(row.link_id, { timeoutMs: 8000 });
  } catch (err) {
    if (err.statusCode === 404) {
      // The bridge restarted and forgot this attempt - the QR is dead.
      await supabase.from('signal_accounts').update({ status: 'disconnected', link_id: null, last_error: 'Link expired - tap Connect to get a new code' }).eq('user_id', userId);
      return res.status(200).json({ status: 'expired' });
    }
    return res.status(200).json({ status: 'pending_qr', unreachable: true }); // a blip says nothing about the link
  }
  if (link.status === 'linked') {
    if (!link.number) {
      await supabase.from('signal_accounts').update({ status: 'error', link_id: null, last_error: 'Linked, but the account number could not be read - disconnect and try again' }).eq('user_id', userId);
      return res.status(200).json({ status: 'error' });
    }
    await supabase.from('signal_accounts').update({ status: 'connected', signal_number: link.number, link_id: null, last_error: null, updated_at: new Date().toISOString() }).eq('user_id', userId);
    return res.status(200).json({ status: 'connected', phoneLast4: link.number.slice(-4) });
  }
  if (link.status === 'failed' || link.status === 'expired') {
    const msg = link.status === 'expired' ? 'Link expired - tap Connect to get a new code' : 'Linking failed - tap Connect to try again';
    await supabase.from('signal_accounts').update({ status: 'disconnected', link_id: null, last_error: msg }).eq('user_id', userId);
    return res.status(200).json({ status: link.status });
  }
  return res.status(200).json({ status: 'pending_qr' });
}

async function signalDisconnect(req, res, supabase, userId) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const { data: row } = await supabase.from('signal_accounts').select('signal_number').eq('user_id', userId).maybeSingle();
  if (row?.signal_number) {
    await signalRemoveAccount(row.signal_number).catch(() => {}); // already gone on the bridge is fine, still clear our row
  }
  await supabase.from('signal_accounts').update({ signal_number: null, link_id: null, status: 'disconnected', last_error: null }).eq('user_id', userId);
  return res.status(200).json({ status: 'disconnected' });
}

async function placeCall(req, res, supabase, userId) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const { platform, objective, instructions, contactId, contactName, sessionId } = req.body || {};
  const to = String(req.body?.to || req.body?.toNumber || '').trim();
  if (platform !== 'telegram' && platform !== 'whatsapp' && platform !== 'signal') return res.status(400).json({ error: "platform must be 'telegram', 'whatsapp' or 'signal'" });
  if (!to) return res.status(400).json({ error: 'to required' });
  const left = await minutesLeft(supabase, userId);
  if (left && left.remaining <= 0) return res.status(402).json({ error: NO_MINUTES_MESSAGE, code: 'no-minutes' });

  // Repeated button presses / retried requests must not dial twice.
  const duplicate = await findDuplicateActiveCall(supabase, userId, platform, to);
  if (duplicate) {
    return res.status(409).json({ error: 'A call to this number is already in progress', callId: duplicate.id });
  }

  if (platform === 'whatsapp') {
    const { data: row } = await supabase.from('whatsapp_accounts').select('wacalls_session_id').eq('user_id', userId).maybeSingle();
    if (!row?.wacalls_session_id) {
      const err = new Error('WhatsApp not connected for this user');
      err.statusCode = 400;
      throw err;
    }
    // The `calls` row exists BEFORE the provider dials: the assistant
    // pipeline resolves its bridge session ("call-" + provider id) back to
    // this row to load instructions/memories and persist the transcript,
    // and the live call screen opens as soon as the row appears.
    // One person = one conversation (see lib/personSession.js).
    const person = await resolvePersonSession(supabase, userId, {
      sessionId: sessionId || null, toNumber: to, contactId: contactId || null, label: contactName || null,
    });
    const effectiveSession = person.sessionId || sessionId || null;
    const dbCall = await createCallRecord(supabase, userId, {
      platform: 'whatsapp',
      toNumber: to,
      objective: objective || '',
      instructions: instructions || null,
      contactId: contactId || null,
      sessionId: effectiveSession,
    });
    try {
      // Place the call AND attach the assistant. This used to only start the
      // call, so a WhatsApp call placed through this action rang, was
      // answered, and nothing ever spoke.
      const placed = await wacallsPlaceAICall(userId, row.wacalls_session_id, to, {
        appSessionId: effectiveSession,
        contactName: contactName || null,
        // Runs after the relay returns the provider call id but BEFORE the
        // assistant bridge dials in (attach), so the row carries the id the
        // pipeline will look for.
        onCallStarted: ({ callId }) => markCallPlaced(supabase, dbCall.id, { platformCallId: callId }),
      });
      return res.status(200).json({
        ...placed.started,
        callId: placed.callId,
        dbCallId: dbCall.id,
        platformCallId: placed.callId,
        aiAttached: placed.aiAttached,
      });
    } catch (err) {
      await markCallFailed(supabase, dbCall.id, err.message);
      if (err.statusCode === 404) {
        // Stored id is dead (e.g. relay storage was reset since pairing) -
        // clear it so the account shows "disconnected" instead of silently
        // failing every call, and say so plainly rather than surfacing the
        // relay's internal "no such session" wording.
        await supabase.from('whatsapp_accounts').update({ wacalls_session_id: null, status: 'disconnected', display_name: null }).eq('user_id', userId);
        const staleErr = new Error('WhatsApp session expired - please reconnect WhatsApp and try again');
        staleErr.statusCode = 409;
        throw staleErr;
      }
      throw err;
    }
  }

  if (platform === 'signal') {
    const { data: sgRow } = await supabase.from('signal_accounts').select('status, signal_number').eq('user_id', userId).maybeSingle();
    if (sgRow?.status !== 'connected' || !sgRow.signal_number) {
      const err = new Error('Signal not connected for this user');
      err.statusCode = 400;
      throw err;
    }
    // Same shape as WhatsApp: the `calls` row exists before dialing so the
    // assistant can resolve "call-<signal call id>" back to it.
    const person = await resolvePersonSession(supabase, userId, {
      sessionId: sessionId || null, toNumber: to, contactId: contactId || null, label: contactName || null,
    });
    const effectiveSession = person.sessionId || sessionId || null;
    const dbCall = await createCallRecord(supabase, userId, {
      platform: 'signal',
      toNumber: to,
      objective: objective || '',
      instructions: instructions || null,
      contactId: contactId || null,
      sessionId: effectiveSession,
    });
    try {
      const started = await signalPlaceCall(sgRow.signal_number, to, { userId });
      const platformCallId = started?.callId != null ? String(started.callId) : null;
      await markCallPlaced(supabase, dbCall.id, { platformCallId });
      return res.status(200).json({
        callId: dbCall.id, dbCallId: dbCall.id, platformCallId, status: 'ringing',
      });
    } catch (err) {
      await markCallFailed(supabase, dbCall.id, err.message);
      if (err.statusCode === 404 || err.statusCode === 409) {
        // The bridge no longer knows this account (e.g. its disk was reset): the link is dead.
        await supabase.from('signal_accounts').update({ status: 'disconnected', signal_number: null, last_error: 'Signal session expired - reconnect Signal and try again' }).eq('user_id', userId);
        const staleErr = new Error('Signal session expired - please reconnect Signal and try again');
        staleErr.statusCode = 409;
        throw staleErr;
      }
      throw err;
    }
  }

  // Telegram call placement via mp-relay (MadelineProto + Pipecat bridge),
  // matching api/assistant.js instead of the retired social-relay stub.
  const { data: tgRow } = await supabase
    .from('telegram_accounts')
    .select('status')
    .eq('user_id', userId)
    .maybeSingle();
  if (tgRow?.status !== 'connected') {
    const err = new Error('Telegram not connected for this user');
    err.statusCode = 400;
    throw err;
  }
  if (await telegramLiveState(userId, 20_000) === 'disconnected') {
    const err = new Error(TELEGRAM_RECONNECT_MESSAGE);
    err.statusCode = 409;
    throw err;
  }
  const dbCall = await createCallRecord(supabase, userId, {
    platform: 'telegram',
    toNumber: to,
    objective: objective || '',
    instructions: instructions || null,
    contactId: contactId || null,
    sessionId: sessionId || null,
  });
  try {
    const data = await mpRelayRequest('/calls', {
      method: 'POST',
      body: {
        userId,
        to,
        sessionId: sessionId || null,
        contactName: contactName || null,
        objective: objective || '',
      },
    });
    const platformCallId = data?.callId || null;
    // mp-relay starts dialing the assistant as soon as it responds; if the
    // bridge hello arrives before this line, the assistant's own retry loop
    // picks the row up a moment later.
    await markCallPlaced(supabase, dbCall.id, { platformCallId });
    return res.status(200).json({
      ...data,
      callId: dbCall.id,
      dbCallId: dbCall.id,
      platformCallId,
      status: data?.status || 'ringing',
    });
  } catch (err) {
    await markCallFailed(supabase, dbCall.id, err.message);
    if (err.statusCode === 401) {
      await supabase
        .from('telegram_accounts')
        .update({ status: 'disconnected', display_name: null })
        .eq('user_id', userId);
      const staleErr = new Error('Telegram session expired - please reconnect Telegram and try again');
      staleErr.statusCode = 409;
      throw staleErr;
    }
    throw err;
  }
}

async function hangupSocialCall(req, res, supabase, userId) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const { callId, platformCallId, platform } = req.body || {};
  if (!callId && !platformCallId) {
    return res.status(400).json({ error: 'callId or platformCallId required' });
  }

  let call = null;
  if (callId) {
    const { data } = await supabase
      .from('calls')
      .select('*')
      .eq('id', callId)
      .eq('user_id', userId)
      .maybeSingle();
    call = data;
  }

  const effectivePlatform = call?.platform || platform;
  const effectivePlatformCallId = call?.platform_call_id || platformCallId || callId;

  if (effectivePlatform === 'whatsapp' && effectivePlatformCallId) {
    const { data: waRow } = await supabase
      .from('whatsapp_accounts')
      .select('wacalls_session_id')
      .eq('user_id', userId)
      .maybeSingle();
    if (waRow?.wacalls_session_id) {
      await wacallsHangup(userId, waRow.wacalls_session_id, effectivePlatformCallId).catch(() => {});
    }
  } else if (effectivePlatform === 'telegram' && effectivePlatformCallId) {
    await mpRelayRequest(`/calls/${effectivePlatformCallId}`, { method: 'DELETE' }).catch(() => {});
  } else if (effectivePlatform === 'signal' && effectivePlatformCallId) {
    await signalHangup(effectivePlatformCallId).catch(() => {});
  }

  if (call?.id) {
    // User-initiated hangup: 'completed' only if the call was actually
    // answered (talk time runs from answered_at); an aborted ring is
    // 'canceled' with no talk duration — never a fabricated conversation.
    const nowIso = new Date().toISOString();
    const update = call.answered_at
      ? {
          status: 'completed',
          ended_at: nowIso,
          duration_seconds: Math.max(0, Math.round((Date.now() - new Date(call.answered_at).getTime()) / 1000)),
        }
      : { status: 'canceled', ended_at: nowIso };
    await supabase
      .from('calls')
      .update(update)
      .eq('id', call.id)
      .in('status', ['queued', 'ringing', 'in_progress']);
  }
  return res.status(200).json({ ok: true });
}
