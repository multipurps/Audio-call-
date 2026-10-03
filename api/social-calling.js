import { getServiceClient, getAuthedUserId } from '../lib/supabaseAdmin.js';
import { resolveWhatsappStatus } from '../lib/whatsappStatus.js';
import { wacallsCreateSession, wacallsDetail, wacallsPairWithCode, wacallsDelete, wacallsPlaceAICall, wacallsHangup } from '../lib/wacallsClient.js';
import { mpRelayRequest } from '../lib/mpRelayClient.js';
import {
  createCallRecord,
  markCallPlaced,
  markCallFailed,
  findDuplicateActiveCall,
  appendTranscriptEntry,
  maybeGenerateCallSummary,
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
      case 'telegram-start': return await telegramStart(req, res, userId);
      case 'telegram-verify': return await telegramVerify(req, res, userId);
      case 'telegram-disconnect': return await telegramDisconnect(req, res, userId);
      case 'whatsapp-start': return await whatsappStart(req, res, supabase, userId);
      case 'whatsapp-start-phone': return await whatsappStartWithPhone(req, res, supabase, userId);
      case 'whatsapp-status': return await whatsappStatus(req, res, supabase, userId);
      case 'whatsapp-disconnect': return await whatsappDisconnect(req, res, supabase, userId);
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
  } = req.body || {};
  if ((!bodyUserId && !incomingCallId && !platformCallId) || (!peerIdentifier && !incomingCallId && !platformCallId) || !rawCallStatus) {
    return res.status(400).json({ error: 'userId (or callId), peerIdentifier (or callId) and status required' });
  }
  if (!['whatsapp', 'telegram'].includes(platform)) return res.status(400).json({ error: 'platform must be whatsapp or telegram' });

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
    rejected: 'no_answer',
    declined: 'no_answer',
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
  const isTerminal = ['completed', 'no_answer', 'failed', 'busy', 'canceled'].includes(callStatus);
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
      .select('id, user_id, status, transcript, session_id, answered_at, created_at')
      .eq('id', incomingCallId);
    if (bodyUserId) q = q.eq('user_id', bodyUserId);
    const { data } = await q.maybeSingle();
    call = data;
  }
  for (const candidate of platformCallIdCandidates) {
    if (call) break;
    let q = supabase
      .from('calls')
      .select('id, user_id, status, transcript, session_id, answered_at, created_at')
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
      .select('id, user_id, status, transcript, session_id, answered_at, created_at')
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
        .select('id, user_id, status, transcript, session_id, answered_at, created_at')
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
      .select('id, user_id, status, transcript, session_id, answered_at, created_at')
      .eq('user_id', userId)
      .eq('platform', platform)
      .eq('to_number', peerIdentifier)
      .in('status', activeStatuses)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    call = data;
  }

  if (call) {
    const callUpdate = { status: callStatus };
    if (durationSeconds) callUpdate.duration_seconds = durationSeconds;
    // The answer event stamps answered_at once — the conversation timer and
    // the recorded talk duration both run from the actual answer.
    if (isAnswer && !call.answered_at) {
      callUpdate.answered_at = new Date().toISOString();
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
  if (call && isTerminal) {
    summaryResult = await maybeGenerateCallSummary(supabase, call.id);
  }

  if (effectiveSessionId && transitionedToTerminal && userId) {
    const who = contactName || peerIdentifier || 'your contact';
    const channelName = platform === 'whatsapp' ? 'WhatsApp' : 'Telegram';
    const mins = durationSeconds ? Math.max(1, Math.round(durationSeconds / 60)) : null;
    let text;
    if (summaryResult?.status === 'completed' && summaryResult.summary) {
      // The real summary IS the report — never a generic "Call finished".
      text = summaryResult.summary;
    } else if (summaryResult?.status === 'skipped') {
      text = callStatus === 'completed'
        ? `Finished the call with ${who} on ${channelName}, but the conversation was not captured, so there is no summary.`
        : `There is no summary for the call with ${who} on ${channelName} — there was no conversation to capture.`;
    } else if (callStatus === 'completed') {
      text = mins ? `Finished the call with ${who} on ${channelName} (about ${mins} min).` : `Finished the call with ${who} on ${channelName}.`;
    } else if (callStatus === 'no_answer') {
      text = `I called ${who} on ${channelName}, but there was no answer.`;
    } else if (callStatus === 'busy') {
      text = `${who} was busy on ${channelName}.`;
    } else if (callStatus === 'canceled') {
      text = `The call with ${who} on ${channelName} was canceled.`;
    } else {
      text = `Couldn't complete the call with ${who} on ${channelName}.`;
    }
    await supabase.from('assistant_messages').insert({ user_id: userId, session_id: effectiveSessionId, role: 'assistant', content: text, call_id: call?.id || null, source: 'text' });
    await supabase.from('chat_sessions').update({ updated_at: new Date().toISOString() }).eq('id', effectiveSessionId);
  }

  return res.status(200).json({ ok: true, callId: call?.id || null, summary: summaryResult?.status || null });
}

// Status is read straight from Supabase (fast, no relay round trip) — the
// relay is the source of truth for *connecting*, but once connected, the
// row it wrote is enough to render "Connected as X".
async function status(req, res, supabase, userId) {
  const [{ data: tg }, { data: wa }] = await Promise.all([
    supabase.from('telegram_accounts').select('status, display_name, phone_last4, last_error').eq('user_id', userId).maybeSingle(),
    supabase.from('whatsapp_accounts').select('status, display_name, last_error, wacalls_session_id').eq('user_id', userId).maybeSingle(),
  ]);
  // Ask the relay what WhatsApp's real state is (short timeout: the relay can
  // be asleep). The saved flag alone showed "Not connected" while the relay
  // was paired and placing calls.
  let waLive = { status: wa?.status || 'disconnected', displayName: wa?.display_name || null, update: null, unreachable: false };
  try {
    waLive = await resolveWhatsappStatus(wa, () => wacallsDetail(userId, wa.wacalls_session_id, { timeoutMs: 4000 }));
    if (waLive.update) await supabase.from('whatsapp_accounts').update(waLive.update).eq('user_id', userId);
  } catch { /* keep the saved state */ }
  return res.status(200).json({
    telegram: {
      status: tg?.status || 'disconnected',
      displayName: tg?.display_name || null,
      phoneLast4: tg?.phone_last4 || null,
      error: tg?.last_error || null,
    },
    whatsapp: {
      status: waLive.status,
      displayName: waLive.displayName,
      error: waLive.unreachable ? 'Checking connection…' : (wa?.last_error || null),
    },
  });
}

async function telegramStart(req, res, userId) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const { phone } = req.body || {};
  if (!phone || !phone.trim()) return res.status(400).json({ error: 'phone required (with country code, e.g. +234...)' });
  await mpRelayRequest(`/sessions/${userId}/start`, { method: 'POST', body: { phone: phone.trim() } });
  return res.status(200).json({ status: 'pending_otp' });
}

async function telegramVerify(req, res, userId) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const { code, password } = req.body || {};
  // The frontend calls this endpoint twice in the 2FA case: first with just
  // the code, then again with just the password once it shows that field.
  // mp-relay itself has two separate endpoints for this (verify, then 2fa)
  // since they're genuinely different MadelineProto calls - this bridges
  // that back to the single-endpoint shape the frontend already expects.
  if (password && password.trim()) {
    await mpRelayRequest(`/sessions/${userId}/2fa`, { method: 'POST', body: { password: password.trim() } });
    return res.status(200).json({ status: 'connected' });
  }
  if (!code || !code.trim()) return res.status(400).json({ error: 'code required' });
  const data = await mpRelayRequest(`/sessions/${userId}/verify`, { method: 'POST', body: { code: code.trim() } });
  return res.status(200).json({ status: data.status === 'need_2fa' ? 'needs_password' : 'connected' });
}

async function telegramDisconnect(req, res, userId) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  await mpRelayRequest(`/sessions/${userId}`, { method: 'DELETE' });
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
  if (live.update) await supabase.from('whatsapp_accounts').update(live.update).eq('user_id', userId);
  return res.status(200).json({ status: live.status, qr: detail?.qr || null, pairingCode: detail?.code || null, displayName: live.displayName });
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

async function placeCall(req, res, supabase, userId) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const { platform, objective, instructions, contactId, contactName, sessionId } = req.body || {};
  const to = String(req.body?.to || req.body?.toNumber || '').trim();
  if (platform !== 'telegram' && platform !== 'whatsapp') return res.status(400).json({ error: "platform must be 'telegram' or 'whatsapp'" });
  if (!to) return res.status(400).json({ error: 'to required' });

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
    const dbCall = await createCallRecord(supabase, userId, {
      platform: 'whatsapp',
      toNumber: to,
      objective: objective || '',
      instructions: instructions || null,
      contactId: contactId || null,
      sessionId: sessionId || null,
    });
    try {
      // Place the call AND attach the assistant. This used to only start the
      // call, so a WhatsApp call placed through this action rang, was
      // answered, and nothing ever spoke.
      const placed = await wacallsPlaceAICall(userId, row.wacalls_session_id, to, {
        appSessionId: sessionId || null,
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
      await markCallFailed(supabase, dbCall.id);
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
    await markCallFailed(supabase, dbCall.id);
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
