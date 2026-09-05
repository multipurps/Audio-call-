import { getServiceClient, getAuthedUserId } from '../lib/supabaseAdmin.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const supabase = getServiceClient();
  const userId = await getAuthedUserId(req, supabase);
  if (!userId) return res.status(401).json({ error: 'Not signed in' });

  const { callId, muted } = req.body || {};
  if (!callId || typeof muted !== 'boolean') return res.status(400).json({ error: 'callId and muted required' });

  const { error } = await supabase.from('calls').update({ ai_muted: muted }).eq('id', callId).eq('user_id', userId);
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ ok: true });
}
