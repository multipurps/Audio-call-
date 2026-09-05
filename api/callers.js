import { getServiceClient, getAuthedUserId } from '../lib/supabaseAdmin.js';

export default async function handler(req, res) {
  const supabase = getServiceClient();
  const userId = await getAuthedUserId(req, supabase);
  if (!userId) return res.status(401).json({ error: 'Not signed in' });

  if (req.method === 'GET') {
    const { data, error } = await supabase
      .from('ai_callers')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ callers: data });
  }

  if (req.method === 'POST') {
    const { name, personality, instructions, voiceSource, libraryVoiceId } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: 'Name required' });
    const { data, error } = await supabase
      .from('ai_callers')
      .insert({
        user_id: userId,
        name: name.trim(),
        personality: personality || 'natural',
        instructions: instructions || '',
        voice_source: voiceSource || 'cloned',
        library_voice_id: libraryVoiceId || null,
      })
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ caller: data });
  }

  if (req.method === 'DELETE') {
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ error: 'id required' });
    const { error } = await supabase.from('ai_callers').delete().eq('id', id).eq('user_id', userId);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: 'GET, POST, or DELETE only' });
}
