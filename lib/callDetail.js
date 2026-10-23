// Small rules for the call detail screen (the page you open from Recents).

// A call made inside the app, to Emysa herself. It is stored with platform 'app' and the literal name
// "Emysa" where a phone call keeps a number, so anything that treats every call as a phone call will
// ask for a number that does not exist.
export const isAppCall = (call) => call?.platform === 'app';

// Where "Call again" sends the call. An Emysa call is never dialed: it simply opens the Emysa call.
export function callAgainPlatform(call) {
  if (isAppCall(call)) return 'app';
  return call?.platform === 'whatsapp' || call?.platform === 'telegram' ? call.platform : 'phone';
}

// Who spoke, for the transcript. In a call with Emysa the other voice is the person using the app, so
// labelling it with the contact name made both sides read "Emysa:".
export function transcriptSpeakerLabel(call, turn, name) {
  const isAi = turn?.speaker === 'ai' || turn?.speaker === 'assistant' || turn?.role === 'assistant';
  if (isAi) return 'Emysa:';
  return isAppCall(call) ? 'You:' : `${name || 'Caller'}:`;
}

// A call that was answered and talked. Used so a call that connected is never described as one that failed to connect.
export function callTalked(call) {
  return Number(call?.duration_seconds) > 0 || (Array.isArray(call?.transcript) && call.transcript.length > 0);
}
