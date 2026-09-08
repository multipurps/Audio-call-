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

  const { data: call } = await supabase.from('calls').select('user_id, contact_id, session_id, status').eq('id', callId).maybeSingle();

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

  // Only calls placed through the Emysa's home chat carry a contact_id
  // (see api/assistant.js) — calls started from the older manual "type a
  // number" composer have none, so we don't post noise into a thread that
  // was never talking about them. When a terminal status comes in for one
  // of these, post a natural-language follow-up back into that same thread
  // so the chat updates asynchronously, exactly like the real call does.
  if (call?.user_id && call?.contact_id && ['no_answer', 'completed', 'failed'].includes(status) && status !== call.status) {
    await postAssistantFollowUp(supabase, call.user_id, call.contact_id, call.session_id, callId, status, CallDuration);
  }

  return res.status(200).send('ok');
}

async function postAssistantFollowUp(supabase, userId, contactId, sessionId, callId, status, callDuration) {
  const { data: contact } = await supabase.from('contacts').select('name').eq('id', contactId).maybeSingle();
  const name = contact?.name || 'them';

  // Roughly how many times we've already tried this contact today, so a
  // repeated busy signal reads as "still busy" rather than resetting each time.
  const since = new Date(Date.now() - 1000 * 60 * 60 * 6).toISOString();
  const { count } = await supabase
    .from('calls')
    .select('id', { count: 'exact', head: true })
    .eq('contact_id', contactId)
    .gte('created_at', since);
  const attempts = count || 1;

  let content;
  if (status === 'no_answer') {
    content = attempts > 1
      ? `${name}'s line is still busy. Would you like me to try again in a little while?`
      : `I tried calling ${name}, but the line was busy.`;
  } else if (status === 'failed') {
    content = `I couldn't reach ${name} — the call failed to connect.`;
  } else {
    const mins = callDuration ? Math.max(1, Math.round(parseInt(callDuration, 10) / 60)) : null;
    content = mins ? `Finished the call with ${name} (about ${mins} min).` : `Finished the call with ${name}.`;
  }

  if (!sessionId) return; // call wasn't started from a saved chat thread — nowhere to post this
  await supabase.from('assistant_messages').insert({ user_id: userId, session_id: sessionId, role: 'assistant', content, call_id: callId });
  await supabase.from('chat_sessions').update({ updated_at: new Date().toISOString() }).eq('id', sessionId);
}
