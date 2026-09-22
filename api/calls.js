import { getServiceClient, getAuthedUserId } from '../lib/supabaseAdmin.js';
import { relayRequest } from '../lib/relayClient.js';

export default async function handler(req, res) {
  const supabase = getServiceClient();
  const userId = await getAuthedUserId(req, supabase);
  if (!userId) return res.status(401).json({ error: 'Not signed in' });

  const action = req.query?.action || req.body?.action;

  switch (action) {
    case 'create': return createCall(req, res, supabase, userId);
    case 'hangup': return hangupCall(req, res, supabase, userId);
    case 'mute': return muteCall(req, res, supabase, userId);
    case 'list': return listCalls(req, res, supabase, userId);
    case 'directBridge': return directBridge(req, res, supabase, userId);
    case 'mode': return modeCall(req, res, supabase, userId);
    case 'vcState': return vcState(req, res);
    case 'vcSet': return vcSet(req, res, supabase, userId);
    default: return res.status(400).json({ error: 'Unknown or missing action' });
  }
}

async function createCall(req, res, supabase, userId) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const { callerId, toNumber, objective } = req.body || {};
  if (!toNumber || !toNumber.trim()) return res.status(400).json({ error: 'toNumber required' });
  if (!objective || !objective.trim()) return res.status(400).json({ error: 'objective required' });

  // Usage gate — reject before we ever touch Twilio, per the credit-control
  // requirement (app owns the Twilio account, so one user must never be able
  // to run the whole balance down).
  const { data: usage } = await supabase.from('user_usage').select('*').eq('user_id', userId).maybeSingle();
  const used = usage?.call_minutes_used ?? 0;
  const limit = usage?.monthly_minute_limit ?? 60;
  if (used >= limit) {
    return res.status(403).json({ error: 'Monthly call minutes exhausted. Upgrade or wait for next period.' });
  }

  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const fromNumber = process.env.TWILIO_FROM_NUMBER;
  const appUrl = process.env.PUBLIC_APP_URL;
  if (!accountSid || !authToken || !fromNumber || !appUrl) {
    return res.status(500).json({ error: 'Telephony not configured' });
  }

  // Who talks on this call: Emysa ('ai') or the user's own microphone
  // ('direct'). Explicit request value wins; otherwise the account default
  // from Profile -> Call Settings. Anything unrecognised falls back to 'ai',
  // which is the behaviour every caller of this endpoint has always got.
  const { data: prefs } = await supabase
    .from('profiles')
    .select('default_call_mode, vc_enabled, vc_model_slot')
    .eq('user_id', userId)
    .maybeSingle();
  const callMode = resolveCallMode(req.body?.callMode, prefs?.default_call_mode);

  const { data: call, error: insertErr } = await supabase
    .from('calls')
    .insert({
      user_id: userId,
      caller_id: callerId || null,
      to_number: toNumber.trim(),
      objective: objective.trim(),
      status: 'queued',
      call_mode: callMode,
      vc_enabled: typeof req.body?.vcEnabled === 'boolean' ? req.body.vcEnabled : prefs?.vc_enabled !== false,
      vc_model_slot: req.body?.vcModelSlot ?? prefs?.vc_model_slot ?? null,
    })
    .select()
    .single();
  if (insertErr) return res.status(500).json({ error: insertErr.message });

  try {
    const twiml_url = `${appUrl}/api/calls-twiml?callId=${call.id}`;
    const status_callback = `${appUrl}/api/calls-status?callId=${call.id}`;

    const body = new URLSearchParams({
      To: toNumber.trim(),
      From: fromNumber,
      Url: twiml_url,
      StatusCallback: status_callback,
      StatusCallbackEvent: 'initiated ringing answered completed',
      Record: 'true',
      MachineDetection: 'Enable', // lets calls-twiml.js hang up immediately on voicemail instead of connecting the relay
    });

    const twilioResp = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls.json`, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    });

    if (!twilioResp.ok) {
      const detail = await twilioResp.text().catch(() => '');
      await supabase.from('calls').update({ status: 'failed' }).eq('id', call.id);
      return res.status(502).json({ error: 'Twilio rejected the call', detail });
    }

    const twilioData = await twilioResp.json();
    await supabase.from('calls').update({ twilio_call_sid: twilioData.sid, status: 'ringing' }).eq('id', call.id);
    return res.status(200).json({ callId: call.id, sid: twilioData.sid });
  } catch (err) {
    await supabase.from('calls').update({ status: 'failed' }).eq('id', call.id);
    return res.status(500).json({ error: err.message || String(err) });
  }
}

async function hangupCall(req, res, supabase, userId) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const { callId } = req.body || {};
  if (!callId) return res.status(400).json({ error: 'callId required' });

  const { data: call } = await supabase.from('calls').select('*').eq('id', callId).eq('user_id', userId).maybeSingle();
  if (!call) return res.status(404).json({ error: 'Call not found' });
  if (!call.twilio_call_sid) return res.status(400).json({ error: 'Call has no active Twilio sid' });

  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;

  const resp = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls/${call.twilio_call_sid}.json`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ Status: 'completed' }),
  });

  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    return res.status(502).json({ error: 'Twilio could not end the call', detail });
  }

  await supabase.from('calls').update({ status: 'completed' }).eq('id', callId);
  return res.status(200).json({ ok: true });
}

async function muteCall(req, res, supabase, userId) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const { callId, muted } = req.body || {};
  if (!callId || typeof muted !== 'boolean') return res.status(400).json({ error: 'callId and muted required' });

  const { error } = await supabase.from('calls').update({ ai_muted: muted }).eq('id', callId).eq('user_id', userId);
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ ok: true });
}

async function listCalls(req, res, supabase, userId) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
  const { data, error } = await supabase
    .from('calls')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) return res.status(500).json({ error: error.message });

  const contactIds = [...new Set((data || []).map((c) => c.contact_id).filter(Boolean))];
  let namesById = new Map();
  if (contactIds.length) {
    const { data: contacts } = await supabase.from('contacts').select('id,name').in('id', contactIds);
    namesById = new Map((contacts || []).map((c) => [c.id, c.name]));
  }
  const calls = (data || []).map((c) => ({ ...c, contact_name: c.contact_id ? namesById.get(c.contact_id) || null : null }));

  return res.status(200).json({ calls });
}

// ---------------------------------------------------------------------------
// Direct Caller Mode
// ---------------------------------------------------------------------------

/**
 * 'direct' only when explicitly asked for — by the request, or by the
 * account default. Anything else is 'ai', which is what every caller of this
 * endpoint has always got. (api/assistant.js has the same two lines inlined;
 * importing one serverless function into another isn't worth saving them.)
 */
function resolveCallMode(requested, fallback) {
  if (requested === 'direct' || requested === 'ai') return requested;
  return fallback === 'direct' ? 'direct' : 'ai';
}

/**
 * Hands the browser everything it needs to open the direct microphone socket
 * on the relay: where to connect, and a short-lived ticket that proves this
 * user owns this call.
 *
 * The ticket is minted by the relay, not here. That keeps the signing key in
 * exactly one process — this function runs on Vercel, the relay runs on
 * Render, and duplicating the HMAC between them is how the two silently stop
 * agreeing after a key rotation.
 */
async function directBridge(req, res, supabase, userId) {
  const callId = req.query?.callId || req.body?.callId;
  if (!callId) return res.status(400).json({ error: 'callId required' });

  const { data: call } = await supabase
    .from('calls')
    .select('id, status, call_mode, vc_enabled, vc_model_slot')
    .eq('id', callId)
    .eq('user_id', userId)
    .maybeSingle();
  if (!call) return res.status(404).json({ error: 'Call not found' });
  if (!['queued', 'ringing', 'in_progress'].includes(call.status)) {
    return res.status(409).json({ error: 'Call is not live' });
  }

  // The user's tap means "hand this call to my microphone". Persist that
  // before Twilio necessarily connects so an early tap during ringing is not
  // lost when the relay later loads the call row.
  await supabase.from('calls').update({ call_mode: 'direct' }).eq('id', callId).eq('user_id', userId);

  const relayUrl = process.env.RELAY_WS_URL;
  if (!relayUrl) return res.status(500).json({ error: 'Call relay not configured' });

  let ticket;
  try {
    ticket = await relayRequest('/direct/ticket', { method: 'POST', body: { callId, userId } });
  } catch (err) {
    return res.status(err.statusCode || 502).json({ error: err.message });
  }

  const ws = new URL(relayUrl);
  ws.pathname = '/direct';
  ws.search = '';
  ws.searchParams.set('callId', call.id);
  ws.searchParams.set('userId', userId);
  ws.searchParams.set('exp', String(ticket.exp));
  ws.searchParams.set('token', ticket.token);

  return res.status(200).json({
    wsUrl: ws.toString(),
    callId: call.id,
    mode: call.call_mode || 'ai',
    vcEnabled: call.vc_enabled !== false,
    vcModelSlot: call.vc_model_slot ?? null,
    streamRate: ticket.streamRate,
    playRate: ticket.playRate,
    expiresAt: ticket.exp,
  });
}

/** Which RVC voices the w-okada server can speak with right now. */
async function modeCall(req, res, supabase, userId) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const { callId, mode } = req.body || {};
  if (!callId || (mode !== 'ai' && mode !== 'direct')) {
    return res.status(400).json({ error: 'callId and mode required' });
  }
  const { error } = await supabase.from('calls').update({ call_mode: mode }).eq('id', callId).eq('user_id', userId);
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ ok: true });
}

async function vcState(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
  try {
    const data = await relayRequest('/vc/state');
    return res.status(200).json(data);
  } catch (err) {
    return res.status(err.statusCode || 502).json({ error: err.message });
  }
}

/**
 * Select a voice. Two writes happen: the w-okada server loads the model into
 * its active slot (affecting conversions immediately), and the user's profile
 * remembers the choice as their default. The profile write happens even if
 * the load failed, so a voice picked while the GPU box is asleep is still
 * there once it wakes.
 */
async function vcSet(req, res, supabase, userId) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const { slot } = req.body || {};
  const slotNum = Number(slot);
  if (!Number.isFinite(slotNum)) return res.status(400).json({ error: 'slot required' });

  const patch = { user_id: userId, vc_model_slot: slotNum, updated_at: new Date().toISOString() };
  if (typeof req.body?.enabled === 'boolean') patch.vc_enabled = req.body.enabled;
  const { error } = await supabase.from('profiles').upsert(patch, { onConflict: 'user_id' });
  if (error) return res.status(500).json({ error: error.message });

  try {
    await relayRequest('/vc/model', { method: 'POST', body: { slot: slotNum } });
    return res.status(200).json({ ok: true, slot: slotNum });
  } catch (err) {
    // Saved, but not live yet — the caller needs to know which of the two
    // happened, since the UI shows the voice as active either way otherwise.
    return res.status(202).json({ ok: false, slot: slotNum, saved: true, error: err.message });
  }
}
