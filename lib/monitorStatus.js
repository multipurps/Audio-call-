// Plain-language status for the live listen-in, so the call screen never shows
// "Listening in" while nothing can be heard, and never fails with a generic
// "Monitoring unavailable". Pure functions: unit-tested, no DOM.

export const MONITOR_NO_AUDIO_MS = 8000;

// A control message from the assistant service's /monitor socket.
// Returns { text, kind } for the status pill, or null to keep the current one.
export function describeMonitorMessage(msg) {
  if (!msg || typeof msg !== 'object') return null;
  if (msg.type === 'ready') {
    // Nothing useful to say while audio is simply on its way: keep the current status.
    return msg.callLive === false ? { kind: 'connecting', text: 'Waiting for the call to start' } : null;
  }
  if (msg.type === 'error') {
    if (msg.reason === 'auth-refused') {
      return { kind: 'error', text: 'Listen-in isn\u2019t available right now' };
    }
    if (msg.reason === 'too-many-listeners') {
      return { kind: 'error', text: 'Listen-in is already open on two devices' };
    }
    return { kind: 'error', text: 'Listen-in isn\u2019t available right now' };
  }
  return null;
}

// The socket closed or errored. `opened` is whether it ever connected.
export function describeMonitorClose({ opened, code, hadAudio, alreadyExplained }) {
  if (alreadyExplained) return null; // the service already told us why
  if (!opened) {
    return 'Couldn\u2019t start listen-in. Check your connection and try again';
  }
  if (code === 1013) return 'Listen-in was interrupted. Tap to try again';
  if (code === 1008) return 'Listen-in isn\u2019t available right now';
  if (code === 1011) return 'Listen-in was interrupted. Tap to try again';
  if (hadAudio) return 'Listen-in connection dropped. Tap to listen in again';
  return 'Listen-in connection closed before any audio arrived';
}

export function noAudioMessage(callLive) {
  return callLive === false
    ? 'Nothing to hear yet'
    : 'No audio yet. The line may still be ringing';
}
