// The Agent: calls are answered by the agent set up in ElevenLabs. Its voice and settings
// live there, so the app only switches it on or off for the user.
// Called from api/voice-clone.js (?target=agent).

export async function agentRoute(req, res, supabase, userId) {
  const action = req.query?.action;
  if (req.method === 'GET' && action === 'status') return status(res, supabase, userId);
  if (req.method === 'PUT' && action === 'choose') return choose(res, supabase, userId);
  return res.status(405).json({ error: 'Method not allowed' });
}

async function status(res, supabase, userId) {
  const { data, error } = await supabase.from('user_agents').select('active').eq('user_id', userId).maybeSingle();
  if (error) return res.status(500).json({ error: 'Could not read the Agent setting' });
  return res.status(200).json({ active: !!data?.active });
}

async function choose(res, supabase, userId) {
  const { error } = await supabase
    .from('user_agents')
    .upsert({ user_id: userId, active: true, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
  if (error) return res.status(500).json({ error: 'Could not turn on the Agent' });
  return res.status(200).json({ active: true });
}
