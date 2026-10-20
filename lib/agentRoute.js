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
const ONE_VOICE = 'You already have a custom voice. Delete it before adding a new one.';

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
  if (req.method === 'GET' && action === 'preview') return preview(req, res, supabase, userId, keys);
  if (req.method === 'POST' && action === 'clone') return clone(req, res, supabase, userId, keys);
  if ((req.method === 'DELETE' || req.method === 'POST') && action === 'delete') return deleteClone(res, supabase, userId, keys);
  return res.status(405).json({ error: 'Method not allowed' });
}

async function readRow(supabase, userId) {
  const { data, error } = await supabase.from('user_agents').select('active,provider,voice_id').eq('user_id', userId).maybeSingle();
  if (error) throw new Error('Could not read the voice setting');
  return data || null;
}

// The Inworld workspace is shared by every user, so a clone is marked with its owner when it is
// made (a tag only the server sets), and a user is only ever shown, or allowed to use or delete,
// voices carrying their own mark. There is no database table for this: the mark lives on the voice.
const ownerTag = (userId) => `emysa-user-${String(userId).toLowerCase()}`;
const isOwnedBy = (v, tag) => (Array.isArray(v?.tags) && v.tags.some((t) => String(t).toLowerCase() === tag))
  || String(v?.description || '').toLowerCase() === tag;
const MAX_VOICE_PAGES = 30; // 3,000 voices

async function customVoices(key, userId) {
  if (!key) return { voices: [], error: 'Your custom voice is not available right now' };
  const tag = ownerTag(userId);
  const found = [];
  try {
    let pageToken = '';
    for (let page = 0; page < MAX_VOICE_PAGES; page++) {
      const params = new URLSearchParams({ filter: 'owned = "true"', pageSize: '100' });
      if (pageToken) params.set('pageToken', pageToken);
      const resp = await fetch(`${INWORLD_VOICES}?${params}`, { headers: { Authorization: `Basic ${key}` } });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) { await logUpstream('custom voices', resp); return { voices: [], error: 'Your custom voice could not be loaded right now' }; }
      for (const v of data.voices || []) if (v.voiceId && isOwnedBy(v, tag)) found.push({ id: v.voiceId, name: v.displayName || 'My voice', tone: '' });
      pageToken = data.nextPageToken || '';
      if (!pageToken) break;
    }
  } catch {
    return { voices: [], error: 'Your custom voice could not be loaded right now' };
  }
  return { voices: found.sort((x, y) => (x.id < y.id ? -1 : 1)), error: null };
}

async function status(res, supabase, userId, keys) {
  try {
    const row = await readRow(supabase, userId);
    const custom = await customVoices(keys?.inworld, userId);
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
    const custom = await customVoices(keys?.inworld, userId);
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
async function preview(req, res, supabase, userId, keys) {
  const provider = req.query?.provider;
  const voiceId = typeof req.query?.voice === 'string' ? req.query.voice : '';
  if (!VOICE_ID.test(voiceId)) return res.status(400).json({ error: 'Unknown voice' });
  try {
    if (provider === 'live') {
      if (!LIVE_VOICES.some((v) => v.id === voiceId)) return res.status(400).json({ error: 'Unknown voice' });
      if (!keys?.xai) { console.error('[voice] live preview: no key available'); return res.status(502).json({ error: 'Preview is not available right now' }); }
      const resp = await fetch(XAI_TTS, {
        method: 'POST',
        headers: { Authorization: `Bearer ${keys.xai}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: PREVIEW_TEXT, voice_id: voiceId, language: 'en' }),
      });
      if (!resp.ok) { await logUpstream('live preview', resp); return res.status(502).json({ error: 'Preview is not available right now' }); }
      const clip = await readSpeechResponse(resp);
      res.setHeader('Cache-Control', 'private, max-age=86400');
      return res.status(200).json(clip);
    }
    if (provider === 'custom') {
      const custom = await customVoices(keys?.inworld, userId);
      if (custom.error) return res.status(502).json({ error: custom.error });
      if (!custom.voices.some((v) => v.id === voiceId)) return res.status(400).json({ error: 'Unknown voice' });
      const resp = await fetch(INWORLD_TTS, {
        method: 'POST',
        headers: { Authorization: `Basic ${keys.inworld}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: PREVIEW_TEXT, voiceId, modelId: 'inworld-tts-2', audioConfig: { audioEncoding: 'MP3' } }),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok || !data.audioContent) { console.error(`[voice] custom preview failed status=${resp.status}`); return res.status(502).json({ error: 'Preview is not available right now' }); }
      res.setHeader('Cache-Control', 'private, max-age=86400');
      return res.status(200).json({ audioBase64: data.audioContent, mimeType: 'audio/mpeg' });
    }
    return res.status(400).json({ error: 'Unknown voice' });
  } catch (err) {
    console.error(`[voice] preview error: ${err?.message || err}`);
    return res.status(502).json({ error: 'Preview is not available right now' });
  }
}

// The speech service answers with raw audio or with JSON holding base64 audio; accept both.
async function readSpeechResponse(resp) {
  const type = resp.headers?.get?.('content-type') || '';
  if (type.includes('application/json')) {
    const data = await resp.json();
    if (!data?.audio) throw new Error('empty audio');
    return { audioBase64: data.audio, mimeType: data.content_type || 'audio/mpeg' };
  }
  const audio = Buffer.from(await resp.arrayBuffer());
  if (!audio.length) throw new Error('empty audio');
  return { audioBase64: audio.toString('base64'), mimeType: type || 'audio/mpeg' };
}

// The reason a provider refused, for the server log only. Never includes a key, never shown to users.
async function logUpstream(label, resp) {
  let detail = '';
  try { detail = (await resp.text()).slice(0, 300); } catch { /* no body */ }
  console.error(`[voice] ${label} failed status=${resp.status} detail=${detail}`);
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
  if (!keys?.inworld) return res.status(502).json({ error: 'Cloning is not available right now' });
  const existing = await customVoices(keys.inworld, userId);
  if (existing.error) return res.status(502).json({ error: existing.error });
  if (existing.voices.length) return res.status(409).json({ error: ONE_VOICE });
  try {
    const resp = await fetch(INWORLD_CLONE, {
      method: 'POST',
      headers: { Authorization: `Basic ${keys.inworld}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: name, langCode: 'EN_US', voiceSamples: [{ audioData: sample.data }], description: ownerTag(userId), tags: [ownerTag(userId)] }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      // The provider's own wording (e.g. a protobuf parse error) is for the server log, not the user.
      console.error(`[voice] clone failed status=${resp.status} detail=${String(data?.message || '').slice(0, 300)}`);
      return res.status(502).json({ error: 'The voice could not be cloned. Try a clearer clip of 5 to 15 seconds.' });
    }
    const voiceId = data?.voice?.voiceId || data?.voiceId;
    if (!voiceId) return res.status(502).json({ error: 'The voice could not be cloned. Try again.' });
    // Two clones started at once for one user: both now see two voices and both agree which one
    // stays (the lowest id), so exactly one survives and the other removes itself.
    const mine = await customVoices(keys.inworld, userId);
    const keep = mine.voices.map((v) => v.id).concat(voiceId).sort()[0];
    if (keep !== voiceId) {
      await deleteInworldVoice(keys.inworld, voiceId).catch(() => {});
      return res.status(409).json({ error: ONE_VOICE });
    }
    return res.status(200).json({ voiceId, name });
  } catch {
    return res.status(502).json({ error: 'The voice could not be cloned. Try again.' });
  }
}

// Removes the clone at the provider. A voice that is already gone counts as removed.
async function deleteInworldVoice(key, voiceId) {
  const resp = await fetch(`${INWORLD_VOICES}/${encodeURIComponent(voiceId)}`, { method: 'DELETE', headers: { Authorization: `Basic ${key}` } });
  if (resp.ok || resp.status === 404) return;
  await logUpstream('delete voice', resp);
  throw new Error('delete refused');
}

// Delete the user's custom voice. The provider is told first; only when it is gone there is
// anything else changed, so a failure can simply be retried. If calls were using the voice, they go
// back to the Standard voice.
async function deleteClone(res, supabase, userId, keys) {
  if (!keys?.inworld) return res.status(502).json({ error: 'Your voice could not be deleted right now. Try again.' });
  const mine = await customVoices(keys.inworld, userId);
  if (mine.error) return res.status(502).json({ error: 'Your voice could not be deleted right now. Try again.' });
  if (!mine.voices.length) return res.status(200).json({ deleted: false });
  try {
    for (const v of mine.voices) await deleteInworldVoice(keys.inworld, v.id);
  } catch {
    return res.status(502).json({ error: 'Your voice could not be deleted right now. Try again.' });
  }
  // A failure here is not fatal: the call path ignores a voice that no longer exists.
  await supabase.from('user_agents').delete().eq('user_id', userId).eq('provider', 'inworld').then(() => {}, () => {});
  return res.status(200).json({ deleted: true });
}
