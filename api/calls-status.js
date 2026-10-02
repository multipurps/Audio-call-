import { getServiceClient } from '../lib/supabaseAdmin.js';
import { maybeGenerateCallSummary } from '../lib/callSession.js';
import { describeCallEnd } from '../lib/callOutcome.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const supabase = getServiceClient();

  const callId = req.query?.callId;
  const { CallStatus, CallDuration, RecordingUrl, SipResponseCode, ErrorCode, AnsweredBy } = req.body || {};
  if (!callId) return res.status(400).send('missing callId');

  const statusMap = {
    // `initiated` only means Twilio accepted the request. Nothing is ringing
    // yet, so it must not show as ringing.
    initiated: 'queued',
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
  const terminal = ['busy', 'no-answer', 'failed', 'canceled'].includes(CallStatus);
  if (terminal) {
    // Real reason + what happened next, from what the carrier reported.
    const { data: who } = call?.contact_id
      ? await supabase.from('contacts').select('name').eq('id', call.contact_id).maybeSingle()
      : { data: null };
    const outcome = describeCallEnd({
      twilioStatus: CallStatus, sipResponseCode: SipResponseCode, errorCode: ErrorCode,
      answeredBy: AnsweredBy, name: who?.name || 'them',
      byUser: call?.status === 'canceling',
    });
    update.status = outcome.status;
    if (outcome.summary) update.outcome_summary = outcome.summary;
  }
  if (RecordingUrl) update.recording_url = RecordingUrl;
  if (CallDuration) {
    update.duration_seconds = parseInt(CallDuration, 10);
    update.ended_at = new Date().toISOString();
  }
  // Never let a late `initiated`/`ringing` callback move a finished call back.
  const finished = ['no_answer', 'failed', 'completed'].includes(call?.status);
  if (finished && ['queued', 'ringing'].includes(update.status)) return res.status(200).send('ok');
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

  // Calls from chat (including keypad and Emysa callbacks) have a session_id.
  // Legacy calls without a chat session cannot receive a follow-up.

  if (call?.user_id && call?.session_id && ['no_answer', 'completed', 'failed'].includes(status) && status !== call.status) {
    await postAssistantFollowUp(supabase, call.user_id, call.contact_id, call.session_id, callId, update.status, CallDuration, update.outcome_summary);
  }

  // Twilio calls are now terminal: run the shared summary + memory pass.
  // Idempotent — if the relay's own onCallEnd already generated the summary,
  // this is a no-op.
  if (['no_answer', 'completed', 'failed', 'busy', 'canceled'].includes(status)) {
    await maybeGenerateCallSummary(supabase, callId);
  }

  return res.status(200).send('ok');
}

async function postAssistantFollowUp(supabase, userId, contactId, sessionId, callId, status, callDuration, outcomeSummary) {
  const { data: contact } = contactId ? await supabase.from('contacts').select('name').eq('id', contactId).eq('user_id', userId).maybeSingle() : { data: null };
  const { data: plan } = await supabase.from('call_plans').select('label').eq('call_id', callId).eq('user_id', userId).maybeSingle();
  const name = contact?.name || plan?.label || 'the requested number';

  // Roughly how many times we've already tried this contact today, so a
  // repeated busy signal reads as "still busy" rather than resetting each time.
  const since = new Date(Date.now() - 1000 * 60 * 60 * 6).toISOString();
  const { count } = await supabase
    .from('calls')
    .select('id', { count: 'exact', head: true })
    .eq('contact_id', contactId)
    .gte('created_at', since);
  const attempts = count || 1;

  const { data: settings } = await supabase.from('profiles').select('auto_retry').eq('user_id', userId).maybeSingle();
  const autoRetry = settings?.auto_retry ?? true;

  let content;
  if (outcomeSummary) {
    content = outcomeSummary;
  } else if (status === 'no_answer') {
    if (!autoRetry) {
      content = `I tried calling ${name}, but the line was busy.`;
    } else {
      content = attempts > 1
        ? `${name}'s line is still busy. Would you like me to try again in a little while?`
        : `I tried calling ${name}, but the line was busy.`;
    }
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
