// Audio and status helpers for the in-app Emysa live call. Pure and DOM-free so
// they are unit tested. The browser streams raw PCM16 mono at 16 kHz up, and
// receives frames of [4-byte little-endian sample rate][PCM16 mono] back.

export const APP_CALL_RATE = 16000;

// Float32 mic samples at `inputRate` -> PCM16 at 16 kHz (box-filter downsample,
// so there is no aliasing hiss from naive sample dropping).
export function floatToPcm16k(input, inputRate) {
  if (!input || !input.length || !inputRate) return new Int16Array(0);
  const ratio = inputRate / APP_CALL_RATE;
  const outLen = Math.max(1, Math.floor(input.length / ratio));
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.max(start + 1, Math.floor((i + 1) * ratio)));
    let sum = 0;
    for (let j = start; j < end; j++) sum += input[j];
    const v = Math.max(-1, Math.min(1, sum / (end - start)));
    out[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
  }
  return out;
}

export function decodeAppCallFrame(buf) {
  if (!buf || buf.byteLength < 6) return null;
  const rate = new DataView(buf).getUint32(0, true) || APP_CALL_RATE;
  const pcm = buf.slice(4);
  const samples = new Int16Array(pcm, 0, Math.floor(pcm.byteLength / 2));
  return samples.length ? { rate, samples } : null;
}

// A control message from the service. { kind: 'info'|'error'|'ended', text }.
export function describeAppCallMessage(msg) {
  if (!msg || typeof msg !== 'object') return null;
  if (msg.type === 'ready') return { kind: 'info', text: 'Connected' };
  if (msg.type === 'ended' || msg.type === 'hangup' || msg.type === 'stopped') return { kind: 'ended', text: 'Call ended' };
  if (msg.type === 'error') {
    if (msg.reason === 'auth-refused') return { kind: 'error', text: 'The call couldn\u2019t start. Try again later' };
    if (msg.reason === 'busy') return { kind: 'error', text: 'Emysa is busy right now. Try again in a moment' };
    if (msg.reason === 'call-failed' || msg.reason === 'assistant-start-failed') return { kind: 'error', text: 'The call couldn\u2019t start. Try again' };
    return { kind: 'error', text: 'The call couldn\u2019t start. Try again' };
  }
  return null;
}

export function describeAppCallClose({ opened, code, explained, ended }) {
  if (explained || ended) return null;
  if (!opened) return 'Couldn\u2019t connect the call. Check your connection and try again';
  if (code === 1013) return 'The call was interrupted. Start it again';
  if (code === 1011) return 'The call ended unexpectedly';
  return 'The call connection dropped';
}

// Why the microphone could not start, in words a person can act on.
export function describeMicError(err) {
  const name = err?.name || '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'Microphone access is blocked. Allow the microphone for this app in your phone settings, then call again';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No microphone was found on this device';
  if (name === 'NotReadableError') return 'The microphone is in use by another app';
  return 'The microphone could not start';
}
