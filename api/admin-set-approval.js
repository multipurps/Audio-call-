import { getServiceClient, requireAdmin } from '../lib/supabaseAdmin.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const supabase = getServiceClient();
  const admin = await requireAdmin(req, supabase);
  if (!admin) return res.status(403).json({ error: 'Not authorized' });

  const { targetUserId, approved, monthlyMinuteLimit } = req.body || {};
  if (!targetUserId) return res.status(400).json({ error: 'targetUserId required' });

  if (typeof approved === 'boolean') {
    const { error } = await supabase
      .from('user_approvals')
      .upsert({ user_id: targetUserId, approved });
    if (error) return res.status(500).json({ error: error.message });
  }

  if (typeof monthlyMinuteLimit === 'number') {
    const { error } = await supabase
      .from('user_usage')
      .upsert({ user_id: targetUserId, monthly_minute_limit: monthlyMinuteLimit, updated_at: new Date().toISOString() });
    if (error) return res.status(500).json({ error: error.message });
  }

  return res.status(200).json({ ok: true });
}
