import { getServiceClient } from '../lib/supabaseAdmin.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const supabase = getServiceClient();

  const callId = req.query?.callId;
  const { CallStatus, CallDuration, RecordingUrl } = req.body || {};
  if (!callId) return res.status(400).send('missing callId');

  const statusMap = {
    initiated: 'ringing',
    ringing: 'ringing',
    'in-progress': 'in_progress',
    completed: 'completed',
    busy: 'no_answer',
    'no-answer': 'no_answer',
    failed: 'failed',
    canceled: 'failed',
  };
  const status = statusMap[CallStatus] || CallStatus;

  const { data: call } = await supabase.from('calls').select('user_id').eq('id', callId).maybeSingle();

  const update = { status };
  if (RecordingUrl) update.recording_url = RecordingUrl;
  if (CallDuration) {
    update.duration_seconds = parseInt(CallDuration, 10);
    update.ended_at = new Date().toISOString();
  }
  await supabase.from('calls').update(update).eq('id', callId);

  // Increment usage only once the call actually ends, using Twilio's
  // authoritative duration rather than anything the relay server reported.
  if (call?.user_id && CallDuration) {
    const minutes = Math.ceil(parseInt(CallDuration, 10) / 60);
    const { data: usage } = await supabase.from('user_usage').select('*').eq('user_id', call.user_id).maybeSingle();
    const newUsed = (usage?.call_minutes_used ?? 0) + minutes;
    await supabase.from('user_usage').upsert({
      user_id: call.user_id,
      call_minutes_used: newUsed,
      monthly_minute_limit: usage?.monthly_minute_limit ?? 60,
      updated_at: new Date().toISOString(),
    });
  }

  return res.status(200).send('ok');
}
