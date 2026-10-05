// GPT-Live built-in voices, copied from OpenAI's "Managing GPT-Live sessions" guide
// (developers.openai.com/api/docs/guides/live-conversations, voice options table).
// The API takes the id as audio.output.voice at session start. Mirrored in
// pipecat-service/app/config.py (LIVE_VOICES); tests/live-voices.test.mjs keeps them identical.
// Do not add a voice that the guide does not list.
export const LIVE_VOICES = [
  { id: 'quartz', name: 'Quartz', language: 'English', accent: 'Australian', gender: 'feminine' },
  { id: 'ripple', name: 'Ripple', language: 'English', accent: 'Australian', gender: 'masculine' },
  { id: 'vesper', name: 'Vesper', language: 'English', accent: 'British', gender: 'masculine' },
  { id: 'willow', name: 'Willow', language: 'English', accent: 'Irish', gender: 'feminine' },
  { id: 'stone', name: 'Stone', language: 'English', accent: 'Irish', gender: 'masculine' },
  { id: 'gleam', name: 'Gleam', language: 'English', accent: 'North American', gender: 'feminine' },
  { id: 'meridian', name: 'Meridian', language: 'English', accent: 'North American', gender: 'masculine' },
  { id: 'bossa', name: 'Bossa', language: 'Portuguese', accent: 'Brazilian', gender: 'feminine' },
  { id: 'tempo', name: 'Tempo', language: 'Portuguese', accent: 'Brazilian', gender: 'masculine' },
  { id: 'beacon', name: 'Beacon', language: 'English', accent: 'Filipino', gender: 'masculine' },
  { id: 'delta', name: 'Delta', language: 'English', accent: 'Southern U.S.', gender: 'feminine' },
  { id: 'cinder', name: 'Cinder', language: 'English', accent: 'Southern U.S.', gender: 'masculine' },
];

export const liveVoiceById = (id) => LIVE_VOICES.find((v) => v.id === String(id || '').trim().toLowerCase()) || null;
