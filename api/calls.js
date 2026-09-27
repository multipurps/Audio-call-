import { confirmCallPlan } from '../lib/callPlans.js';
import { getServiceClient, getAuthedUserId } from '../lib/supabaseAdmin.js';
import { wacallsHangup } from '../lib/wacallsClient.js';
import { mpRelayRequest } from '../lib/mpRelayClient.js';

export default async function handler(req, res) {
  const supabase = getServiceClient();
  const userId = await getAuthedUserId(req, supabase);
  if (!userId) return res.status(401).json({ error: 'Not signed in' });

  const action = req.query?.action || req.body?.action;

  switch (action) {
    // Legacy endpoint must not bypass script confirmation.
    case 'create': return confirmCallPlan(req, res, supabase, userId);
    case 'hangup': return hangupCall(req, res, supabase, userId);
    case 'mute': return muteCall(req, res, supabase, userId);
    case 'list': return listCalls(req, res, supabase, userId);
    default: return res.status(400).json({ error: 'Unknown or missing action' });
  }
}

async function hangupCall(req, res, supabase, userId) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const { callId } = req.body || {};
  if (!callId) return res.status(400).json({ error: 'callId required' });

  const { data: call } = await supabase.from('calls').select('*').eq('id', callId).eq('user_id', userId).maybeSingle();
  if (!call) return res.status(404).json({ error: 'Call not found' });

  if (call.platform === 'whatsapp') {
    if (call.platform_call_id) {
      const { data: waRow } = await supabase.from('whatsapp_accounts').select('wacalls_session_id').eq('user_id', userId).maybeSingle();
      if (waRow?.wacalls_session_id) {
        await wacallsHangup(userId, waRow.wacalls_session_id, call.platform_call_id).catch((err) => {
          console.error('wacallsHangup failed:', err.message); // best-effort - still mark completed below
        });
      }
    }
    await supabase.from('calls').update({ status: 'completed' }).eq('id', callId);
    return res.status(200).json({ ok: true });
  }

  if (call.platform === 'telegram') {
    if (call.platform_call_id) {
      await mpRelayRequest(`/calls/${call.platform_call_id}`, { method: 'DELETE' }).catch((err) => {
        console.error('mp-relay hangup failed:', err.message); // best-effort - still mark completed below
      });
    }
    await supabase.from('calls').update({ status: 'completed' }).eq('id', callId);
    return res.status(200).json({ ok: true });
  }

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
  const calls = (data || []).map((c) => ({ ...c, contact_name: c.call_kind === 'emysa' ? 'Emysa (callback to you)' : c.contact_id ? namesById.get(c.contact_id) || null : null }));

  return res.status(200).json({ calls });
}
