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
  // Only said when the relay reported it. WhatsApp does not tell a caller that they
  // are blocked, so a block is never named here.
  if (/do.?not.?disturb|\bdnd\b/.test(text)) {
    return `WhatsApp reported that ${who} has Do Not Disturb on, so the call went unanswered. I ended it. Try again later.`;
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
  // The relay got an end signal with no reason on it (not a decline, busy, timeout
  // or Do Not Disturb). State exactly that and nothing more.
  if (/user.?ended/.test(r) && !/reject|declin/.test(s)) {
    return `The call to ${who} on ${channel} ended before it was answered. WhatsApp did not say why. Say "try again" to retry.`;
  }
  if (/fail|error|unreachable|offline|not.?registered|invalid/.test(text)) {
    // The provider rarely says why. State only what was reported; never claim the call
    // did not ring or that the recipient lacks the app unless the provider said so.
    const detail = r && !/^(failed|error)$/.test(r) ? ` (${r})` : '';
    return `The call to ${who} on ${channel} did not connect${detail}. I don't know why. Say "try again" to retry.`;
  }
  if (s === 'disconnected' || s === 'ended' || s === 'completed') {
    return `The call to ${who} on ${channel} ended before it was answered. I can't tell what happened. Nothing was said.`;
  }
  return null;
}
