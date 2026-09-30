// Pure audio & per-call session utilities for the Twilio Media Streams relays.
// Kept free of external runtime dependencies so unit tests and serverless checks
// can import and verify WAV framing and per-call voice isolation directly.

const MULAW_DECODE_TABLE = new Int16Array(256);
for (let i = 0; i < 256; i++) {
  const mu = ~i & 0xff;
  const sign = mu & 0x80;
  const exponent = (mu >> 4) & 0x07;
  const mantissa = mu & 0x0f;
  let sample = ((mantissa << 3) + 0x84) << exponent;
  sample -= 0x84;
  MULAW_DECODE_TABLE[i] = sign ? -sample : sample;
}

export function decodeMulawSample(mulawByte) {
  return MULAW_DECODE_TABLE[mulawByte & 0xff];
}

export function mulawToWav(mulawBuf, sampleRate = 8000) {
  const numSamples = mulawBuf.length;
  const pcmByteLength = numSamples * 2;
  const wav = Buffer.alloc(44 + pcmByteLength);

  // RIFF chunk descriptor
  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(36 + pcmByteLength, 4);
  wav.write('WAVE', 8, 'ascii');

  // fmt sub-chunk (16-bit mono linear PCM)
  wav.write('fmt ', 12, 'ascii');
  wav.writeUInt32LE(16, 16); // Subchunk1Size (16 for PCM)
  wav.writeUInt16LE(1, 20); // AudioFormat (1 = PCM)
  wav.writeUInt16LE(1, 22); // NumChannels (1 = mono)
  wav.writeUInt32LE(sampleRate, 24); // SampleRate (8000 Hz)
  wav.writeUInt32LE(sampleRate * 2, 28); // ByteRate (SampleRate * NumChannels * BitsPerSample/8)
  wav.writeUInt16LE(2, 32); // BlockAlign (NumChannels * BitsPerSample/8)
  wav.writeUInt16LE(16, 34); // BitsPerSample (16 bits)

  // data sub-chunk
  wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(pcmByteLength, 40);

  for (let i = 0; i < numSamples; i++) {
    wav.writeInt16LE(MULAW_DECODE_TABLE[mulawBuf[i]], 44 + i * 2);
  }
  return wav;
}

const callVoices = new Map();

export function setVoiceForCall(callId, voiceId) {
  if (!callId) return;
  if (voiceId) callVoices.set(String(callId), String(voiceId));
  else callVoices.delete(String(callId));
}

export function clearCall(callId) {
  if (!callId) return;
  callVoices.delete(String(callId));
}

export function resolveVoiceId(ctx, defaultVoice) {
  if (ctx?.voiceId) return ctx.voiceId;
  if (ctx?.callId && callVoices.has(String(ctx.callId))) {
    return callVoices.get(String(ctx.callId));
  }
  return defaultVoice;
}

export function resolvePatterLlmConfig(env = process.env) {
  const lunaKey = env.LUNA_API_KEY || env.LLM_API_KEY || env.OPENAI_API_KEY || '';
  const requestedProvider = (env.LLM_PROVIDER || 'luna').toLowerCase();

  // Groq support was removed (the model this relay used there was
  // decommissioned). Every config resolves to OpenAI's Chat Completions API;
  // without a key there is nothing valid to build, so we say so loudly
  // instead of silently routing a live call to a dead provider.
  if (requestedProvider === 'fal' || requestedProvider === 'openrouter') {
    const falKey = env.FAL_KEY || '';
    if (falKey) {
      return {
        provider: 'openai',
        model: env.LLM_MODEL || 'openai/gpt-4o-mini',
        apiKey: falKey,
        baseUrl: 'https://fal.run/openrouter/router/openai/v1',
        temperature: 0.65,
        maxTokens: 160,
      };
    }
  }
  if (!lunaKey) {
    throw new Error('No LLM API key configured: set LUNA_API_KEY (or OPENAI_API_KEY). Groq was removed.');
  }
  return {
    provider: 'openai',
    model: env.LLM_MODEL || env.LUNA_MODEL || 'gpt-6-luna',
    apiKey: lunaKey,
    baseUrl: env.LLM_BASE_URL || env.LUNA_BASE_URL || 'https://api.openai.com/v1',
    temperature: 0.65,
    maxTokens: 160,
  };
}

/**
 * Speech-vs-steady-noise gate for telephony audio.
 *
 * Twilio (and any raw media stream) keeps delivering frames while nobody is
 * talking. Feeding room tone — a fan, an air conditioner, a generator — into
 * Whisper produces confident nonsense ("the other person said something"),
 * which then drives a bogus LLM turn. This decides whether a PCM16 chunk is
 * worth an STT call:
 *
 *   1. Enough absolute energy (not digital silence).
 *   2. Amplitude modulates like syllables do: speech frame-RMS varies a lot
 *      (coefficient of variation >= 0.25), while a steady hum barely varies.
 *   3. Not dominated by very high zero-crossing rates (pure hiss/static).
 *   4. Enough voiced duration (>= ~150 ms of active frames) to be a word.
 *
 * Heuristic by design — it runs on every 700 ms telephony chunk before any
 * paid API call. It reduces, but cannot fully guarantee removal of, all
 * non-speech; the WhatsApp/Telegram pipelines additionally sit behind
 * Silero VAD, which is the stronger defence there.
 */
export function isSpeechLikePcm16(pcmBuf, sampleRate = 8000, options = {}) {
  const { minRms = 250, minFrameRms = 350, minVariation = 0.25, minActiveMs = 150 } = options;
  const samples = Math.floor((pcmBuf?.length || 0) / 2);
  if (samples < sampleRate * 0.05) return false; // shorter than 50 ms

  const frameSamples = Math.max(1, Math.floor(sampleRate * 0.02)); // 20 ms
  const frameRms = [];
  let sumSq = 0;
  let zeroCrossings = 0;
  let prev = 0;
  for (let i = 0; i < samples; i++) {
    const v = pcmBuf.readInt16LE(i * 2);
    sumSq += v * v;
    if ((v >= 0) !== (prev >= 0)) zeroCrossings++;
    prev = v;
    if ((i + 1) % frameSamples === 0) {
      const start = i + 1 - frameSamples;
      let frameSum = 0;
      for (let j = start; j <= i; j++) {
        const s = pcmBuf.readInt16LE(j * 2);
        frameSum += s * s;
      }
      frameRms.push(Math.sqrt(frameSum / frameSamples));
    }
  }
  const overallRms = Math.sqrt(sumSq / samples);
  if (overallRms < minRms) return false; // silence

  const active = frameRms.filter((r) => r >= minFrameRms);
  if (active.length * 20 < minActiveMs) return false; // not enough voiced audio

  const mean = active.reduce((a, b) => a + b, 0) / active.length;
  const variance = active.reduce((a, b) => a + (b - mean) ** 2, 0) / active.length;
  const variation = mean > 0 ? Math.sqrt(variance) / mean : 0;
  if (variation < minVariation) return false; // steady noise: no syllabic modulation

  const zcrRate = zeroCrossings / samples;
  if (zcrRate > 0.3) return false; // pure hiss/static

  return true;
}
