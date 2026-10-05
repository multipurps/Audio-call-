import { getServiceClient, getAuthedUserId } from '../lib/supabaseAdmin.js';
import { LIVE_VOICES, liveVoiceById } from '../lib/liveVoices.js';
import { liveVoicePreview } from '../lib/liveVoicePreview.js';

// Client sends { audioBase64, mimeType } — a 10-30s sample recorded/uploaded
// in the browser. The Fish Audio key lives only in this server-side env var;
// it is never sent to or read by the client (same rule as Live Call's
// provider-key handling in lib/keys.js).
export default async function handler(req, res) {
  const supabase = getServiceClient();
  const userId = await getAuthedUserId(req, supabase);
  if (!userId) return res.status(401).json({ error: 'Not signed in' });

  // Voice preferences and Live-voice previews do not need the Fish key.
  const action = req.query?.action;
  if (action === 'prefs' && req.method === 'GET') return getPrefs(req, res, supabase, userId);
  if (action === 'prefs' && (req.method === 'PUT' || req.method === 'POST')) return savePrefs(req, res, supabase, userId);
  if (action === 'live-preview' && req.method === 'GET') return livePreview(req, res);

  const fishKey = process.env.FISH_API_KEY;
  if (!fishKey) return res.status(500).json({ error: 'Voice provider not configured' });

  if (req.method === 'GET') return getStatus(req, res, supabase, userId);
  if (req.method === 'DELETE') return deleteVoice(req, res, supabase, userId, fishKey);
  if (req.method === 'POST' && req.query?.action === 'preview') return previewVoice(req, res, supabase, userId, fishKey);
  if (req.method === 'POST') return cloneVoice(req, res, supabase, userId, fishKey);
  return res.status(405).json({ error: 'Method not allowed' });
}

async function getStatus(req, res, supabase, userId) {
  const { data } = await supabase.from('voice_profiles').select('status,provider_voice_id').eq('user_id', userId).maybeSingle();
  return res.status(200).json({ status: data?.status || 'none', voiceId: data?.provider_voice_id || null });
}

async function cloneVoice(req, res, supabase, userId, fishKey) {
  const { audioBase64, mimeType } = req.body || {};
  if (!audioBase64) return res.status(400).json({ error: 'audioBase64 required' });

  await supabase.from('voice_profiles').upsert({ user_id: userId, provider: 'fish', status: 'pending' });

  try {
    const audioBytes = Buffer.from(audioBase64, 'base64');
    const form = new FormData();
    form.append('type', 'tts');
    form.append('title', `user-${userId}`);
    form.append('visibility', 'private');
    form.append('train_mode', 'fast');
    // Fish removes background noise and normalises the recording before
    // training; a noisy phone-mic sample is the most common reason a clone
    // sounds flat and "generic AI".
    form.append('enhance_audio_quality', 'true');
    form.append('voices', new Blob([audioBytes], { type: mimeType || 'audio/webm' }), 'sample.webm');

    const resp = await fetch('https://api.fish.audio/model', {
      method: 'POST',
      headers: { Authorization: `Bearer ${fishKey}` },
      body: form,
    });

    if (!resp.ok) {
      const detail = await resp.text().catch(() => '');
      await supabase.from('voice_profiles').upsert({ user_id: userId, provider: 'fish', status: 'failed' });
      return res.status(502).json({ error: 'Voice provider rejected the sample', detail });
    }

    const data = await resp.json();
    const providerVoiceId = data?._id || data?.id;
    if (!providerVoiceId) {
      await supabase.from('voice_profiles').upsert({ user_id: userId, provider: 'fish', status: 'failed' });
      return res.status(502).json({ error: 'No voice id returned' });
    }

    await supabase.from('voice_profiles').upsert({
      user_id: userId,
      provider: 'fish',
      provider_voice_id: providerVoiceId,
      status: 'ready',
    });

    return res.status(200).json({ ok: true, voiceId: providerVoiceId });
  } catch (err) {
    await supabase.from('voice_profiles').upsert({ user_id: userId, provider: 'fish', status: 'failed' });
    return res.status(500).json({ error: err.message || String(err) });
  }
}

async function previewVoice(req, res, supabase, userId, fishKey) {
  const { data: profile } = await supabase.from('voice_profiles').select('provider_voice_id,status').eq('user_id', userId).maybeSingle();
  if (!profile?.provider_voice_id || profile.status !== 'ready') return res.status(400).json({ error: 'No cloned voice yet' });

  try {
    const resp = await fetch('https://api.fish.audio/v1/tts', {
      method: 'POST',
      headers: { Authorization: `Bearer ${fishKey}`, 'Content-Type': 'application/json', model: process.env.FISH_TTS_MODEL || 's2.1-pro' },
      body: JSON.stringify({
        text: "Hi, this is what your cloned voice sounds like. I'll use this voice on your calls.",
        reference_id: profile.provider_voice_id,
        format: 'mp3',
      }),
    });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => '');
      return res.status(502).json({ error: 'Preview generation failed', detail });
    }
    const audioBytes = Buffer.from(await resp.arrayBuffer());
    return res.status(200).json({ audioBase64: audioBytes.toString('base64'), mimeType: 'audio/mpeg' });
  } catch (err) {
    return res.status(500).json({ error: err.message || String(err) });
  }
}

async function deleteVoice(req, res, supabase, userId, fishKey) {
  const { data: profile } = await supabase.from('voice_profiles').select('provider_voice_id').eq('user_id', userId).maybeSingle();
  if (profile?.provider_voice_id) {
    try {
      await fetch(`https://api.fish.audio/model/${encodeURIComponent(profile.provider_voice_id)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${fishKey}` },
      });
    } catch (err) {
      console.error('Fish Audio delete failed (continuing to clear local record):', err);
    }
  }
  await supabase.from('voice_profiles').delete().eq('user_id', userId);
  return res.status(200).json({ ok: true });
}

// ---- voice preferences -------------------------------------------------------------------
// live_voice_*  : the GPT-Live voice (audio.output.voice). Never the cloned voice.
// use_custom_voice : whether calls use the user's cloned (Fish) voice. The call engine itself is
//                    derived from this at call time; it is not a user-facing setting.
async function getPrefs(req, res, supabase, userId) {
  const [{ data: prefs }, { data: clone }] = await Promise.all([
    supabase.from('voice_preferences').select('live_voice_id,live_voice_name,live_voice_gender,use_custom_voice').eq('user_id', userId).maybeSingle(),
    supabase.from('voice_profiles').select('status,provider_voice_id').eq('user_id', userId).maybeSingle(),
  ]);
  const cloneReady = clone?.status === 'ready' && !!clone?.provider_voice_id;
  return res.status(200).json({
    voices: LIVE_VOICES,
    liveVoiceId: prefs?.live_voice_id || null,
    liveVoiceName: prefs?.live_voice_name || null,
    liveVoiceGender: prefs?.live_voice_gender || null,
    customVoice: { status: clone?.status || 'none', ready: cloneReady, id: cloneReady ? clone.provider_voice_id : null },
    // Matches what the call service does: a ready clone is used unless the user picked a Standard voice.
    useCustomVoice: cloneReady && prefs?.use_custom_voice !== false,
  });
}

async function savePrefs(req, res, supabase, userId) {
  const body = req.body || {};
  const row = { user_id: userId, updated_at: new Date().toISOString() };
  if (body.liveVoiceId !== undefined && body.liveVoiceId !== null) {
    const voice = liveVoiceById(body.liveVoiceId);
    if (!voice) return res.status(400).json({ error: 'Unknown Live voice' });
    row.live_voice_id = voice.id; row.live_voice_name = voice.name; row.live_voice_gender = voice.gender;
  }
  if (body.useCustomVoice !== undefined) {
    if (typeof body.useCustomVoice !== 'boolean') return res.status(400).json({ error: 'useCustomVoice must be true or false' });
    if (body.useCustomVoice) {
      const { data: clone } = await supabase.from('voice_profiles').select('status,provider_voice_id').eq('user_id', userId).maybeSingle();
      if (clone?.status !== 'ready' || !clone?.provider_voice_id) return res.status(400).json({ error: 'No custom voice is ready yet' });
    }
    row.use_custom_voice = body.useCustomVoice;
  }
  if (Object.keys(row).length <= 2) return res.status(400).json({ error: 'Nothing to save' });
  const { error } = await supabase.from('voice_preferences').upsert(row, { onConflict: 'user_id' });
  if (error) return res.status(500).json({ error: 'Could not save voice settings', detail: error.message });
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
