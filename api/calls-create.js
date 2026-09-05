import { getServiceClient, getAuthedUserId } from '../lib/supabaseAdmin.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const supabase = getServiceClient();
  const userId = await getAuthedUserId(req, supabase);
  if (!userId) return res.status(401).json({ error: 'Not signed in' });

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
  const appUrl = process.env.PUBLIC_APP_URL; // e.g. https://audio-call.vercel.app
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

    const twilioResp = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls.json`,
      {
        method: 'POST',
        headers: {
          Authorization: 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64'),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
      }
    );

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
