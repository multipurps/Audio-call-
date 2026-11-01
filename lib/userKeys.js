// API keys live ONLY on the server, in the environment (Vercel / Render): ANAM_API_KEY and
// XMAX_API_KEY. They are never saved in the database, shown in admin, or shown in the app.
// The only per-person data here is which Anam avatar the person picked (an id, not a secret).

const TABLE = 'user_video_settings';
const AVATAR_ID_RE = /^[0-9a-f-]{36}$/i;
const SERVER_KEY_ENV = { anam: 'ANAM_API_KEY', xmax: 'XMAX_API_KEY' };

export function serverKey(provider, env = process.env) {
  const name = SERVER_KEY_ENV[provider];
  return name ? ((env[name] || '').trim() || null) : null;
}

export async function getAnamAvatar(supabase, userId) {
  const { data } = await supabase.from(TABLE).select('anam_avatar_id, anam_avatar_name').eq('user_id', userId).maybeSingle();
  return data?.anam_avatar_id ? { id: data.anam_avatar_id, name: data.anam_avatar_name || '' } : null;
}

// GET /api/assistant?action=anam-avatars -> { avatars: [{ id, name }] } from the Anam account of ANAM_API_KEY
export async function anamAvatarsRoute(req, res, supabase, userId, { fetchImpl = fetch, env = process.env } = {}) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
  const apiKey = serverKey('anam', env);
  if (!apiKey) return res.status(500).json({ error: 'ANAM_API_KEY is not set on the server.' });
  try {
    const r = await fetchImpl('https://api.anam.ai/v1/avatars', { headers: { Authorization: `Bearer ${apiKey}` } });
    const raw = await r.text();
    let data = null;
    try { data = JSON.parse(raw); } catch { /* not JSON */ }
    if (!r.ok || !data) return res.status(r.ok ? 502 : r.status).json({ error: `Anam returned ${r.status}. Check ANAM_API_KEY on the server.` });
    const list = Array.isArray(data) ? data : (data.data || data.avatars || []);
    const avatars = list
      .filter((a) => a && a.id)
      .map((a) => ({ id: String(a.id), name: String(a.displayName || a.name || a.id) }));
    return res.status(200).json({ avatars });
  } catch (err) {
    console.error(`[anam-avatars] user=${userId} ${err.message}`);
    return res.status(500).json({ error: 'Could not reach Anam. Try again.' });
  }
}

// GET  /api/assistant?action=anam-avatar -> { id, name } the person picked, or null
// POST /api/assistant?action=anam-avatar body { id, name } -> saves the picked avatar
export async function anamAvatarSaveRoute(req, res, supabase, userId) {
  if (req.method === 'GET') {
    const avatar = await getAnamAvatar(supabase, userId);
    return res.status(200).json({ avatar });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'GET or POST only' });
  const { id, name } = req.body || {};
  if (typeof id !== 'string' || !AVATAR_ID_RE.test(id)) return res.status(400).json({ error: 'Pick an avatar from the list' });
  const { error } = await supabase.from(TABLE).upsert(
    { user_id: userId, anam_avatar_id: id, anam_avatar_name: String(name || '').slice(0, 80), updated_at: new Date().toISOString() },
    { onConflict: 'user_id' },
  );
  if (error) return res.status(500).json({ error: 'Could not save the avatar. Try again.' });
  return res.status(200).json({ ok: true });
}
