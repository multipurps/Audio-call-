// The Agent voice: calls are answered by the Grok speech-to-speech agent, using the voice the
// user picks here. The voices are the user's own custom voices from xAI. The instructions come
// from the same AI behaviour config as GPT-Live, so there is one brain. The xAI key stays on
// the server. Called from api/voice-clone.js (?target=agent).

const API = 'https://api.x.ai/v1';
const VOICE_ID = /^[a-z0-9]{8}$/;

export async function agentRoute(req, res, supabase, userId, key) {
  const action = req.query?.action;
  if (req.method === 'GET' && action === 'status') return status(res, supabase, userId, key);
  if (req.method === 'PUT' && action === 'choose') return choose(req, res, supabase, userId, key);
  if (req.method === 'GET' && action === 'preview') return preview(req, res, key);
  return res.status(405).json({ error: 'Method not allowed' });
}

async function readRow(supabase, userId) {
  const { data, error } = await supabase.from('user_agents').select('active,voice_id').eq('user_id', userId).maybeSingle();
  if (error) throw new Error('Could not read the Agent setting');
  return data || null;
}

async function listVoices(key) {
  const resp = await fetch(`${API}/custom-voices?limit=100`, { headers: { Authorization: `Bearer ${key}` } });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error('Could not load your voices');
  return (data.voices || [])
    .map((v) => ({
      id: v.voice_id,
      name: v.name,
      gender: v.gender || '',
      accent: v.accent || '',
      language: v.language || '',
    }))
    .filter((v) => v.id && v.name);
}

async function status(res, supabase, userId, key) {
  try {
    const row = await readRow(supabase, userId);
    let voices = [];
    let voicesError = null;
    try {
      voices = await listVoices(key);
    } catch (err) {
      voicesError = err.message;
    }
    const current = voices.find((v) => v.id === row?.voice_id);
    return res.status(200).json({
      active: !!row?.active,
      voiceId: row?.voice_id || null,
      voiceName: current?.name || null,
      voices,
      voicesError,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

async function choose(req, res, supabase, userId, key) {
  const voiceId = typeof req.body?.voiceId === 'string' ? req.body.voiceId.trim() : '';
  if (!VOICE_ID.test(voiceId)) return res.status(400).json({ error: 'Choose a voice' });
  let voices;
  try {
    voices = await listVoices(key);
  } catch {
    return res.status(502).json({ error: 'Could not check your voices right now' });
  }
  const chosen = voices.find((v) => v.id === voiceId);
  if (!chosen) return res.status(400).json({ error: 'That voice is not on your account' });
  const { error } = await supabase
    .from('user_agents')
    .upsert({ user_id: userId, voice_id: voiceId, active: true, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
  if (error) return res.status(500).json({ error: 'Could not save the Agent voice' });
  return res.status(200).json({ active: true, voiceId, voiceName: chosen.name });
}

// The reference clip of one of the user's own voices, so the user can hear it before choosing.
async function preview(req, res, key) {
  const voiceId = typeof req.query?.voice === 'string' ? req.query.voice : '';
  if (!VOICE_ID.test(voiceId)) return res.status(400).json({ error: 'Unknown voice' });
  try {
    const resp = await fetch(`${API}/custom-voices/${voiceId}/audio`, { headers: { Authorization: `Bearer ${key}` } });
    if (!resp.ok) return res.status(502).json({ error: 'Preview unavailable' });
    const audio = Buffer.from(await resp.arrayBuffer());
    res.setHeader('Cache-Control', 'private, max-age=86400');
    return res.status(200).json({
      audioBase64: audio.toString('base64'),
      mimeType: resp.headers.get('content-type') || 'audio/wav',
    });
  } catch {
    return res.status(502).json({ error: 'Preview unavailable' });
  }
}
