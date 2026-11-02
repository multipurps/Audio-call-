// Anam avatar for the video call. The Anam API key is read on the server (admin
// `ANAM_API_KEY` or the Render env var) and only a short session token goes to the browser.
// The Anam key is ANAM_API_KEY on the server. The avatar is the person's own one (see anamAvatars.js).
// The voice is the person's own clone at Anam; the LLM is their Emysa brain (see anamLink.js).
import { serverKey } from './serverKeys.js';
import { getAnamAvatar } from './anamAvatars.js';
import { ensureAnamLlm, getAnamVoiceId } from './anamLink.js';

export const ANAM_SESSION_URL = 'https://api.anam.ai/v1/auth/session-token';

export function buildAvatarPrompt(brief = '', contactName = '') {
  const who = contactName ? ` with ${contactName}` : '';
  return [
    `You are the user's avatar on a live video call${who}. Speak naturally and briefly, one or two short sentences per turn.`,
    brief ? `The user briefed you on what to say: ${brief}` : 'The user has not given a brief yet; keep to small talk until they do.',
    'If someone asks directly whether you are an AI, answer honestly. Do not claim to be human.',
  ].join('\n');
}

export async function mintAnamSessionToken({ apiKey, personaName = 'Avatar', avatarId, voiceId, llmId, systemPrompt, fetchImpl = fetch }) {
  if (!apiKey) throw Object.assign(new Error('ANAM_API_KEY is not set on the server.'), { status: 400 });
  if (!avatarId) throw Object.assign(new Error('Pick your Anam avatar in Settings > Avatar first.'), { status: 400 });
  const personaConfig = { name: personaName.slice(0, 60), avatarId, systemPrompt, skipGreeting: true };
  if (voiceId) personaConfig.voiceId = voiceId;
  if (llmId) personaConfig.llmId = llmId;
  const r = await fetchImpl(ANAM_SESSION_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ personaConfig }),
  });
  const raw = await r.text();
  let data = null;
  try { data = JSON.parse(raw); } catch { /* not JSON */ }
  if (!r.ok || !data || !data.sessionToken) {
    const msg = (data && (data.message || data.error)) || raw.slice(0, 200) || 'no body';
    throw Object.assign(new Error(`Anam returned ${r.status}: ${msg}`), { status: r.ok ? 502 : r.status });
  }
  return { sessionToken: data.sessionToken };
}

// POST /api/assistant?action=anam-session  body: { brief, contactName }
export async function anamSessionRoute(req, res, supabase, userId, {
  fetchImpl = fetch, env = process.env, getKey = (p) => serverKey(p, env), getAvatar = () => getAnamAvatar(supabase, userId),
  getLlmId = (apiKey, appUrl) => ensureAnamLlm({ supabase, userId, apiKey, appUrl, fetchImpl }),
  getVoiceId = () => getAnamVoiceId(supabase, userId),
} = {}) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const body = req.body || {};
  const brief = String(body.brief || '').slice(0, 2000);
  const contactName = String(body.contactName || '').slice(0, 60);
  try {
    const apiKey = await getKey('anam');
    const avatar = await getAvatar();
    const appUrl = env.PUBLIC_APP_URL || (req.headers?.host ? `https://${req.headers.host}` : '');
    const voiceId = (await getVoiceId()) || '';
    // Anam needs a voice and an LLM with an avatar on this transport. Say what is missing, in plain words.
    if (!voiceId) return res.status(400).json({ error: 'Record or upload your voice first (Settings > Voice). Your Anam avatar speaks with it.' });
    const llmId = apiKey && avatar ? await getLlmId(apiKey, appUrl) : '';
    if (!llmId) return res.status(400).json({ error: 'Your Anam avatar is not picked yet (Settings > Avatar).' });
    const out = await mintAnamSessionToken({
      apiKey,
      personaName: contactName || 'Avatar',
      avatarId: avatar?.id || '',
      voiceId,
      llmId,
      systemPrompt: buildAvatarPrompt(brief, contactName),
      fetchImpl,
    });
    return res.status(200).json(out);
  } catch (err) {
    console.error(`[anam-session] user=${userId} ${err.message}`);
    return res.status(err.status || 500).json({ error: err.message || 'Anam request failed' });
  }
}
