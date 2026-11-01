// Anam avatar for the video call. The Anam API key is read on the server (admin
// `ANAM_API_KEY` or the Render env var) and only a short session token goes to the browser.
// The avatar id is an owner setting (admin, or ANAM_AVATAR_ID on the server). Voice and LLM
// ids are optional env vars (ANAM_VOICE_ID, ANAM_LLM_ID); Anam's defaults are used when unset.
import { getSecret } from './secrets.js';

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
  if (!apiKey) throw Object.assign(new Error('The Anam key is not set yet. Ask the owner to add it in admin or on Render.'), { status: 400 });
  if (!avatarId) throw Object.assign(new Error('Your Anam avatar ID is not set. Add it in admin (Anam avatar ID).'), { status: 400 });
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
export async function anamSessionRoute(req, res, supabase, userId, { fetchImpl = fetch, env = process.env } = {}) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const body = req.body || {};
  const brief = String(body.brief || '').slice(0, 2000);
  const contactName = String(body.contactName || '').slice(0, 60);
  try {
    const apiKey = await getSecret(supabase, 'ANAM_API_KEY', env);
    const out = await mintAnamSessionToken({
      apiKey,
      personaName: contactName || 'Avatar',
      avatarId: (await getSecret(supabase, 'ANAM_AVATAR_ID', env)) || '',
      voiceId: env.ANAM_VOICE_ID || '',
      llmId: env.ANAM_LLM_ID || '',
      systemPrompt: buildAvatarPrompt(brief, contactName),
      fetchImpl,
    });
    return res.status(200).json(out);
  } catch (err) {
    console.error(`[anam-session] user=${userId} ${err.message}`);
    return res.status(err.status || 500).json({ error: err.message || 'Anam request failed' });
  }
}
