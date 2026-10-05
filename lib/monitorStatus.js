// Plain-language status for the live listen-in, so the call screen never shows
// "Listening in" while nothing can be heard, and never fails with a generic
// "Monitoring unavailable". Pure functions: unit-tested, no DOM.

export const MONITOR_NO_AUDIO_MS = 8000;

// A control message from the assistant service's /monitor socket.
// Returns { text, kind } for the status pill, or null to keep the current one.
export function describeMonitorMessage(msg) {
  if (!msg || typeof msg !== 'object') return null;
  if (msg.type === 'ready') {
    return msg.callLive === false
      ? { kind: 'connecting', text: 'Connected, but the assistant is not on this call yet' }
      : { kind: 'connecting', text: 'Connected, waiting for call audio' };
  }
  if (msg.type === 'error') {
    if (msg.reason === 'auth-refused') {
      return { kind: 'error', text: 'Listen-in refused: ASSISTANT_BRIDGE_SECRET does not match between Vercel and the assistant service' };
    }
    if (msg.reason === 'too-many-listeners') {
      return { kind: 'error', text: 'Listen-in is already open on two devices' };
    }
    return { kind: 'error', text: `Listen-in error: ${String(msg.reason || 'unknown').slice(0, 80)}` };
  }
  return null;
}

// The socket closed or errored. `opened` is whether it ever connected.
export function describeMonitorClose({ opened, code, hadAudio, alreadyExplained }) {
  if (alreadyExplained) return null; // the service already told us why
  if (!opened) {
    return 'Could not reach the assistant service. Check PUBLIC_ASSISTANT_WS_URL is a wss:// address and the Render service is awake';
  }
  if (code === 1013) return 'The assistant service is restarting. Tap to listen in again';
  if (code === 1008) return 'Listen-in was refused by the assistant service';
  if (code === 1011) return 'The assistant service hit an error while streaming audio';
  if (hadAudio) return 'Listen-in connection dropped. Tap to listen in again';
  return 'Listen-in connection closed before any audio arrived';
}

export function noAudioMessage(callLive) {
  return callLive === false
    ? 'The assistant has not joined this call, so there is nothing to hear yet'
    : 'Connected, but no call audio has arrived. The line may still be ringing or silent';
}
