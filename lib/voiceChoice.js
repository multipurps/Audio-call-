// Which voice a call speaks in. A Standard voice is GPT-Live. The Custom voice (the user's own
// xAI voice) is handled by the Grok agent on the Pipecat service, so this resolver only reports
// the GPT-Live choice.
import { liveVoiceById } from './liveVoices.js';

export const DEFAULT_LIVE_VOICE = 'gleam';

export async function resolveVoiceChoice(supabase, userId, env = process.env) {
  let prefs = null;
  let lookupError = null;
  try {
    const p = await supabase.from('voice_preferences').select('live_voice_id').eq('user_id', userId).maybeSingle();
    prefs = p?.data || null;
  } catch (err) {
    lookupError = err?.message || String(err);
  }
  const chosen = liveVoiceById(prefs?.live_voice_id);
  if (chosen) return { mode: 'live', provider: 'gpt-live', voiceId: chosen.id, source: 'user', lookupError };
  const envDefault = liveVoiceById(env?.ASSISTANT_LIVE_VOICE) || liveVoiceById(DEFAULT_LIVE_VOICE);
  return { mode: 'live', provider: 'gpt-live', voiceId: envDefault.id, source: 'env-default', lookupError };
}

// GPT-Live reads text literally, so the voice markers must go.
export function stripSpeechMarkers(text) {
  return String(text || '')
    .replace(/\[\[[^\]]*\]\]/g, ' ')
    .replace(/\[[^\]]{1,40}\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Whether the user has the Custom (Grok agent) voice on. A read problem counts as off, so the
// call still uses the Standard voice.
export async function agentIsOn(supabase, userId) {
  try {
    const { data } = await supabase.from('user_agents').select('active').eq('user_id', userId).maybeSingle();
    return !!data?.active;
  } catch {
    return false;
  }
}
