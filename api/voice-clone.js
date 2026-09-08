import { getServiceClient, getAuthedUserId } from '../lib/supabaseAdmin.js';

// Client sends { audioBase64, mimeType } — a 10-30s sample recorded/uploaded
// in the browser. The Fish Audio key lives only in this server-side env var;
// it is never sent to or read by the client (same rule as Live Call's
// provider-key handling in lib/keys.js).
export default async function handler(req, res) {
  const supabase = getServiceClient();
  const userId = await getAuthedUserId(req, supabase);
  if (!userId) return res.status(401).json({ error: 'Not signed in' });

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
      headers: { Authorization: `Bearer ${fishKey}`, 'Content-Type': 'application/json', model: 's2.1-pro' },
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
