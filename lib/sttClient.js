// Shared OpenAI speech-to-text client for every transcription path in this
// app: browser voice input (api/assistant.js?action=transcribe), the Twilio
// media-stream relays (server/relay.js, server/patter-relay.js).
//
// Groq Whisper was removed: this app now depends on OpenAI only, on the
// documented Audio Transcriptions endpoint:
//   POST https://api.openai.com/v1/audio/transcriptions
// with models verified against OpenAI's model catalog:
//   * gpt-4o-mini-transcribe — default, ~$0.003/min of audio (cheaper than
//     whisper-1 and a lower word error rate).
//   * whisper-1             — $0.006/min, set STT_MODEL to use it.
//
// All calls are batch-per-utterance (the caller's buffered audio since their
// last pause, wrapped as WAV) — the same shape the previous Groq calls had,
// which is what the relays' VAD/silence detection already produces. This is
// deliberately NOT used as a streaming endpoint.

export const DEFAULT_STT_MODEL = 'gpt-4o-mini-transcribe';
export const FALLBACK_STT_MODEL = 'whisper-1';
export const STT_TRANSCRIPTIONS_URL = 'https://api.openai.com/v1/audio/transcriptions';

//: Guidance sent with every transcription. Whisper-style models accept a
//: prompt that steers style/vocabulary; combined with VAD + the relays'
//: speech-vs-steady-noise gate, it is the transcription-side defence against
//: fans/generators being "transcribed" as speech.
export const STT_PROMPT =
  'Transcribe spoken human speech only. Ignore background noise: fans, generators, humming, hiss, static, music, television. When there is no speech, transcribe nothing.';

/**
 * Pick the server-side OpenAI-compatible key for STT, or null when unset.
 * Never logs or returns the key itself.
 */
export function resolveSttApiKey(env = process.env) {
  return (env.OPENAI_API_KEY || env.LUNA_API_KEY || env.LLM_API_KEY || '').trim() || null;
}

/**
 * POST one audio buffer to OpenAI's transcriptions endpoint.
 *
 * @param {object} opts
 * @param {ArrayBuffer|Uint8Array|Buffer} opts.bytes  raw audio file contents
 * @param {string} opts.filename                      e.g. 'chunk.wav'
 * @param {string} opts.mimeType                      e.g. 'audio/wav'
 * @param {string} [opts.model]
 * @param {string} [opts.prompt]
 * @param {string} [opts.language]                    ISO code, auto-detect when omitted
 * @param {object} [opts.env]
 * @param {typeof fetch} [opts.fetchImpl]
 * @returns {Promise<{ok: boolean, text: string, error?: string, status?: number}>}
 */
export async function transcribeAudioBuffer({
  bytes,
  filename = 'audio.wav',
  mimeType = 'audio/wav',
  model,
  prompt = STT_PROMPT,
  language,
  env = process.env,
  fetchImpl,
}) {
  const fetchFn = fetchImpl || (typeof fetch !== 'undefined' ? fetch : globalThis.fetch);
  const apiKey = resolveSttApiKey(env);
  if (!apiKey) return { ok: false, text: '', error: 'OPENAI_API_KEY is not configured' };
  if (!bytes || !bytes.length) return { ok: false, text: '', error: 'no audio to transcribe' };

  const form = new FormData();
  form.append('model', model || env.STT_MODEL || DEFAULT_STT_MODEL);
  form.append('temperature', '0'); // deterministic; less hallucination on ambiguous audio
  if (prompt) form.append('prompt', prompt);
  if (language) form.append('language', language);
  form.append('file', new Blob([bytes], { type: mimeType }), filename);

  try {
    const resp = await fetchFn(STT_TRANSCRIPTIONS_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => '');
      return { ok: false, text: '', status: resp.status, error: detail.slice(0, 300) || `HTTP ${resp.status}` };
    }
    const data = await resp.json().catch(() => ({}));
    return { ok: true, text: String(data.text || '').trim() };
  } catch (err) {
    return { ok: false, text: '', error: String(err?.message || err).slice(0, 300) };
  }
}
