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
    // Was a plain insert() with no check for an existing contact at this
    // number first - saving the same contact twice (or a slow double-tap
    // on the button) created a duplicate row every single time. Now
    // updates the existing one for this user+number instead of adding
    // another.
    const { data: existing } = await supabase
      .from('contacts')
      .select('id')
      .eq('user_id', userId)
      .eq('phone_number', phoneNumber.trim())
      .maybeSingle();
    const { data, error } = existing
      ? await supabase.from('contacts').update({ name: name.trim() }).eq('id', existing.id).select().single()
      : await supabase.from('contacts').insert({ user_id: userId, name: name.trim(), phone_number: phoneNumber.trim() }).select().single();
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
