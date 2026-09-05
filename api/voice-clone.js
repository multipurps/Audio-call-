import { getServiceClient, getAuthedUserId } from '../lib/supabaseAdmin.js';

// Client sends { audioBase64, mimeType } — a 10-30s sample recorded/uploaded
// in the browser. The Fish Audio key lives only in this server-side env var;
// it is never sent to or read by the client (same rule as Live Call's
// provider-key handling in lib/keys.js).
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const supabase = getServiceClient();
  const userId = await getAuthedUserId(req, supabase);
  if (!userId) return res.status(401).json({ error: 'Not signed in' });

  const fishKey = process.env.FISH_API_KEY;
  if (!fishKey) return res.status(500).json({ error: 'Voice provider not configured' });

  const { audioBase64, mimeType } = req.body || {};
  if (!audioBase64) return res.status(400).json({ error: 'audioBase64 required' });

  await supabase.from('voice_profiles').upsert({ user_id: userId, provider: 'fish', status: 'pending' });

  try {
    const audioBytes = Buffer.from(audioBase64, 'base64');
    const form = new FormData();
    form.append('title', `user-${userId}`);
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
