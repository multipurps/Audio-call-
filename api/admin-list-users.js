import { getServiceClient, requireAdmin } from '../lib/supabaseAdmin.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
  const supabase = getServiceClient();
  const admin = await requireAdmin(req, supabase);
  if (!admin) return res.status(403).json({ error: 'Not authorized' });

  const { data: authUsers, error: listErr } = await supabase.auth.admin.listUsers();
  if (listErr) return res.status(500).json({ error: listErr.message });

  // This Supabase project may be shared with other apps — only list users
  // who have actually signed into Audio Call (they get a `profiles` row on
  // first sign-in), so users from another app on the same project don't
  // show up here.
  const { data: profileRows, error: profileErr } = await supabase.from('profiles').select('user_id');
  if (profileErr) return res.status(500).json({ error: profileErr.message });
  const audioCallUserIds = new Set((profileRows || []).map((p) => p.user_id));

  const { data: approvals } = await supabase.from('user_approvals').select('user_id, approved');
  const { data: usage } = await supabase.from('user_usage').select('user_id, call_minutes_used, monthly_minute_limit');

  const approvalMap = new Map((approvals || []).map(a => [a.user_id, a.approved]));
  const usageMap = new Map((usage || []).map(u => [u.user_id, u]));

  const users = authUsers.users
    .filter(u => audioCallUserIds.has(u.id))
    .map(u => ({
      id: u.id,
      email: u.email,
      created_at: u.created_at,
      approved: !!approvalMap.get(u.id),
      minutes_used: usageMap.get(u.id)?.call_minutes_used ?? 0,
      minutes_limit: usageMap.get(u.id)?.monthly_minute_limit ?? 60,
    }));

  return res.status(200).json({ users });
}
