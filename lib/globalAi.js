// Node client for the admin-controlled global AI behavior (sql/041_ai_behavior.sql).
// One published config + approved knowledge, shared by every runtime. This is prompt
// configuration and retrieval, not model training. Never throws: on any failure the
// caller simply gets '' and the hardcoded prompt rules keep working.
import { getServiceClient } from './supabaseAdmin.js';

const TTL_MS = 30_000;
const cache = new Map();

export function clipQuery(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, 600);
}

export async function fetchGlobalAi({ model = 'luna', mode = 'phone', query = '', supabase } = {}) {
  const q = clipQuery(query);
  const key = `${model}|${mode}|${q}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  try {
    const client = supabase || getServiceClient();
    const { data, error } = await client.rpc('ai_global_context', { p_model: model, p_mode: mode, p_query: q });
    if (error) throw new Error(error.message);
    const value = { version: Number(data?.version) || 0, block: String(data?.block || '') };
    if (cache.size > 200) cache.clear();
    cache.set(key, { at: Date.now(), value });
    return value;
  } catch (err) {
    console.error('[global-ai] fetch failed, using built-in rules:', String(err?.message || err).slice(0, 200));
    return { version: 0, block: '' };
  }
}

// Wrapped so the model treats it as house guidance layered under the call's own instructions.
export function globalAiSection(block) {
  const text = String(block || '').trim();
  return text
    ? `House guidance from the Emysa team (applies to every call; the instructions for this call still take priority):\n${text}`
    : '';
}
