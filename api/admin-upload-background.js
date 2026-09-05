import { getServiceClient, requireAdmin } from '../lib/supabaseAdmin.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const supabase = getServiceClient();
  const admin = await requireAdmin(req, supabase);
  if (!admin) return res.status(403).json({ error: 'Not authorized' });

  const { imageBase64, mimeType } = req.body || {};
  if (!imageBase64) return res.status(400).json({ error: 'imageBase64 required' });

  const ext = (mimeType || 'image/jpeg').split('/')[1] || 'jpg';
  const path = `login-background.${ext}`;
  const bytes = Buffer.from(imageBase64, 'base64');

  const { error: uploadErr } = await supabase.storage
    .from('app-assets')
    .upload(path, bytes, { contentType: mimeType || 'image/jpeg', upsert: true });
  if (uploadErr) return res.status(500).json({ error: uploadErr.message });

  const { data: pub } = supabase.storage.from('app-assets').getPublicUrl(path);
  const url = `${pub.publicUrl}?v=${Date.now()}`; // cache-bust so a re-upload shows immediately

  const { error: settingErr } = await supabase
    .from('app_settings')
    .upsert({ key: 'auth_background_url', value: url, updated_at: new Date().toISOString() });
  if (settingErr) return res.status(500).json({ error: settingErr.message });

  return res.status(200).json({ ok: true, url });
}
