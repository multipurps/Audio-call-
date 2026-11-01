// Per-user keys for the video call (Anam, Xmax) and the chosen Anam avatar. Like the live-call
// app: each person saves their own key. Keys are encrypted in Vault (sql/046); the browser only
// ever learns "saved" or "not set". Nothing here reads the admin key store.
export const USER_KEY_PROVIDERS = ['anam', 'xmax'];
const TABLE = 'user_video_settings';
const COLUMN = (p) => `${p}_api_key_secret_id`;
const AVATAR_ID_RE = /^[0-9a-f-]{36}$/i;

export function validKeyValue(value) {
  if (typeof value !== 'string') return 'Paste the key';
  const v = value.trim();
  if (v.length < 16 || v.length > 300) return 'That does not look like a key';
  if (/\s/.test(v)) return 'The key cannot contain spaces';
  return null;
}

export async function getUserKey(supabase, userId, provider) {
  const { data, error } = await supabase.from(TABLE).select(COLUMN(provider)).eq('user_id', userId).maybeSingle();
  if (error || !data) return null;
  const secretId = data[COLUMN(provider)];
  if (!secretId) return null;
  const { data: decrypted, error: decErr } = await supabase.rpc('vault_decrypt_secret', { p_id: secretId });
  if (decErr) return null;
  return decrypted || null;
}

export async function saveUserKey(supabase, userId, provider, plaintext) {
  const { data: existing } = await supabase.from(TABLE).select(COLUMN(provider)).eq('user_id', userId).maybeSingle();
  let secretId = existing?.[COLUMN(provider)];
  if (secretId) {
    const { error } = await supabase.rpc('vault_update_secret', { p_id: secretId, p_secret: plaintext });
    if (error) return { error };
  } else {
    const { data: newId, error } = await supabase.rpc('vault_create_secret', { secret: plaintext, name: `${provider}_key_${userId}` });
    if (error) return { error };
    secretId = newId;
  }
  const { error } = await supabase.from(TABLE).upsert(
    { user_id: userId, [COLUMN(provider)]: secretId, updated_at: new Date().toISOString() },
    { onConflict: 'user_id' },
  );
  return { error };
}

export async function getAnamAvatar(supabase, userId) {
  const { data } = await supabase.from(TABLE).select('anam_avatar_id, anam_avatar_name').eq('user_id', userId).maybeSingle();
  return data?.anam_avatar_id ? { id: data.anam_avatar_id, name: data.anam_avatar_name || '' } : null;
}

// GET /api/assistant?action=keys  -> { anam, xmax, avatarId, avatarName }
// POST /api/assistant?action=keys body { provider, key } -> saves the key
export async function userKeysRoute(req, res, supabase, userId) {
  if (req.method === 'GET') {
    const { data } = await supabase.from(TABLE).select('anam_api_key_secret_id, xmax_api_key_secret_id, anam_avatar_id, anam_avatar_name').eq('user_id', userId).maybeSingle();
    return res.status(200).json({
      anam: !!data?.anam_api_key_secret_id,
      xmax: !!data?.xmax_api_key_secret_id,
      avatarId: data?.anam_avatar_id || null,
      avatarName: data?.anam_avatar_name || null,
    });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'GET or POST only' });
  const { provider, key } = req.body || {};
  if (!USER_KEY_PROVIDERS.includes(provider)) return res.status(400).json({ error: 'Unknown provider' });
  const problem = validKeyValue(key);
  if (problem) return res.status(400).json({ error: problem });
  const { error } = await saveUserKey(supabase, userId, provider, key.trim());
  if (error) {
    console.error(`[keys] save ${provider} user=${userId} ${error.message || error}`);
    return res.status(500).json({ error: 'Could not save the key. Try again.' });
  }
  return res.status(200).json({ ok: true });
}

// GET /api/assistant?action=anam-avatars -> { avatars: [{ id, name }] } from the user's own Anam account
export async function anamAvatarsRoute(req, res, supabase, userId, { fetchImpl = fetch } = {}) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
  const apiKey = await getUserKey(supabase, userId, 'anam');
  if (!apiKey) return res.status(400).json({ error: 'Save your Anam API key first.' });
  try {
    const r = await fetchImpl('https://api.anam.ai/v1/avatars', { headers: { Authorization: `Bearer ${apiKey}` } });
    const raw = await r.text();
    let data = null;
    try { data = JSON.parse(raw); } catch { /* not JSON */ }
    if (!r.ok || !data) return res.status(r.ok ? 502 : r.status).json({ error: `Anam returned ${r.status}. Check your Anam key.` });
    const list = Array.isArray(data) ? data : (data.data || data.avatars || []);
    const avatars = list
      .filter((a) => a && a.id)
      .map((a) => ({ id: String(a.id), name: String(a.displayName || a.name || a.id) }));
    return res.status(200).json({ avatars });
  } catch (err) {
    return res.status(500).json({ error: 'Could not reach Anam. Try again.' });
  }
}

// POST /api/assistant?action=anam-avatar body { id, name } -> saves the chosen avatar
export async function anamAvatarSaveRoute(req, res, supabase, userId) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const { id, name } = req.body || {};
  if (typeof id !== 'string' || !AVATAR_ID_RE.test(id)) return res.status(400).json({ error: 'Pick an avatar from the list' });
  const { error } = await supabase.from(TABLE).upsert(
    { user_id: userId, anam_avatar_id: id, anam_avatar_name: String(name || '').slice(0, 80), updated_at: new Date().toISOString() },
    { onConflict: 'user_id' },
  );
  if (error) return res.status(500).json({ error: 'Could not save the avatar. Try again.' });
  return res.status(200).json({ ok: true });
}

