// One rule for "which voice does this user's call speak in", shared by the in-app
// Emysa call and the WhatsApp attach. It mirrors the Pipecat service
// (_resolve_call_voice_and_engine): a ready cloned voice is used unless the user
// picked a Standard (GPT-Live) voice; everyone else gets their saved GPT-Live voice.
// Nothing here ever falls back to a default Fish voice.
import { liveVoiceById } from './liveVoices.js';

export const DEFAULT_LIVE_VOICE = 'gleam';

export async function resolveVoiceChoice(supabase, userId, env = process.env) {
  let prefs = null;
  let clone = null;
  let lookupError = null;
  try {
    const [p, c] = await Promise.all([
      supabase.from('voice_preferences').select('live_voice_id, use_custom_voice').eq('user_id', userId).maybeSingle(),
      supabase.from('voice_profiles').select('status, provider_voice_id').eq('user_id', userId).maybeSingle(),
    ]);
    prefs = p?.data || null;
    clone = c?.data || null;
  } catch (err) {
    lookupError = err?.message || String(err);
  }
  const cloneId = clone?.status === 'ready' && clone.provider_voice_id ? clone.provider_voice_id : null;
  const wantsCustom = prefs?.use_custom_voice !== false;
  if (cloneId && wantsCustom) {
    return { mode: 'custom', provider: 'fish', voiceId: cloneId, source: 'user-clone', lookupError };
  }
  const chosen = liveVoiceById(prefs?.live_voice_id);
  if (chosen) return { mode: 'live', provider: 'gpt-live', voiceId: chosen.id, source: 'user', lookupError };
  const envDefault = liveVoiceById(env?.ASSISTANT_LIVE_VOICE) || liveVoiceById(DEFAULT_LIVE_VOICE);
  return { mode: 'live', provider: 'gpt-live', voiceId: envDefault.id, source: 'env-default', lookupError };
}

// GPT-Live reads text literally, so Fish delivery/vocalisation markers must go.
export function stripSpeechMarkers(text) {
  return String(text || '')
    .replace(/\[\[[^\]]*\]\]/g, ' ')
    .replace(/\[[^\]]{1,40}\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
