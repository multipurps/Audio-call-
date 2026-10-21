// Turns whatever audio the user picks into the clip the clone service needs.
//
// The clone service takes a WAV or MP3 sample (it does not list WebM), up to 30 seconds (3 minimum). An iPhone gives you something else: Voice Memos are .m4a (AAC), screen recordings are
// .mov/.mp4 with an audio track, other apps export .caf or .aac. So the browser decodes whatever
// was picked and re-encodes the first 30 seconds as 16-bit mono WAV, which is always accepted and
// always small (30 s at 24 kHz is about 1.4 MB).
//
// The maths is pure and unit-tested (tests/voice-clip.test.mjs); only fileToWavBase64 touches the
// browser (FileReader and the Web Audio decoder).

// Inworld: clones work from as little as 3 seconds, similarity improves with length, 30 seconds is the limit.
export const CLIP_MAX_SECONDS = 30;
export const CLIP_MIN_SECONDS = 3;
export const CLIP_RATE = 24000;
export const CLIP_MAX_PICK_BYTES = 60 * 1024 * 1024; // the picked file is only decoded, never uploaded

// What the file picker lets through. MIME wildcard plus explicit extensions: iOS Files greys out
// anything whose type it cannot match, and a bare "audio/*" misses containers such as .mp4/.mov
// (an audio track inside a video) and some .m4a/.caf files.
export const CLIP_ACCEPT = [
  'audio/*', 'video/mp4', 'video/quicktime', 'video/webm',
  '.mp3', '.m4a', '.aac', '.wav', '.wave', '.caf', '.aif', '.aiff', '.flac', '.ogg', '.oga', '.opus', '.webm', '.mp4', '.mov', '.3gp', '.amr',
].join(',');

const CLIP_EXT = /\.(mp3|m4a|aac|wav|wave|caf|aiff?|flac|og[ga]|opus|webm|mp4|mov|3gp|amr)$/i;

/** Is this plausibly audio (including audio inside a video container)? iOS often reports an empty type. */
export function looksLikeAudio(file) {
  const type = String(file?.type || '').toLowerCase();
  if (type.startsWith('audio/')) return true;
  if (/^video\/(mp4|quicktime|webm|3gpp)$/.test(type)) return true;
  return CLIP_EXT.test(String(file?.name || ''));
}

/** Average all channels into one. */
export function mixToMono(channels) {
  if (!channels?.length) return new Float32Array(0);
  if (channels.length === 1) return channels[0];
  const out = new Float32Array(channels[0].length);
  for (const ch of channels) for (let i = 0; i < out.length; i += 1) out[i] += ch[i] / channels.length;
  return out;
}

/** Linear-interpolation resample. Plenty for a voice sample. */
export function resample(samples, fromRate, toRate) {
  if (fromRate === toRate || !samples.length) return samples;
  const length = Math.max(1, Math.floor((samples.length * toRate) / fromRate));
  const out = new Float32Array(length);
  const ratio = (samples.length - 1) / Math.max(1, length - 1);
  for (let i = 0; i < length; i += 1) {
    const pos = i * ratio;
    const lo = Math.floor(pos);
    const hi = Math.min(samples.length - 1, lo + 1);
    out[i] = samples[lo] + (samples[hi] - samples[lo]) * (pos - lo);
  }
  return out;
}

/** Index of the first sample louder than `threshold`, backed off a little so no breath is clipped. */
export function firstSpeech(samples, rate, threshold = 0.02) {
  for (let i = 0; i < samples.length; i += 1) {
    if (Math.abs(samples[i]) > threshold) return Math.max(0, i - Math.floor(rate * 0.15));
  }
  return -1;
}

/** 16-bit little-endian mono PCM in a WAV container. */
export function encodeWav(samples, rate) {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const text = (offset, s) => { for (let i = 0; i < s.length; i += 1) view.setUint8(offset + i, s.charCodeAt(i)); };
  text(0, 'RIFF'); view.setUint32(4, 36 + samples.length * 2, true); text(8, 'WAVE');
  text(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  text(36, 'data'); view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i += 1) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return bytes;
}

/**
 * Decoded channels -> the clip to upload. Throws a message fit to show the user when the audio is
 * silent or too short to clone from.
 */
export function prepareClip(channels, sampleRate) {
  const mono = resample(mixToMono(channels), sampleRate, CLIP_RATE);
  const start = firstSpeech(mono, CLIP_RATE);
  if (start < 0) throw new Error('That clip is silent. Choose one where you are speaking.');
  const clip = mono.subarray(start, start + CLIP_MAX_SECONDS * CLIP_RATE);
  const seconds = clip.length / CLIP_RATE;
  if (seconds < CLIP_MIN_SECONDS) throw new Error(`That clip is only ${seconds.toFixed(1)} seconds of speech. Use at least 3 seconds; 10 to 30 is best.`);
  return { wav: encodeWav(clip, CLIP_RATE), seconds, rate: CLIP_RATE };
}

export function bytesToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** Browser only: read the picked file, decode it, return { base64, seconds, trimmed }. */
export async function fileToWavBase64(file, AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext) {
  if (!AudioContextClass) throw new Error('This browser cannot read audio clips.');
  if (file.size > CLIP_MAX_PICK_BYTES) throw new Error('That file is too large. Choose a shorter clip.');
  const buffer = await file.arrayBuffer();
  const ctx = new AudioContextClass();
  let decoded;
  try {
    decoded = await ctx.decodeAudioData(buffer.slice(0));
  } catch {
    throw new Error("Your phone could not read that file. Try an MP3, M4A or WAV recording of your voice.");
  } finally {
    ctx.close?.();
  }
  const channels = Array.from({ length: decoded.numberOfChannels }, (_, i) => decoded.getChannelData(i));
  const { wav, seconds } = prepareClip(channels, decoded.sampleRate);
  return { base64: bytesToBase64(wav), seconds, trimmed: decoded.duration - seconds > 0.5 };
}
