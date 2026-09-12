import { getServiceClient, getAuthedUserId } from '../lib/supabaseAdmin.js';

export default async function handler(req, res) {
  const supabase = getServiceClient();
  const userId = await getAuthedUserId(req, supabase);
  if (!userId) return res.status(401).json({ error: 'Not signed in' });

  if (req.method === 'GET') {
    const { data, error } = await supabase
      .from('profiles')
      .select('auto_retry, record_calls, ring_seconds')
      .eq('user_id', userId)
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({
      auto_retry: data?.auto_retry ?? true,
      record_calls: data?.record_calls ?? true,
      ring_seconds: data?.ring_seconds ?? 25,
    });
  }

  if (req.method === 'POST') {
    const { auto_retry, record_calls, ring_seconds } = req.body || {};
    const update = { user_id: userId, updated_at: new Date().toISOString() };
    if (typeof auto_retry === 'boolean') update.auto_retry = auto_retry;
    if (typeof record_calls === 'boolean') update.record_calls = record_calls;
    if (typeof ring_seconds === 'number' && ring_seconds >= 10 && ring_seconds <= 60) update.ring_seconds = ring_seconds;
    const { error } = await supabase.from('profiles').upsert(update, { onConflict: 'user_id' });
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: 'GET or POST only' });
}
