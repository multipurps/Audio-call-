import { getServiceClient, getAuthedUserId } from '../lib/supabaseAdmin.js';

export default async function handler(req, res) {
  const supabase = getServiceClient();
  const userId = await getAuthedUserId(req, supabase);
  if (!userId) return res.status(401).json({ error: 'Not signed in' });

  if (req.method === 'GET') {
    const { data, error } = await supabase
      .from('memories')
      .select('id, content, contact_id, created_at, contacts(name)')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(200);
    if (error) return res.status(500).json({ error: error.message });
    const memories = (data || []).map((m) => ({
      id: m.id,
      content: m.content,
      contactName: m.contacts?.name || null,
      created_at: m.created_at,
    }));
    return res.status(200).json({ memories });
  }

  if (req.method === 'DELETE') {
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ error: 'id required' });
    const { error } = await supabase.from('memories').delete().eq('id', id).eq('user_id', userId);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: 'GET or DELETE only' });
}
