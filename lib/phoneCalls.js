import { describeCallEnd } from './callOutcome.js';
import { getUsableLine } from './phoneLines.js';
// Shared Twilio transport. Only confirmed call plans may invoke this.
export async function placeCall(supabase, userId, { toNumber, objective, contactId, callerId = null, sessionId = null, kind = 'contact' }) {
  const { data: usage, error: usageError } = await supabase.from('user_usage').select('*').eq('user_id', userId).maybeSingle();
  if (usageError) return { error: 'could not verify your call allowance' };
  const used = usage?.call_minutes_used ?? 0;
  const limit = (usage?.monthly_minute_limit ?? 60) + (usage?.bonus_minutes ?? 0);
  if (used >= limit) return { error: 'monthly call minutes exhausted' };

  // Twilio is reachable ONLY through the user's own verified/rented line. No
  // line, no phone call: there is no shared fallback number any more.
  const line = await getUsableLine(supabase, userId);
  if (!line) return { error: 'phone calling is not set up on your account (add a line in Profile > Calling lines, or use WhatsApp)' };
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const fromNumber = line.phone_number;
  const appUrl = process.env.PUBLIC_APP_URL;
  if (!accountSid || !authToken || !appUrl) return { error: 'telephony not configured yet' };

  const { data: settings } = await supabase.from('profiles').select('record_calls, ring_seconds').eq('user_id', userId).maybeSingle();
  const recordCalls = settings?.record_calls ?? true;
  const ringSeconds = settings?.ring_seconds ?? 25;

  const { data: call, error: insertErr } = await supabase
    .from('calls')
    .insert({
      user_id: userId,
      caller_id: callerId,
      to_number: toNumber,
      objective,
      call_kind: kind,
      status: 'queued',
      contact_id: contactId || null,
      session_id: sessionId || null,
    })
    .select()
    .single();
  if (insertErr) return { error: insertErr.message };

  try {
    const twiml_url = `${appUrl}/api/calls-twiml?callId=${call.id}`;
    const status_callback = `${appUrl}/api/calls-status?callId=${call.id}`;
    const body = new URLSearchParams({
      To: toNumber,
      From: fromNumber,
      Url: twiml_url,
      StatusCallback: status_callback,
      StatusCallbackEvent: 'initiated ringing answered completed',
      Record: recordCalls ? 'true' : 'false',
      Timeout: String(ringSeconds),
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
      console.error(`placeCall: Twilio rejected the call (status ${twilioResp.status}):`, detail.slice(0, 500));
      let parsed = null;
      try { parsed = JSON.parse(detail); } catch { /* not json */ }
      const outcome = describeCallEnd({ twilioStatus: 'failed', errorCode: parsed?.code, name: 'that number' });
      await supabase.from('calls').update({ status: 'failed', outcome_summary: outcome.summary }).eq('id', call.id);
      return { error: outcome.summary || 'call provider rejected the call' };
    }
    const twilioData = await twilioResp.json();
    await supabase.from('calls').update({ twilio_call_sid: twilioData.sid, status: 'ringing' }).eq('id', call.id);
    return { call };
  } catch (err) {
    // The provider might have accepted the call before the connection failed.
    // Keep the call visible as queued until its webhook reconciles the state.
    console.error('placeCall: provider result unknown:', err.message);
    await supabase.from('calls').update({ outcome_summary: 'Provider response lost. This call may still connect; check its status before calling again.' }).eq('id', call.id);
    return { error: 'the provider response was lost; this call may still connect', uncertain: true, callId: call.id };
  }
}
