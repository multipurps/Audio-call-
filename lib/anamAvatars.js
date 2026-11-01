// Each person's own Anam avatar. The picture in Settings > Avatar ("Video call avatar") is sent to
// Anam and the avatar is named after the person's name in Profile. A person can only use avatars
// recorded for them in user_anam_avatars. Removing the picture deletes that avatar at Anam.
import { serverKey } from './serverKeys.js';

const ANAM_AVATARS = 'https://api.anam.ai/v1/avatars';
const MAX_IMAGE_BYTES = 4.5 * 1024 * 1024;
const IMAGE_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const UUID_RE = /^[0-9a-f-]{36}$/i;

// Anam wants 3 to 50 characters.
export function avatarDisplayName(name) {
  const clean = String(name || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 50);
  return clean.length >= 3 ? clean : null;
}

async function ownedAvatar(supabase, userId, id) {
  const { data } = await supabase.from('user_anam_avatars')
    .select('anam_avatar_id, display_name, source').eq('user_id', userId).eq('anam_avatar_id', id).maybeSingle();
  return data || null;
}

async function ownedRows(supabase, userId) {
  const { data } = await supabase.from('user_anam_avatars')
    .select('anam_avatar_id, display_name, source').eq('user_id', userId).order('created_at');
  return data || [];
}

// The avatar a video call uses: only the person's pick, and only if it is recorded for them.
export async function getAnamAvatar(supabase, userId) {
  const { data: sel } = await supabase.from('user_video_settings')
    .select('anam_avatar_id').eq('user_id', userId).maybeSingle();
  if (!sel?.anam_avatar_id) return null;
  const owned = await ownedAvatar(supabase, userId, sel.anam_avatar_id);
  return owned ? { id: owned.anam_avatar_id, name: owned.display_name } : null;
}

async function deleteAtAnam(fetchImpl, apiKey, id) {
  const r = await fetchImpl(`${ANAM_AVATARS}/${id}?hard=true`, {
    method: 'DELETE', headers: { Authorization: `Bearer ${apiKey}` },
  });
  // 404 means it is already gone at Anam, which is the state we want.
  if (!r.ok && r.status !== 404) throw Object.assign(new Error(`Anam returned ${r.status} when deleting the avatar.`), { status: 502 });
}

// Deletes this person's uploaded avatars (source 'upload') at Anam and in our table, except `keepId`.
// Avatars linked from the Anam dashboard (source 'linked') are never touched.
async function removeUploadedAvatars(supabase, userId, fetchImpl, apiKey, keepId = null) {
  const rows = (await ownedRows(supabase, userId)).filter((r) => r.source === 'upload' && r.anam_avatar_id !== keepId);
  if (!rows.length) return;
  if (!apiKey) throw Object.assign(new Error('ANAM_API_KEY is not set on the server.'), { status: 500 });
  for (const row of rows) {
    await deleteAtAnam(fetchImpl, apiKey, row.anam_avatar_id);
    await supabase.from('user_anam_avatars').delete().eq('user_id', userId).eq('anam_avatar_id', row.anam_avatar_id);
  }
  const { data: sel } = await supabase.from('user_video_settings').select('anam_avatar_id').eq('user_id', userId).maybeSingle();
  if (sel && rows.some((r) => r.anam_avatar_id === sel.anam_avatar_id)) {
    await supabase.from('user_video_settings')
      .update({ anam_avatar_id: null, anam_avatar_name: null, updated_at: new Date().toISOString() }).eq('user_id', userId);
  }
}

// GET ?action=anam-avatars -> { avatars: [{ id, name }], selectedId }  (this person's avatars only)
export async function anamAvatarsRoute(req, res, supabase, userId) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
  const rows = await ownedRows(supabase, userId);
  const { data: sel } = await supabase.from('user_video_settings').select('anam_avatar_id').eq('user_id', userId).maybeSingle();
  return res.status(200).json({
    avatars: rows.map((r) => ({ id: r.anam_avatar_id, name: r.display_name })),
    selectedId: sel?.anam_avatar_id || null,
  });
}

// POST ?action=anam-avatar body { id } -> picks one of this person's own avatars
export async function anamAvatarSelectRoute(req, res, supabase, userId) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const id = req.body?.id;
  if (typeof id !== 'string' || !UUID_RE.test(id)) return res.status(400).json({ error: 'Pick an avatar from the list' });
  const owned = await ownedAvatar(supabase, userId, id);
  if (!owned) return res.status(404).json({ error: 'That avatar is not yours' });
  const { error } = await supabase.from('user_video_settings').upsert({
    user_id: userId, anam_avatar_id: id, anam_avatar_name: owned.display_name, updated_at: new Date().toISOString(),
  }, { onConflict: 'user_id' });
  if (error) return res.status(500).json({ error: 'Could not save the avatar. Try again.' });
  return res.status(200).json({ ok: true, selectedId: id });
}

// POST ?action=anam-avatar-create -> creates this person's Anam avatar from their Video call avatar
// picture, named after their Profile name. Replaces their previous uploaded avatar.
export async function anamAvatarCreateRoute(req, res, supabase, userId, { fetchImpl = fetch, env = process.env } = {}) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const apiKey = serverKey('anam', env);
  if (!apiKey) return res.status(500).json({ error: 'ANAM_API_KEY is not set on the server.' });

  const { data: profile, error: pErr } = await supabase.from('profiles')
    .select('name, video_avatar_url').eq('user_id', userId).maybeSingle();
  if (pErr) return res.status(500).json({ error: 'Could not read your profile. Try again.' });
  const displayName = avatarDisplayName(profile?.name);
  if (!displayName) return res.status(400).json({ error: 'Add your name in Profile first (at least 3 letters). Your avatar is named after it.' });

  const url = profile?.video_avatar_url || '';
  const base = env.SUPABASE_URL || '';
  if (!url || !url.includes(`/avatars/${userId}/video-avatar.`) || (base && !url.startsWith(base))) {
    return res.status(400).json({ error: 'Upload your video call avatar picture first.' });
  }

  let img;
  try {
    const r = await fetchImpl(url);
    if (!r.ok) return res.status(502).json({ error: 'Could not read your picture. Upload it again.' });
    const type = (r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!IMAGE_TYPES[type]) return res.status(400).json({ error: 'Anam accepts JPG, PNG or WebP pictures. Upload one of those.' });
    const buf = await r.arrayBuffer();
    if (buf.byteLength > MAX_IMAGE_BYTES) return res.status(400).json({ error: 'Anam accepts pictures up to 4.5 MB. Upload a smaller picture.' });
    img = { buf, type, ext: IMAGE_TYPES[type] };
  } catch (err) {
    console.error(`[anam-avatar-create] image user=${userId} ${err.message}`);
    return res.status(502).json({ error: 'Could not read your picture. Upload it again.' });
  }

  const form = new FormData();
  form.append('displayName', displayName);
  form.append('imageFile', new Blob([img.buf], { type: img.type }), `avatar.${img.ext}`);
  form.append('imageProcessing', 'auto');

  let created;
  try {
    const r = await fetchImpl(ANAM_AVATARS, { method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: form });
    const raw = await r.text();
    let data = null;
    try { data = JSON.parse(raw); } catch { /* not JSON */ }
    if (!r.ok || !data?.id) {
      const msg = (data && (data.message || data.error)) || raw.slice(0, 160) || 'no body';
      return res.status(r.ok ? 502 : r.status).json({ error: `Anam did not create the avatar (${r.status}): ${msg}` });
    }
    created = data;
  } catch (err) {
    console.error(`[anam-avatar-create] anam user=${userId} ${err.message}`);
    return res.status(502).json({ error: 'Could not reach Anam. Try again.' });
  }

  const { error: insErr } = await supabase.from('user_anam_avatars').insert({
    user_id: userId, anam_avatar_id: created.id, display_name: displayName, source: 'upload',
  });
  if (insErr) {
    await deleteAtAnam(fetchImpl, apiKey, created.id).catch(() => {});
    return res.status(500).json({ error: 'Could not save your avatar. Try again.' });
  }
  try {
    await removeUploadedAvatars(supabase, userId, fetchImpl, apiKey, created.id);
  } catch (err) {
    console.error(`[anam-avatar-create] cleanup user=${userId} ${err.message}`);
  }
  const { error: setErr } = await supabase.from('user_video_settings').upsert({
    user_id: userId, anam_avatar_id: created.id, anam_avatar_name: displayName, updated_at: new Date().toISOString(),
  }, { onConflict: 'user_id' });
  if (setErr) return res.status(500).json({ error: 'Created your avatar but could not select it. Try again.' });
  return res.status(201).json({ avatar: { id: created.id, name: displayName } });
}

// POST ?action=anam-avatar-delete -> the picture was removed: delete this person's uploaded avatar at Anam
export async function anamAvatarDeleteRoute(req, res, supabase, userId, { fetchImpl = fetch, env = process.env } = {}) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  try {
    await removeUploadedAvatars(supabase, userId, fetchImpl, serverKey('anam', env));
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error(`[anam-avatar-delete] user=${userId} ${err.message}`);
    return res.status(err.status || 502).json({ error: 'Could not delete your avatar at Anam. Your picture was kept. Try again.' });
  }
}
