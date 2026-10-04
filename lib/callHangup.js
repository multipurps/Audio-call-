// Single implementation of "hang up this call", shared by the call screen's
// End button (api/calls.js?action=hangup) and by "end the call" typed or
// spoken in chat (api/assistant.js). Both used to diverge: the chat path had
// no way to end a call at all and told the user to use the call screen.
//
// Status and duration are truthful: a call ended before anyone answered is
// 'canceled' with no talk time; a connected call is 'completed' with the
// duration measured from the actual answer (answered_at).
import { wacallsHangup } from './wacallsClient.js';
import { mpRelayRequest } from './mpRelayClient.js';
import { signalHangup } from './signalClient.js';
import { maybeGenerateCallSummary } from './callSession.js';

export const LIVE_CALL_STATUSES = ['queued', 'ringing', 'in_progress'];
const TERMINAL = ['completed', 'failed', 'no_answer', 'busy', 'canceled'];

export async function completeCall(supabase, call) {
  const callId = call?.id || call;
  const nowIso = new Date().toISOString();
  const update = call?.answered_at
    ? {
        status: 'completed',
        ended_at: nowIso,
        duration_seconds: Math.max(0, Math.round((Date.now() - new Date(call.answered_at).getTime()) / 1000)),
      }
    : { status: 'canceled', ended_at: nowIso };
  await supabase.from('calls').update(update).eq('id', callId).in('status', LIVE_CALL_STATUSES);
  await maybeGenerateCallSummary(supabase, callId);
}

async function markSocialEnded(supabase, userId, socialCallId) {
  try {
    await supabase.from('social_calls').update({ status: 'completed', ended_at: new Date().toISOString() })
      .eq('id', socialCallId).eq('user_id', userId);
  } catch { /* best effort */ }
}

/**
 * Ends the provider leg of `call` (WhatsApp/Telegram/Twilio) and finalises the
 * row. Returns { ok, alreadyEnded?, error?, detail?, httpStatus? } - never
 * throws for provider failures so callers can surface the real reason.
 */
export async function endCallRow(supabase, userId, call) {
  if (TERMINAL.includes(call.status)) return { ok: true, alreadyEnded: true };

  if (call.platform === 'whatsapp') {
    if (call.platform_call_id) {
      const { data: waRow } = await supabase.from('whatsapp_accounts').select('wacalls_session_id').eq('user_id', userId).maybeSingle();
      if (waRow?.wacalls_session_id) {
        await wacallsHangup(userId, waRow.wacalls_session_id, call.platform_call_id).catch((err) => {
          console.error('wacallsHangup failed:', err.message); // best-effort - row is still finalised below
        });
      }
      await markSocialEnded(supabase, userId, call.platform_call_id);
    }
    await completeCall(supabase, call);
    return { ok: true };
  }

  if (call.platform === 'telegram') {
    if (call.platform_call_id) {
      await mpRelayRequest(`/calls/${call.platform_call_id}`, { method: 'DELETE' }).catch((err) => {
        console.error('mp-relay hangup failed:', err.message);
      });
      await markSocialEnded(supabase, userId, call.platform_call_id);
    }
    await completeCall(supabase, call);
    return { ok: true };
  }

  if (call.platform === 'signal') {
    if (call.platform_call_id) {
      await signalHangup(call.platform_call_id).catch((err) => {
        console.error('signal hangup failed:', err.message); // best-effort - row is still finalised below
      });
      await markSocialEnded(supabase, userId, call.platform_call_id);
    }
    await completeCall(supabase, call);
    return { ok: true };
  }

  if (call.platform === 'in_app' || (!call.twilio_call_sid && call.platform)) {
    await completeCall(supabase, call);
    return { ok: true };
  }

  if (!call.twilio_call_sid) return { ok: false, httpStatus: 400, error: 'Call has no active Twilio sid' };

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
    return { ok: false, httpStatus: 502, error: 'Twilio could not end the call', detail };
  }
  await completeCall(supabase, call);
  return { ok: true };
}

// "end the call", "hang up", "stop the call", "cancel the call", "drop it".
// Deliberately anchored: a sentence that merely mentions hanging up ("he hung
// up on me", "don't hang up yet") must not end anything.
const END_CALL_RE = /^\s*(?:(?:please|pls|ok(?:ay)?|now|just)[\s,]+)*(?:end|stop|cancel|drop|terminate|hang\s*up|disconnect)(?:\s+(?:the|this|that|my|his|her|their|it))*(?:\s+(?:call|line|chat))?(?:\s+(?:now|please|pls))?\s*[.!]*\s*$/i;
const NEGATED_RE = /\b(don'?t|do not|never|not yet|wait|hold on)\b/i;

export function isEndCallRequest(text) {
  const t = String(text || '').trim();
  if (!t || t.length > 60) return false;
  if (NEGATED_RE.test(t)) return false;
  return END_CALL_RE.test(t);
}
