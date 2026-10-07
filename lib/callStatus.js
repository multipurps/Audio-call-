// What the call screen's status pill may say. Pure, no DOM: unit-tested.
//
// The pill exists for things the user needs to know or did themselves
// (Calling, Ringing, a mute they switched on, how a call ended, a real error).
// A healthy call says nothing: the timer and the waveform already show it is
// live, so connection and listening/speaking states are implementation detail,
// not information. null means "show no pill".

export function answeredCallPill({ aiMuted }) {
  return aiMuted ? { phase: 'muted', label: 'Emysa muted' } : null;
}

export function assistantCallPill({ muted }) {
  return muted ? { phase: 'muted', label: 'Microphone muted' } : null;
}

export function listenInPill({ muted }) {
  return muted ? { phase: 'muted', label: 'Listening · muted' } : null;
}

// ---- live-call status: ONE mapping from the real call status to what is shown ----
//
// `status` is the calls.status the provider's own events produce:
//   queued      we dialed; the provider has not reported ringing yet
//   ringing     the provider reported the call is ringing
//   in_progress the provider reported the callee ANSWERED (answered_at is stamped then)
//   rejected    the callee rejected the call
//   completed | no_answer | busy | failed | canceled   how a call ended
// Nothing here is driven by a timer: if the provider has not said it, we do not show it.

export const REJECTED_LABEL = 'Call rejected';

export const CALL_ENDED_LABELS = Object.freeze({
  completed: 'Call ended',
  rejected: REJECTED_LABEL,
  no_answer: 'No answer',
  busy: 'Busy',
  failed: 'Call failed',
  canceled: 'Call canceled',
});

export const TERMINAL_STATUSES = Object.freeze(Object.keys(CALL_ENDED_LABELS));

// -> { pill: {phase,label} | null, timer: boolean }
//   timer: whether the duration timer is shown. It is shown only for an answered call.
export function liveCallView({ status, aiMuted = false } = {}) {
  switch (status) {
    case 'ringing':
      return { pill: { phase: 'connecting', label: 'Ringing' }, timer: false };
    case 'in_progress':
    case 'in-progress':
      // A healthy answered call shows no pill at all - just the running time.
      return { pill: answeredCallPill({ aiMuted }), timer: true };
    case 'queued':
    default:
      // Dialing. We must not say "Ringing" until the provider reports it.
      return { pill: { phase: 'connecting', label: 'Calling' }, timer: false };
  }
}

// The label for a call that has ended; null for a status that is not terminal.
export function endedCallLabel(status) {
  if (CALL_ENDED_LABELS[status]) return CALL_ENDED_LABELS[status];
  return null;
}

// Elapsed talk time as mm:ss, counted ONLY from the provider's answer. Before the
// answer there is no time to show (ring time is not talk time): returns null.
export function formatCallTimer(answeredAtMs, nowMs = Date.now()) {
  if (!Number.isFinite(answeredAtMs)) return null;
  const secs = Math.max(0, Math.floor((nowMs - answeredAtMs) / 1000));
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
