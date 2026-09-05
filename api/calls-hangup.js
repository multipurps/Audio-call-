import { getServiceClient, getAuthedUserId } from '../lib/supabaseAdmin.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const supabase = getServiceClient();
  const userId = await getAuthedUserId(req, supabase);
  if (!userId) return res.status(401).json({ error: 'Not signed in' });

  const { callId } = req.body || {};
  if (!callId) return res.status(400).json({ error: 'callId required' });

  const { data: call } = await supabase.from('calls').select('*').eq('id', callId).eq('user_id', userId).maybeSingle();
  if (!call) return res.status(404).json({ error: 'Call not found' });
  if (!call.twilio_call_sid) return res.status(400).json({ error: 'Call has no active Twilio sid' });

  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;

  const resp = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls/${call.twilio_call_sid}.json`,
    {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ Status: 'completed' }),
    }
  );

  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    return res.status(502).json({ error: 'Twilio could not end the call', detail });
  }

  await supabase.from('calls').update({ status: 'completed' }).eq('id', callId);
  return res.status(200).json({ ok: true });
}
