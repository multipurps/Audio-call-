import { describeDialRejection } from './callOutcome.js';
import { sameNumber } from './phoneNumbers.js';
import { STARTING_MINUTES } from './billing.js';
import { getUsableLine } from './phoneLines.js';
import { telephonyProvider, telnyxConfigured, telnyxDial, signalwireConfigured, signalwireDial, streamUrl } from './telephony.js';
import { moodFields, isMissingMoodColumn } from './callMood.js';
// The saved contact for this call: the one named, or else the one whose number this is. A call to a saved
// contact is shown by name everywhere, never as a bare number.
async function resolveContact(supabase, userId, contactId, toNumber) {
  try {
    if (contactId) {
      const { data } = await supabase.from('contacts').select('id,name').eq('id', contactId).maybeSingle();
      if (data) return data;
    }
    const { data: all } = await supabase.from('contacts').select('id,name,phone_number').eq('user_id', userId);
    return (all || []).find((c) => sameNumber(c.phone_number, toNumber)) || null;
  } catch { return null; }
}

// Shared phone transport (SignalWire, or Telnyx when TELEPHONY_PROVIDER=telnyx). Only confirmed call plans may invoke this.
// The relay and assistant run on a plan that sleeps when idle, and a sleeping service needs far longer to wake than a
// callee needs to answer. Poke them as the call is placed so they are up by the time the callee picks up.
function wakeServices(env = process.env) {
  const targets = [];
  const relay = streamUrl(env.RELAY_WS_URL).replace(/^ws/i, 'http');
  if (relay) targets.push(relay);
  if (env.ASSISTANT_WARMUP_URL) targets.push(env.ASSISTANT_WARMUP_URL);
  const pings = Promise.allSettled(targets.map((u) => fetch(u, { signal: AbortSignal.timeout(50_000) }).catch(() => null)));
  return Promise.race([pings, new Promise((r) => setTimeout(r, 1500))]);
}

export async function placeCall(supabase, userId, { toNumber, objective, contactId, callerId = null, sessionId = null, kind = 'contact', mood = null }) {
  const waking = wakeServices();
  const { data: usage, error: usageError } = await supabase.from('user_usage').select('*').eq('user_id', userId).maybeSingle();
  if (usageError) return { error: 'could not verify your call allowance' };
  const used = usage?.call_minutes_used ?? 0;
  const limit = (usage?.monthly_minute_limit ?? STARTING_MINUTES) + (usage?.bonus_minutes ?? 0);
  if (used >= limit) return { error: 'monthly call minutes exhausted' };

  // The phone carrier is reachable ONLY through the user's own verified/rented line. No
  // line, no phone call: there is no shared fallback number any more.
  const line = await getUsableLine(supabase, userId);
  if (!line) return { error: 'phone calling is not set up on your account (add a line in Profile > Calling lines, or use WhatsApp)' };
  const fromNumber = line.phone_number;
  const appUrl = process.env.PUBLIC_APP_URL;
  const useTelnyx = telephonyProvider() === 'telnyx';
  if (useTelnyx ? (!telnyxConfigured() || !appUrl) : (!signalwireConfigured() || !appUrl)) return { error: 'telephony not configured yet' };

  const { data: settings } = await supabase.from('profiles').select('record_calls, ring_seconds').eq('user_id', userId).maybeSingle();
  const recordCalls = settings?.record_calls ?? true;
  const ringSeconds = settings?.ring_seconds ?? 25;

  const contact = await resolveContact(supabase, userId, contactId, toNumber);
  contactId = contact?.id || contactId;
  const who = contact?.name || 'that number';

  const callRow = {
    user_id: userId,
    caller_id: callerId,
    to_number: toNumber,
    objective,
    call_kind: kind,
    status: 'queued',
    contact_id: contactId || null,
    session_id: sessionId || null,
    ...moodFields(mood),
  };
  let { data: call, error: insertErr } = await supabase.from('calls').insert(callRow).select().single();
  if (insertErr && callRow.mood && isMissingMoodColumn(insertErr)) {
    // the mood column is not added yet: place the call without a mood rather than not at all.
    delete callRow.mood;
    ({ data: call, error: insertErr } = await supabase.from('calls').insert(callRow).select().single());
  }
  if (insertErr) return { error: insertErr.message };

  try {
    if (useTelnyx) {
      await waking;
      const r = await telnyxDial({ to: toNumber, from: fromNumber, callId: call.id, appUrl, record: recordCalls, ringSeconds });
      if (!r.ok) {
        console.error(`placeCall: Telnyx rejected the call (status ${r.status}, code ${r.code}):`, r.detail);
        const outcome = describeDialRejection({ status: r.status, code: r.code, detail: r.detail }, who);
        await supabase.from('calls').update({ status: 'failed', outcome_summary: outcome.summary }).eq('id', call.id);
        return { error: outcome.summary || 'call provider rejected the call' };
      }
      await supabase.from('calls').update({ twilio_call_sid: r.sid, status: 'ringing' }).eq('id', call.id);
      return { call };
    }
    await waking;
    const r = await signalwireDial({ to: toNumber, from: fromNumber, callId: call.id, appUrl, record: recordCalls, ringSeconds });
    if (!r.ok) {
      console.error(`placeCall: SignalWire rejected the call (status ${r.status}, code ${r.code}):`, r.detail);
      const outcome = describeDialRejection({ status: r.status, code: r.code, detail: r.detail }, who);
      await supabase.from('calls').update({ status: 'failed', outcome_summary: outcome.summary }).eq('id', call.id);
      return { error: outcome.summary || 'call provider rejected the call' };
    }
    await supabase.from('calls').update({ twilio_call_sid: r.sid, status: 'ringing' }).eq('id', call.id);
    return { call };
  } catch (err) {
    // The provider might have accepted the call before the connection failed.
    // Keep the call visible as queued until its webhook reconciles the state.
    console.error('placeCall: provider result unknown:', err.message);
    await supabase.from('calls').update({ outcome_summary: 'Provider response lost. This call may still connect; check its status before calling again.' }).eq('id', call.id);
    return { error: 'the provider response was lost; this call may still connect', uncertain: true, callId: call.id };
  }
}
