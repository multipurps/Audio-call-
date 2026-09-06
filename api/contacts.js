import { getServiceClient, getAuthedUserId } from '../lib/supabaseAdmin.js';

export default async function handler(req, res) {
  const supabase = getServiceClient();
  const userId = await getAuthedUserId(req, supabase);
  if (!userId) return res.status(401).json({ error: 'Not signed in' });

  if (req.method === 'GET') {
    const { data, error } = await supabase
      .from('contacts')
      .select('*')
      .eq('user_id', userId)
      .order('name', { ascending: true });
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ contacts: data });
  }

  if (req.method === 'POST') {
    const { name, phoneNumber } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: 'Name required' });
    if (!phoneNumber || !phoneNumber.trim()) return res.status(400).json({ error: 'Phone number required' });
    const { data, error } = await supabase
      .from('contacts')
      .insert({ user_id: userId, name: name.trim(), phone_number: phoneNumber.trim() })
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ contact: data });
  }

  if (req.method === 'DELETE') {
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ error: 'id required' });
    const { error } = await supabase.from('contacts').delete().eq('id', id).eq('user_id', userId);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: 'GET, POST, or DELETE only' });
}
