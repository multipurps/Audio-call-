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
  const groqKey = env.GROQ_API_KEY || '';
  const requestedProvider = (env.LLM_PROVIDER || 'luna').toLowerCase();

  if ((requestedProvider === 'luna' || requestedProvider === 'openai') && lunaKey) {
    return {
      provider: 'openai',
      model: env.LLM_MODEL || env.LUNA_MODEL || 'gpt-6-luna',
      apiKey: lunaKey,
      baseUrl: env.LLM_BASE_URL || env.LUNA_BASE_URL || 'https://api.openai.com/v1',
      temperature: 0.65,
      maxTokens: 160,
    };
  }
  return {
    provider: 'groq',
    model: env.GROQ_LLM_MODEL || 'qwen/qwen3.8-27b',
    apiKey: groqKey,
    temperature: 0.65,
    maxTokens: 160,
  };
}
