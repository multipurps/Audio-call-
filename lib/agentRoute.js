// The Agent voice: calls are answered by the Emysa agent set up in ElevenLabs, using the
// voice the user picks here. The instructions come from the same AI behaviour config as
// GPT-Live, so there is one brain. The ElevenLabs key stays on the server.
// Called from api/voice-clone.js (?target=agent).

const API = 'https://api.elevenlabs.io/v1';
const VOICE_ID = /^[A-Za-z0-9]{8,40}$/;
const PREVIEW_TEXT = 'This is how I will sound when I call for you.';

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
  const resp = await fetch(`${API}/voices`, { headers: { 'xi-api-key': key } });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error('Could not load voices');
  return (data.voices || [])
    .map((v) => ({
      id: v.voice_id,
      name: v.name,
      gender: v.labels?.gender || '',
      accent: v.labels?.accent || '',
      previewUrl: v.preview_url || null,
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
    return res.status(502).json({ error: 'Could not check the voices right now' });
  }
  const chosen = voices.find((v) => v.id === voiceId);
  if (!chosen) return res.status(400).json({ error: 'That voice is not available' });
  const { error } = await supabase
    .from('user_agents')
    .upsert({ user_id: userId, voice_id: voiceId, active: true, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
  if (error) return res.status(500).json({ error: 'Could not save the Agent voice' });
  return res.status(200).json({ active: true, voiceId, voiceName: chosen.name });
}

// One short clip per voice, spoken with the same sentence as the Standard voices, so the
// voices can be compared. The app keeps each clip on the device after the first download.
async function preview(req, res, key) {
  const voiceId = typeof req.query?.voice === 'string' ? req.query.voice : '';
  if (!VOICE_ID.test(voiceId)) return res.status(400).json({ error: 'Unknown voice' });
  try {
    const resp = await fetch(`${API}/text-to-speech/${voiceId}?output_format=mp3_44100_128`, {
      method: 'POST',
      headers: { 'xi-api-key': key, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
      body: JSON.stringify({ text: PREVIEW_TEXT, model_id: 'eleven_flash_v2_5' }),
    });
    if (!resp.ok) {
      const data = await resp.json().catch(() => ({}));
      return res.status(502).json({ error: data?.detail?.message || 'Preview unavailable' });
    }
    const audio = Buffer.from(await resp.arrayBuffer());
    res.setHeader('Cache-Control', 'private, max-age=86400');
    return res.status(200).json({ audioBase64: audio.toString('base64'), mimeType: 'audio/mpeg' });
  } catch {
    return res.status(502).json({ error: 'Preview unavailable' });
  }
}
