import { randomUUID } from 'crypto';
import { getServiceClient, requireAdmin } from '../lib/supabaseAdmin.js';

// Gallery of welcome/login/signup background images — the client fetches all
// rows and auto-rotates through them. Delete removes both the DB row and the
// stored file.
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const supabase = getServiceClient();
  const admin = await requireAdmin(req, supabase);
  if (!admin) return res.status(403).json({ error: 'Not authorized' });

  const { action } = req.body || {};

  if (action === 'delete') {
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ error: 'id required' });
    const { data: row, error: fetchErr } = await supabase.from('auth_backgrounds').select('storage_path').eq('id', id).maybeSingle();
    if (fetchErr) return res.status(500).json({ error: fetchErr.message });
    if (!row) return res.status(404).json({ error: 'Not found' });
    await supabase.storage.from('app-assets').remove([row.storage_path]);
    const { error: delErr } = await supabase.from('auth_backgrounds').delete().eq('id', id);
    if (delErr) return res.status(500).json({ error: delErr.message });
    return res.status(200).json({ ok: true });
  }

  const { imageBase64, mimeType } = req.body || {};
  if (!imageBase64) return res.status(400).json({ error: 'imageBase64 required' });
  const ext = (mimeType || 'image/jpeg').split('/')[1] || 'jpg';
  const path = `auth-backgrounds/${randomUUID()}.${ext}`;
  const bytes = Buffer.from(imageBase64, 'base64');
  if (bytes.length > 8 * 1024 * 1024) return res.status(400).json({ error: 'Image too large (max 8MB)' });

  const { error: uploadErr } = await supabase.storage
    .from('app-assets')
    .upload(path, bytes, { contentType: mimeType || 'image/jpeg', upsert: false });
  if (uploadErr) return res.status(500).json({ error: uploadErr.message });

  const { data: pub } = supabase.storage.from('app-assets').getPublicUrl(path);
  const { data: row, error: insertErr } = await supabase
    .from('auth_backgrounds')
    .insert({ url: pub.publicUrl, storage_path: path })
    .select()
    .single();
  if (insertErr) return res.status(500).json({ error: insertErr.message });

  return res.status(200).json({ ok: true, row });
}
