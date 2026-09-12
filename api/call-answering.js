import { getServiceClient, getAuthedUserId } from '../lib/supabaseAdmin.js';

async function twilioFetch(path, { method = 'GET', body } = {}) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const auth = 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64');
  const resp = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/${path}`, {
    method,
    headers: { Authorization: auth, ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
    body: body ? new URLSearchParams(body) : undefined,
  });
  if (resp.status === 204) return {};
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.message || 'Twilio request failed');
  return data;
}

export default async function handler(req, res) {
  const supabase = getServiceClient();
  const userId = await getAuthedUserId(req, supabase);
  if (!userId) return res.status(401).json({ error: 'Not signed in' });

  const action = req.query?.action || req.body?.action;
  if (action === 'enable') return enable(req, res, supabase, userId);
  if (action === 'disable') return disable(req, res, supabase, userId);
  if (action === 'update') return update(req, res, supabase, userId);
  return status(req, res, supabase, userId);
}

async function status(req, res, supabase, userId) {
  const { data } = await supabase.from('call_answering_settings').select('*').eq('user_id', userId).maybeSingle();
  return res.status(200).json({
    enabled: data?.enabled ?? false,
    twilioNumber: data?.twilio_number || null,
    greeting: data?.greeting || 'Hey, thanks for calling — how can I help?',
    instructions: data?.instructions || '',
  });
}

async function update(req, res, supabase, userId) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const { greeting, instructions } = req.body || {};
  const patch = { user_id: userId, updated_at: new Date().toISOString() };
  if (typeof greeting === 'string' && greeting.trim()) patch.greeting = greeting.trim();
  if (typeof instructions === 'string') patch.instructions = instructions.trim();
  const { error } = await supabase.from('call_answering_settings').upsert(patch, { onConflict: 'user_id' });
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ ok: true });
}

async function enable(req, res, supabase, userId) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN || !process.env.PUBLIC_APP_URL) {
    return res.status(500).json({ error: "Call answering isn't configured yet." });
  }

  const { data: existing } = await supabase.from('call_answering_settings').select('*').eq('user_id', userId).maybeSingle();
  if (existing?.twilio_number) {
    // Already provisioned (was just disabled before) — just flip it back on.
    await supabase.from('call_answering_settings').update({ enabled: true, updated_at: new Date().toISOString() }).eq('user_id', userId);
    return res.status(200).json({ ok: true, twilioNumber: existing.twilio_number });
  }

  try {
    const available = await twilioFetch('AvailablePhoneNumbers/US/Local.json?VoiceEnabled=true&Limit=1');
    const candidate = available.available_phone_numbers?.[0]?.phone_number;
    if (!candidate) return res.status(500).json({ error: 'No phone numbers available right now — try again shortly.' });

    const voiceUrl = `${process.env.PUBLIC_APP_URL}/api/calls-incoming`;
    const purchased = await twilioFetch('IncomingPhoneNumbers.json', {
      method: 'POST',
      body: { PhoneNumber: candidate, VoiceUrl: voiceUrl, VoiceMethod: 'POST' },
    });

    await supabase.from('call_answering_settings').upsert(
      {
        user_id: userId,
        enabled: true,
        twilio_number: purchased.phone_number,
        twilio_number_sid: purchased.sid,
        greeting: existing?.greeting || 'Hey, thanks for calling — how can I help?',
        instructions: existing?.instructions || '',
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id' }
    );
    return res.status(200).json({ ok: true, twilioNumber: purchased.phone_number });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

async function disable(req, res, supabase, userId) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const { data: existing } = await supabase.from('call_answering_settings').select('*').eq('user_id', userId).maybeSingle();
  if (!existing) return res.status(200).json({ ok: true });

  // Release the number rather than leave it idle — Twilio bills a monthly
  // fee per number whether or not it's answering anything.
  if (existing.twilio_number_sid) {
    try {
      await twilioFetch(`IncomingPhoneNumbers/${existing.twilio_number_sid}.json`, { method: 'DELETE' });
    } catch (err) {
      console.error('failed to release Twilio number:', err.message);
    }
  }

  await supabase
    .from('call_answering_settings')
    .update({ enabled: false, twilio_number: null, twilio_number_sid: null, updated_at: new Date().toISOString() })
    .eq('user_id', userId);
  return res.status(200).json({ ok: true });
}
