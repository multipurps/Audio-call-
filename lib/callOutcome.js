// Turns what the carrier actually reported into the real reason a call did
// not connect, plus what happened next. No guessing and no generic "failed":
// every line says WHY and WHAT WE DID (or what the user can do).
//
// Inputs are Twilio status-callback fields:
//   CallStatus       busy | no-answer | failed | canceled | completed
//   SipResponseCode  carrier's final SIP code, when present (486, 603, ...)
//   ErrorCode        Twilio error code on `failed`, when present
//   AnsweredBy       machine_start | machine_end_* | fax | human | unknown

const TWILIO_ERRORS = {
  13224: "that number isn't a valid phone number",
  13225: "calls to that country aren't enabled on the phone account",
  13226: "calls to that country aren't enabled on the phone account",
  21211: "that number isn't a valid phone number",
  21214: "that number isn't a valid phone number",
  21215: "calls to that country aren't enabled on the phone account",
  21217: "that number isn't a valid phone number",
};

function sipReason(code) {
  switch (Number(code)) {
    case 486:
    case 600:
      return { kind: 'busy', why: 'the line was busy' };
    case 603:
    case 607:
      return { kind: 'declined', why: 'they declined the call' };
    case 404:
    case 410:
    case 604:
      return { kind: 'unreachable', why: "that number doesn't exist or isn't in service" };
    case 484:
      return { kind: 'unreachable', why: "that number is incomplete or invalid" };
    case 480:
    case 503:
      return { kind: 'unreachable', why: 'the phone is off or out of coverage' };
    case 408:
    case 487:
      return { kind: 'noanswer', why: 'the phone rang but nobody picked up' };
    case 403:
      return { kind: 'blocked', why: 'the carrier blocked the call' };
    default:
      return null;
  }
}

export function isVoicemail(answeredBy) {
  const v = String(answeredBy || '');
  return v.startsWith('machine') || v === 'fax';
}

/**
 * @returns {{ status: 'no_answer'|'failed'|'completed', summary: string|null, reason: string }}
 *   `summary` is null for a call that connected (the transcript summary
 *   handles those).
 */
export function describeCallEnd({ twilioStatus, sipResponseCode, errorCode, answeredBy, name = 'them', byUser = false } = {}) {
  const who = name || 'them';
  if (isVoicemail(answeredBy)) {
    return {
      status: 'no_answer',
      reason: 'voicemail',
      summary: `Reached ${who}'s voicemail. I ended the call without leaving a message. Try again later or send a message.`,
    };
  }
  const sip = sipReason(sipResponseCode);

  switch (twilioStatus) {
    case 'completed':
      return { status: 'completed', reason: 'completed', summary: null };
    case 'busy':
      if (sip?.kind === 'declined') {
        return { status: 'no_answer', reason: 'declined', summary: `${who} declined the call. I did not retry.` };
      }
      return { status: 'no_answer', reason: 'busy', summary: `${who}'s line was busy. I did not connect. Try again in a few minutes.` };
    case 'no-answer':
      if (sip && sip.kind !== 'noanswer') {
        return summaryFromSip(sip, who);
      }
      return { status: 'no_answer', reason: 'no_answer', summary: `${who}'s phone rang but nobody picked up. I ended the call after it rang out. Try again later.` };
    case 'canceled':
      return byUser
        ? { status: 'failed', reason: 'canceled_by_user', summary: `You ended the call before ${who} answered.` }
        : { status: 'failed', reason: 'canceled', summary: `The call to ${who} was canceled before it was answered.` };
    case 'failed': {
      if (sip) return summaryFromSip(sip, who);
      const tw = TWILIO_ERRORS[Number(errorCode)];
      if (tw) return { status: 'failed', reason: `error_${errorCode}`, summary: `The call to ${who} did not go through because ${tw}. Nothing rang.` };
      return { status: 'failed', reason: 'carrier_failed', summary: `The call to ${who} did not go through. The carrier could not connect it, so nothing rang. Try again.` };
    }
    default:
      return { status: 'failed', reason: 'unknown', summary: null };
  }
}

function summaryFromSip(sip, who) {
  const status = ['busy', 'declined', 'noanswer'].includes(sip.kind) ? 'no_answer' : 'failed';
  const action = sip.kind === 'declined'
    ? 'I did not retry.'
    : sip.kind === 'busy'
      ? 'I did not connect. Try again in a few minutes.'
      : sip.kind === 'unreachable'
        ? 'Check the number or try again later.'
        : 'Try again.';
  const lead = sip.kind === 'declined' ? `${who} declined the call` : `The call to ${who} did not connect because ${sip.why}`;
  return { status, reason: sip.kind, summary: sip.kind === 'declined' ? `${lead}. ${action}` : `${lead}. ${action}` };
}
