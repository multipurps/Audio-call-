import { getServiceClient, requireAdmin } from '../lib/supabaseAdmin.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
  const supabase = getServiceClient();
  const admin = await requireAdmin(req, supabase);
  if (!admin) return res.status(403).json({ error: 'Not authorized' });

  const { data: authUsers, error: listErr } = await supabase.auth.admin.listUsers();
  if (listErr) return res.status(500).json({ error: listErr.message });
  const emailById = new Map(authUsers.users.map((u) => [u.id, u.email]));

  const { data: calls, error: callsErr } = await supabase
    .from('calls')
    .select('user_id, duration_seconds, created_at');
  if (callsErr) return res.status(500).json({ error: callsErr.message });

  const byUser = new Map();
  for (const c of calls || []) {
    const row = byUser.get(c.user_id) || { calls: 0, seconds: 0, lastActive: null };
    row.calls += 1;
    row.seconds += c.duration_seconds || 0;
    if (!row.lastActive || c.created_at > row.lastActive) row.lastActive = c.created_at;
    byUser.set(c.user_id, row);
  }

  const users = Array.from(byUser.entries())
    .map(([userId, row]) => ({
      email: emailById.get(userId) || userId,
      calls: row.calls,
      minutes: Math.round(row.seconds / 60),
      lastActive: row.lastActive,
    }))
    .sort((a, b) => b.minutes - a.minutes);

  return res.status(200).json({ users });
}
