import { guardWebhook } from '../lib/telephony.js';
import { getServiceClient } from '../lib/supabaseAdmin.js';
import { maybeGenerateCallSummary } from '../lib/callSession.js';
import { describeCallEnd } from '../lib/callOutcome.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const callId = req.query?.callId;
  if (!guardWebhook(req, res, `call:${callId}`)) return;
  const supabase = getServiceClient();

  const { CallStatus, CallDuration, RecordingUrl, SipResponseCode, ErrorCode, AnsweredBy } = req.body || {};
  if (!callId) return res.status(400).send('missing callId');

  const statusMap = {
    // `initiated` only means the carrier accepted the request. Nothing is ringing
    // yet, so it must not show as ringing.
    initiated: 'queued',
    ringing: 'ringing',
    'in-progress': 'in_progress',
    // The carrier's name for the callee picking up. Voicemail also "answers", and that is only known a moment
    // later (calls-twiml.js), so this must not show as connected. The call becomes in_progress there, once a
    // person is confirmed on the line.
    answered: 'ringing',
    completed: 'completed',
    busy: 'no_answer',
    'no-answer': 'no_answer',
    failed: 'failed',
    canceled: 'failed',
  };
  const status = statusMap[CallStatus] || CallStatus;

  const { data: call } = await supabase.from('calls').select('user_id, contact_id, session_id, status, outcome_summary').eq('id', callId).maybeSingle();

  // The outcome was already decided when the call was answered (voicemail, fax). The carrier's final `completed`
  // is just the hang-up we did ourselves: keep that outcome, and tell the chat once.
  if (CallStatus === 'completed' && call && ['no_answer', 'failed'].includes(call.status) && call.outcome_summary) {
    if (CallDuration) await supabase.from('calls').update({ duration_seconds: parseInt(CallDuration, 10), ended_at: new Date().toISOString() }).eq('id', callId);
    if (call.user_id && call.session_id) {
      await postAssistantFollowUp(supabase, call.user_id, call.contact_id, call.session_id, callId, call.status, CallDuration, call.outcome_summary);
    }
    return res.status(200).send('ok');
  }

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

  // Minutes are charged by the calls_charge_minutes trigger (sql/027) when
  // duration_seconds is written above, for every call type and exactly once.

  // Calls from chat (including keypad and Emysa callbacks) have a session_id.
  // Legacy calls without a chat session cannot receive a follow-up.

  if (call?.user_id && call?.session_id && ['no_answer', 'completed', 'failed'].includes(status) && status !== call.status) {
    await postAssistantFollowUp(supabase, call.user_id, call.contact_id, call.session_id, callId, update.status, CallDuration, update.outcome_summary);
  }

  // Phone calls are now terminal: run the shared summary + memory pass.
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
  // One message per call: the carrier can report the same ending more than once.
  const { data: already } = await supabase.from('assistant_messages').select('id').eq('call_id', callId).eq('role', 'assistant').limit(1);
  if (already?.length) return;
  await supabase.from('assistant_messages').insert({ user_id: userId, session_id: sessionId, role: 'assistant', content, call_id: callId });
  await supabase.from('chat_sessions').update({ updated_at: new Date().toISOString() }).eq('id', sessionId);
}
