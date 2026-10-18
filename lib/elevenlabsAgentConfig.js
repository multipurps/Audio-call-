// The Emysa agent's settings on ElevenLabs. Audio is 16 kHz PCM both ways, which is
// the bridge's rate, so the call path needs no conversion.

export const AGENT_LLM = 'gemini-2.5-flash';
export const AGENT_TTS_MODEL = 'eleven_flash_v2_5';
// A public ElevenLabs voice, used until the user creates their own.
export const DEFAULT_AGENT_VOICE_ID = '21m00Tcm4TlvDq8ikWAM';
export const AGENT_PROMPT =
  'You are Emysa, a friendly voice assistant on a phone call. Speak naturally and briefly, ' +
  'one or two sentences at a time. Ask one question when you need to. Never read out lists, ' +
  'links or formatting.';

export const CLONE_MAX_FILES = 25;
export const CLONE_MAX_FILE_BYTES = 10 * 1024 * 1024;
export const CLONE_MAX_TOTAL_BYTES = 3.5 * 1024 * 1024; // the request body limit, with headroom
export const CLONE_NAME_MAX = 60;

export function buildAgentConfig({ voiceId } = {}) {
  return {
    agent: {
      language: 'en',
      prompt: {
        prompt: AGENT_PROMPT,
        llm: AGENT_LLM,
        tools: [{ type: 'system', name: 'end_call', description: '' }],
      },
    },
    asr: { provider: 'elevenlabs', user_input_audio_format: 'pcm_16000' },
    tts: {
      voice_id: voiceId || DEFAULT_AGENT_VOICE_ID,
      model_id: AGENT_TTS_MODEL,
      agent_output_audio_format: 'pcm_16000',
    },
  };
}

// Returns an error message, or null when the clone request is acceptable.
export function validateCloneInput(body) {
  if (!body || typeof body !== 'object') return 'Send the voice name and samples';
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) return 'Give the voice a name';
  if (name.length > CLONE_NAME_MAX) return `Keep the name under ${CLONE_NAME_MAX} characters`;
  if (body.consent !== true) return 'Confirm you have the right to use this voice';
  const files = Array.isArray(body.files) ? body.files : [];
  if (files.length < 1) return 'Add at least one audio sample';
  if (files.length > CLONE_MAX_FILES) return `Use at most ${CLONE_MAX_FILES} samples`;
  let total = 0;
  for (const f of files) {
    if (!f || typeof f.data !== 'string' || !f.data) return 'Each sample needs its audio';
    if (typeof f.type !== 'string' || !f.type.startsWith('audio/')) return 'Samples must be audio files';
    const bytes = Math.floor((f.data.length * 3) / 4);
    if (bytes > CLONE_MAX_FILE_BYTES) return 'Each sample must be under 10 MB';
    total += bytes;
  }
  if (total > CLONE_MAX_TOTAL_BYTES) return 'The samples are too large together; use fewer or shorter clips';
  return null;
}
