// The real reason a WhatsApp/Telegram call did not connect, and what happened
// next. The relays report a raw status (rejected, unanswered, busy, ...); the
// app used to flatten them all to "no answer". Every sentence names the reason
// and the action taken.

export function describeSocialCallEnd({ rawStatus, reason = '', who = 'them', channel = 'WhatsApp', answered = false } = {}) {
  if (answered) return null; // a connected call is summarised from its transcript
  const s = String(rawStatus || '').toLowerCase();
  const r = String(reason || '').toLowerCase();
  const text = `${s} ${r}`;
  if (/reject|declin/.test(text)) {
    return `${who} declined the call on ${channel}. I did not retry.`;
  }
  if (/busy/.test(text)) {
    return `${who} was busy on ${channel}. I ended the call. Try again in a few minutes.`;
  }
  if (/voicemail|machine|answering/.test(text)) {
    return `The call reached ${who}'s voicemail on ${channel}. I ended it without leaving a message.`;
  }
  if (/cancel/.test(text)) {
    return `The call to ${who} on ${channel} was canceled before they answered.`;
  }
  if (/no.?answer|unanswer|timeout|timed.?out|missed/.test(text)) {
    return `${who} didn't pick up on ${channel}. It rang out and I ended the call. Try again later.`;
  }
  if (/fail|error|unreachable|offline|not.?registered|invalid/.test(text)) {
    return `The call to ${who} on ${channel} did not connect${r && !/^(failed|error)$/.test(r) ? ` (${r})` : ''}. It never rang on their side. Check that they have ${channel} and try again.`;
  }
  if (s === 'disconnected' || s === 'ended' || s === 'completed') {
    return `The call to ${who} on ${channel} ended before they answered. Nothing was said.`;
  }
  return null;
}
