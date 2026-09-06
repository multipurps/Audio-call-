import { getServiceClient, getAuthedUserId } from '../lib/supabaseAdmin.js';

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

  const { data: call, error: insertErr } = await supabase
    .from('calls')
    .insert({
      user_id: userId,
      caller_id: callerId || null,
      to_number: toNumber.trim(),
      objective: objective.trim(),
      status: 'queued',
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
  return res.status(200).json({ calls: data });
}
