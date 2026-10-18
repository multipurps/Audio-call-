// Platform keys the owner can set in admin. A key saved in app_secrets wins; without one,
// the environment variable is used, so nothing breaks while a key is still only in Render or Vercel.
// Keys are never returned in full: admin sees whether one is set, where it comes from, and its last 4 characters.

export const MANAGED_KEYS = { ELEVENLABS_API_KEY: { env: 'ELEVENLABS_API_KEY', label: 'ElevenLabs API key' } };

export async function getSecret(supabase, name, env = process.env) {
  try {
    const { data } = await supabase.from('app_secrets').select('value').eq('name', name).maybeSingle();
    if (data?.value) return String(data.value).trim();
  } catch { /* fall through to the environment */ }
  return (env[MANAGED_KEYS[name]?.env || name] || '').trim() || null;
}

export function validKeyValue(value) {
  if (typeof value !== 'string') return 'Paste the key';
  const v = value.trim();
  if (v.length < 16 || v.length > 300) return 'That does not look like a key';
  if (/\s/.test(v)) return 'The key cannot contain spaces';
  return null;
}

export async function keysStatus(req, res, supabase, env = process.env) {
  const out = {};
  for (const name of Object.keys(MANAGED_KEYS)) {
    let stored = null;
    try {
      const { data } = await supabase.from('app_secrets').select('value,updated_at').eq('name', name).maybeSingle();
      stored = data || null;
    } catch { stored = null; }
    const fromEnv = (env[MANAGED_KEYS[name].env] || '').trim();
    const value = stored?.value ? String(stored.value).trim() : fromEnv;
    out[name] = {
      label: MANAGED_KEYS[name].label,
      set: !!value,
      source: stored?.value ? 'admin' : fromEnv ? 'environment' : 'none',
      last4: value ? value.slice(-4) : null,
      updatedAt: stored?.updated_at || null,
    };
  }
  return res.status(200).json({ keys: out });
}

export async function keysSave(req, res, supabase, userId) {
  const name = req.body?.name;
  if (!MANAGED_KEYS[name]) return res.status(400).json({ error: 'Unknown key' });
  const value = req.body?.value;
  const problem = validKeyValue(value);
  if (problem) return res.status(400).json({ error: problem });
  const { error } = await supabase
    .from('app_secrets')
    .upsert({ name, value: value.trim(), updated_at: new Date().toISOString() }, { onConflict: 'name' });
  if (error) return res.status(500).json({ error: 'Could not save the key' });
  return res.status(200).json({ saved: true, name, last4: value.trim().slice(-4) });
}
