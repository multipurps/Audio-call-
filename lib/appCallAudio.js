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

// Stateful mic downsampler: the same box filter as floatToPcm16k, but the fractional
// remainder of each chunk is carried into the next instead of being thrown away.
// floatToPcm16k floors every chunk independently, so a 1024-sample chunk at 48 kHz (the
// worklet delivers whole 128-sample quanta) produced 341 outputs and lost one input
// sample per chunk: a tiny discontinuity ~47 times a second in the audio sent to Emysa.
// Here the output sample count over any run of chunks equals floor(total input / ratio).
export function createMicDownsampler(inputRate) {
  let carry = new Float32Array(0); // input not yet consumed by a whole output sample
  let inBase = 0;                  // global index of carry[0] in the input stream
  let outIndex = 0;                // global index of the next output sample
  // Output sample k covers global input [floor(k * inputRate / 16000), floor((k + 1) * inputRate / 16000)).
  // Integer arithmetic on the GLOBAL index keeps the window grid identical to resampling the
  // whole stream at once, even for a non-integer ratio such as 44.1 kHz -> 16 kHz.
  const edge = (k) => Math.floor((k * inputRate) / APP_CALL_RATE);
  return function push(input) {
    if (!input || !input.length || !inputRate) return new Int16Array(0);
    let buf = input;
    if (carry.length) {
      buf = new Float32Array(carry.length + input.length);
      buf.set(carry, 0);
      buf.set(input, carry.length);
    }
    const out = [];
    for (;;) {
      const start = edge(outIndex) - inBase;
      const end = Math.max(start + 1, edge(outIndex + 1) - inBase);
      if (end > buf.length) break; // the window needs input that has not arrived yet
      let sum = 0;
      for (let j = start; j < end; j++) sum += buf[j];
      const v = Math.max(-1, Math.min(1, sum / (end - start)));
      out.push(v < 0 ? v * 0x8000 : v * 0x7fff);
      outIndex += 1;
    }
    const consumed = Math.min(buf.length, edge(outIndex) - inBase);
    carry = buf.slice(consumed);
    inBase += consumed;
    return Int16Array.from(out);
  };
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
