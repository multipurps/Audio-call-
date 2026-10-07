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
