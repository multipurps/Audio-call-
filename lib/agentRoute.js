// The voice choices beyond Standard. "Custom" is the user's own cloned voice, run on the
// Inworld realtime agent. "Live" is a built-in preset, run on the Grok realtime agent. The
// choice is saved as the user's default for calls. The provider keys stay on the server.
// Called from api/voice-clone.js (?target=agent).

const INWORLD_VOICES = 'https://api.inworld.ai/voices/v1/voices';
const INWORLD_TTS = 'https://api.inworld.ai/tts/v1/voice';
const INWORLD_CLONE = 'https://api.inworld.ai/voices/v1/voices:clone';
const XAI_TTS = 'https://api.x.ai/v1/tts';
// The same sentence for every preview, so the voices can be compared.
const PREVIEW_TEXT = 'This is how I sound when I call for you.';
const MAX_SAMPLE_BYTES = 4 * 1024 * 1024; // the clone service accepts up to 4 MB per sample
const VOICE_ID = /^[A-Za-z0-9_-]{2,120}$/;

export const LIVE_VOICES = [
  { id: 'carina', name: 'Carina', tone: 'Soft, empathetic, soothing' },
  { id: 'zagan', name: 'Zagan', tone: 'Powerful, dramatic' },
  { id: 'helix', name: 'Helix', tone: 'Bold, dynamic' },
  { id: 'orion', name: 'Orion', tone: 'Rich, cinematic' },
  { id: 'luna', name: 'Luna', tone: 'Gentle, patient' },
  { id: 'iris', name: 'Iris', tone: 'Friendly, upbeat' },
  { id: 'altair', name: 'Altair', tone: 'Elegant, refined' },
  { id: 'zenith', name: 'Zenith', tone: 'Sharp, focused' },
  { id: 'perseus', name: 'Perseus', tone: 'Strong, confident' },
  { id: 'helios', name: 'Helios', tone: 'Upbeat, energetic' },
  { id: 'lux', name: 'Lux', tone: 'Grounded, calm' },
  { id: 'kepler', name: 'Kepler', tone: 'Inventive, forward-thinking' },
  { id: 'rigel', name: 'Rigel', tone: 'Precise, professional' },
  { id: 'cosmo', name: 'Cosmo', tone: 'Bright, curious' },
  { id: 'celeste', name: 'Celeste', tone: 'Compassionate, confident' },
  { id: 'ursa', name: 'Ursa', tone: 'Friendly, warm, steadfast' },
  { id: 'sirius', name: 'Sirius', tone: 'Quick-witted, clever' },
  { id: 'lumen', name: 'Lumen', tone: 'Warm, articulate' },
  { id: 'castor', name: 'Castor', tone: 'Charismatic, down-to-earth' },
  { id: 'naksh', name: 'Naksh', tone: 'Warm, thoughtful' },
  { id: 'atlas', name: 'Atlas', tone: 'Confident, commanding' },
  { id: 'aurora', name: 'Aurora', tone: 'Serene, steady' },
  { id: 'liora', name: 'Liora', tone: 'Calm, grounded' },
  { id: 'ara', name: 'Ara', tone: 'Warm and friendly' },
  { id: 'eve', name: 'Eve', tone: 'Energetic and upbeat' },
  { id: 'leo', name: 'Leo', tone: 'Authoritative and strong' },
  { id: 'rex', name: 'Rex', tone: 'Confident and clear' },
  { id: 'sal', name: 'Sal', tone: 'Smooth and balanced' },
];

export async function agentRoute(req, res, supabase, userId, keys) {
  const action = req.query?.action;
  if (req.method === 'GET' && action === 'status') return status(res, supabase, userId, keys);
  if (req.method === 'PUT' && action === 'choose') return choose(req, res, supabase, userId, keys);
  if (req.method === 'GET' && action === 'preview') return preview(req, res, keys);
  if (req.method === 'POST' && action === 'clone') return clone(req, res, supabase, userId, keys);
  return res.status(405).json({ error: 'Method not allowed' });
}

async function readRow(supabase, userId) {
  const { data, error } = await supabase.from('user_agents').select('active,provider,voice_id').eq('user_id', userId).maybeSingle();
  if (error) throw new Error('Could not read the voice setting');
  return data || null;
}

// The user's own cloned voices in the Inworld workspace (owned only, not the shared catalogue).
async function customVoices(key) {
  if (!key) return { voices: [], error: 'Custom voices are not set up on the server yet' };
  try {
    const url = `${INWORLD_VOICES}?filter=${encodeURIComponent('owned = "true"')}&pageSize=100`;
    const resp = await fetch(url, { headers: { Authorization: `Basic ${key}` } });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) return { voices: [], error: 'Your custom voices could not be loaded right now' };
    const voices = (data.voices || [])
      .map((v) => ({ id: v.voiceId, name: v.displayName || v.voiceId, tone: v.description || '' }))
      .filter((v) => v.id);
    return { voices, error: null };
  } catch {
    return { voices: [], error: 'Your custom voices could not be loaded right now' };
  }
}

async function status(res, supabase, userId, keys) {
  try {
    const row = await readRow(supabase, userId);
    const custom = await customVoices(keys?.inworld);
    const provider = row?.provider === 'inworld' ? 'custom' : row?.provider === 'grok' ? 'live' : null;
    const pool = provider === 'custom' ? custom.voices : LIVE_VOICES;
    const current = pool.find((v) => v.id === row?.voice_id);
    return res.status(200).json({
      active: !!row?.active,
      provider,
      voiceId: row?.voice_id || null,
      voiceName: current?.name || null,
      custom,
      live: { voices: LIVE_VOICES },
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

async function choose(req, res, supabase, userId, keys) {
  const choice = req.body?.provider;
  const voiceId = typeof req.body?.voiceId === 'string' ? req.body.voiceId.trim() : '';
  if (choice !== 'custom' && choice !== 'live') return res.status(400).json({ error: 'Choose a voice' });
  if (!VOICE_ID.test(voiceId)) return res.status(400).json({ error: 'Choose a voice' });

  let chosen;
  if (choice === 'custom') {
    const custom = await customVoices(keys?.inworld);
    if (custom.error) return res.status(502).json({ error: custom.error });
    chosen = custom.voices.find((v) => v.id === voiceId);
  } else {
    chosen = LIVE_VOICES.find((v) => v.id === voiceId);
  }
  if (!chosen) return res.status(400).json({ error: 'That voice is not available' });

  const { error } = await supabase
    .from('user_agents')
    .upsert({
      user_id: userId,
      provider: choice === 'custom' ? 'inworld' : 'grok',
      voice_id: voiceId,
      active: true,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id' });
  if (error) return res.status(500).json({ error: 'Could not save the voice' });
  return res.status(200).json({ active: true, provider: choice, voiceId, voiceName: chosen.name });
}

// A short clip of a voice, saying the same sentence. Only voices the user can use are played:
// a built-in preset from the list, or one of the user's own clones.
async function preview(req, res, keys) {
  const provider = req.query?.provider;
  const voiceId = typeof req.query?.voice === 'string' ? req.query.voice : '';
  if (!VOICE_ID.test(voiceId)) return res.status(400).json({ error: 'Unknown voice' });
  try {
    if (provider === 'live') {
      if (!LIVE_VOICES.some((v) => v.id === voiceId)) return res.status(400).json({ error: 'Unknown voice' });
      if (!keys?.xai) return res.status(502).json({ error: 'Preview is not set up on the server yet' });
      const resp = await fetch(XAI_TTS, {
        method: 'POST',
        headers: { Authorization: `Bearer ${keys.xai}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: PREVIEW_TEXT, voice_id: voiceId, language: 'en' }),
      });
      if (!resp.ok) return res.status(502).json({ error: 'Preview unavailable' });
      const audio = Buffer.from(await resp.arrayBuffer());
      res.setHeader('Cache-Control', 'private, max-age=86400');
      return res.status(200).json({ audioBase64: audio.toString('base64'), mimeType: resp.headers.get('content-type') || 'audio/mpeg' });
    }
    if (provider === 'custom') {
      const custom = await customVoices(keys?.inworld);
      if (custom.error) return res.status(502).json({ error: custom.error });
      if (!custom.voices.some((v) => v.id === voiceId)) return res.status(400).json({ error: 'Unknown voice' });
      const resp = await fetch(INWORLD_TTS, {
        method: 'POST',
        headers: { Authorization: `Basic ${keys.inworld}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: PREVIEW_TEXT, voiceId, modelId: 'inworld-tts-2', audioConfig: { audioEncoding: 'MP3' } }),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok || !data.audioContent) return res.status(502).json({ error: 'Preview unavailable' });
      res.setHeader('Cache-Control', 'private, max-age=86400');
      return res.status(200).json({ audioBase64: data.audioContent, mimeType: 'audio/mpeg' });
    }
    return res.status(400).json({ error: 'Unknown voice' });
  } catch {
    return res.status(502).json({ error: 'Preview unavailable' });
  }
}

// The user's own voice: one clip (4 MB at most) becomes a clone in their Inworld workspace.
async function clone(req, res, supabase, userId, keys) {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const sample = body.sample || {};
  if (!name) return res.status(400).json({ error: 'Give the voice a name' });
  if (name.length > 60) return res.status(400).json({ error: 'Keep the name under 60 characters' });
  if (body.consent !== true) return res.status(400).json({ error: 'Confirm this is your voice, or that you have the right to use it' });
  if (typeof sample.data !== 'string' || !sample.data) return res.status(400).json({ error: 'Choose an audio clip' });
  if (typeof sample.type !== 'string' || !sample.type.startsWith('audio/')) return res.status(400).json({ error: 'The clip must be an audio file' });
  if (Math.floor((sample.data.length * 3) / 4) > MAX_SAMPLE_BYTES) return res.status(400).json({ error: 'The clip is too large. Use a clip under 4 MB' });
  if (!keys?.inworld) return res.status(502).json({ error: 'Cloning is not set up on the server yet' });
  try {
    const resp = await fetch(INWORLD_CLONE, {
      method: 'POST',
      headers: { Authorization: `Basic ${keys.inworld}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: name, langCode: 'EN_US', voiceSamples: [sample.data] }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) return res.status(502).json({ error: data?.message || 'The voice could not be cloned. Try a clearer clip of 5 to 15 seconds.' });
    const voiceId = data?.voice?.voiceId || data?.voiceId;
    if (!voiceId) return res.status(502).json({ error: 'The voice could not be cloned. Try again.' });
    return res.status(200).json({ voiceId, name });
  } catch {
    return res.status(502).json({ error: 'The voice could not be cloned. Try again.' });
  }
}
