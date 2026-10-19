import { getServiceClient, getAuthedUserId } from '../lib/supabaseAdmin.js';
import { LIVE_VOICES, liveVoiceById } from '../lib/liveVoices.js';
import { liveVoicePreview } from '../lib/liveVoicePreview.js';
import { agentRoute } from '../lib/agentRoute.js';
import { getSecret } from '../lib/secrets.js';

// The Voice & Language screen's API: the Standard (GPT-Live) voice choice and its previews,
// and the Custom voice, which is the user's own xAI voice used through the Grok agent
// (?target=agent). The xAI key stays on the server.
export default async function handler(req, res) {
  const supabase = getServiceClient();
  const userId = await getAuthedUserId(req, supabase);
  if (!userId) return res.status(401).json({ error: 'Not signed in' });

  if (req.query?.target === 'agent') {
    const xaiKey = await getSecret(supabase, 'XAI_API_KEY');
    if (!xaiKey) return res.status(500).json({ error: 'The Custom voice is not configured on the server' });
    return agentRoute(req, res, supabase, userId, xaiKey);
  }

  const action = req.query?.action;
  if (action === 'prefs' && req.method === 'GET') return getPrefs(req, res, supabase, userId);
  if (action === 'prefs' && (req.method === 'PUT' || req.method === 'POST')) return savePrefs(req, res, supabase, userId);
  if (action === 'live-preview' && req.method === 'GET') return livePreview(req, res);
  return res.status(405).json({ error: 'Method not allowed' });
}

// ---- voice preferences -------------------------------------------------------------------
// live_voice_* : the Standard (GPT-Live) voice. The Custom voice is kept in user_agents.
async function getPrefs(req, res, supabase, userId) {
  const { data: prefs } = await supabase
    .from('voice_preferences')
    .select('live_voice_id,live_voice_name,live_voice_gender')
    .eq('user_id', userId)
    .maybeSingle();
  return res.status(200).json({
    voices: LIVE_VOICES,
    liveVoiceId: prefs?.live_voice_id || null,
    liveVoiceName: prefs?.live_voice_name || null,
    liveVoiceGender: prefs?.live_voice_gender || null,
    customVoice: { status: 'none', ready: false, id: null },
    useCustomVoice: false,
  });
}

async function savePrefs(req, res, supabase, userId) {
  const body = req.body || {};
  const row = { user_id: userId, updated_at: new Date().toISOString() };
  if (body.useCustomVoice === true) return res.status(400).json({ error: 'Choose your Custom voice on the Custom tab' });
  if (body.liveVoiceId !== undefined && body.liveVoiceId !== null) {
    const voice = liveVoiceById(body.liveVoiceId);
    if (!voice) return res.status(400).json({ error: 'Unknown Standard voice' });
    row.live_voice_id = voice.id; row.live_voice_name = voice.name; row.live_voice_gender = voice.gender;
  }
  if (Object.keys(row).length <= 2) return res.status(400).json({ error: 'Nothing to save' });
  const { error } = await supabase.from('voice_preferences').upsert(row, { onConflict: 'user_id' });
  if (error) return res.status(500).json({ error: 'Could not save voice settings', detail: error.message });
  // A Standard voice chosen: the Custom voice is switched off, so exactly one voice is in charge.
  await supabase.from('user_agents').update({ active: false, updated_at: new Date().toISOString() }).eq('user_id', userId).then(() => {}, () => {});
  return getPrefs(req, res, supabase, userId);
}

async function livePreview(req, res) {
  try {
    const wav = await liveVoicePreview(req.query?.voice, { apiKey: process.env.OPENAI_API_KEY || process.env.LUNA_API_KEY });
    res.setHeader('Cache-Control', 'private, max-age=86400');
    return res.status(200).json({ audioBase64: wav.toString('base64'), mimeType: 'audio/wav' });
  } catch (err) {
    return res.status(err.statusCode || 500).json({ error: err.message || 'Preview failed' });
  }
}
