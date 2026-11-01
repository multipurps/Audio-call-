// Links the Emysa brain and the user's own voice to their Anam avatar.
//  - LLM: each person gets one Anam custom LLM that points at /anam-llm on this app. Anam calls it
//    with OpenAI-style chat requests; the reply comes from the same brain and memory as the app.
//    The LLM secret is an HMAC of the person's id, made with the server's ANAM_API_KEY, so nothing
//    is stored for it and the endpoint can tell which person is calling.
//  - Voice: the recording the person made or uploaded is cloned at Anam (separately from Inworld).
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { serverKey } from './serverKeys.js';
import { generateChatCompletion } from './llmClient.js';
import { buildSystemPrompt } from './appBrain.js';
import { formatEmotionStateBlock } from './emotionEngine.js';
import { prepareTurnContext } from './memoryManager.js';
import { LANGUAGE_NAMES } from './callLanguages.js';
import { stripSpeechMarkers } from './voiceChoice.js';

const ANAM = 'https://api.anam.ai/v1';
export const ANAM_LLM_PATH = '/anam-llm';
const MAX_SAMPLE_BYTES = 4.5 * 1024 * 1024;

export function anamLlmSecret(userId, apiKey) {
  const sig = createHmac('sha256', apiKey).update(`anam-llm:${userId}`).digest('hex');
  return `${userId}.${sig}`;
}

export function userFromAnamLlmSecret(token, apiKey) {
  if (!apiKey || typeof token !== 'string') return null;
  const [userId, sig] = token.split('.');
  if (!userId || !sig) return null;
  const expected = anamLlmSecret(userId, apiKey).split('.')[1];
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return userId;
}

// The person's Anam LLM id. Registered once, then reused.
export async function ensureAnamLlm({ supabase, userId, apiKey, appUrl, fetchImpl = fetch }) {
  const { data } = await supabase.from('user_video_settings').select('anam_llm_id').eq('user_id', userId).maybeSingle();
  if (data?.anam_llm_id) return data.anam_llm_id;
  if (!appUrl) throw Object.assign(new Error('The app address is not known to register the brain with Anam.'), { status: 500 });
  const r = await fetchImpl(`${ANAM}/llms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      displayName: `Emysa brain ${userId.slice(0, 8)}`,
      description: 'Emysa brain for video calls: app model, memory and emotion',
      urls: [{ url: `${appUrl}${ANAM_LLM_PATH}` }],
      llmFormat: 'openai',
      modelName: 'emysa-brain',
      secret: anamLlmSecret(userId, apiKey),
    }),
  });
  const raw = await r.text();
  let d = null;
  try { d = JSON.parse(raw); } catch { /* not JSON */ }
  if (!r.ok || !d?.id) {
    const msg = (d && (d.message || d.error)) || raw.slice(0, 160) || 'no body';
    throw Object.assign(new Error(`Anam did not register your brain (${r.status}): ${msg}`), { status: r.ok ? 502 : r.status });
  }
  await supabase.from('user_video_settings').upsert(
    { user_id: userId, anam_llm_id: d.id, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
  return d.id;
}

export async function getAnamVoiceId(supabase, userId) {
  const { data } = await supabase.from('user_video_settings').select('anam_voice_id').eq('user_id', userId).maybeSingle();
  return data?.anam_voice_id || null;
}

// POST ?action=anam-voice body { sample: { type, data(base64) } } -> clones the person's voice at Anam
export async function anamVoiceRoute(req, res, supabase, userId, { fetchImpl = fetch, env = process.env } = {}) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const apiKey = serverKey('anam', env);
  if (!apiKey) return res.status(500).json({ error: 'ANAM_API_KEY is not set on the server.' });
  const b64 = req.body?.sample?.data;
  if (typeof b64 !== 'string' || !b64) return res.status(400).json({ error: 'No recording received.' });
  const buf = Buffer.from(b64, 'base64');
  if (!buf.length) return res.status(400).json({ error: 'The recording is empty.' });
  if (buf.length > MAX_SAMPLE_BYTES) return res.status(400).json({ error: 'Anam accepts recordings up to 4.5 MB. Record a shorter sample.' });

  const { data: profile } = await supabase.from('profiles').select('name').eq('user_id', userId).maybeSingle();
  const name = `${String(profile?.name || 'My').replace(/\s+/g, ' ').trim().slice(0, 50)} voice`;
  const form = new FormData();
  form.append('name', name);
  form.append('audioFile', new Blob([buf], { type: 'audio/wav' }), 'voice.wav');
  try {
    const r = await fetchImpl(`${ANAM}/voices`, { method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: form });
    const raw = await r.text();
    let d = null;
    try { d = JSON.parse(raw); } catch { /* not JSON */ }
    if (!r.ok || !d?.id) {
      const msg = (d && (d.message || d.error)) || raw.slice(0, 160) || 'no body';
      return res.status(r.ok ? 502 : r.status).json({ error: `Anam did not clone your voice (${r.status}): ${msg}` });
    }
    const { error } = await supabase.from('user_video_settings').upsert(
      { user_id: userId, anam_voice_id: d.id, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
    if (error) return res.status(500).json({ error: 'Anam cloned your voice but it could not be saved. Try again.' });
    return res.status(201).json({ voice: { id: d.id, name } });
  } catch (err) {
    console.error(`[anam-voice] user=${userId} ${err.message}`);
    return res.status(502).json({ error: 'Could not reach Anam. Try again.' });
  }
}

// POST /anam-llm (OpenAI chat format from Anam). Replies with the Emysa brain, streamed.
export async function anamLlmRoute(req, res, supabase, { env = process.env, generate = generateChatCompletion } = {}) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const apiKey = serverKey('anam', env);
  if (!apiKey) return res.status(500).json({ error: 'ANAM_API_KEY is not set on the server.' });
  const token = String(req.headers?.authorization || '').replace(/^Bearer\s+/i, '');
  const userId = userFromAnamLlmSecret(token, apiKey);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  const incoming = Array.isArray(req.body?.messages) ? req.body.messages : [];
  const brief = incoming.filter((m) => m?.role === 'system').map((m) => String(m.content || '')).join('\n').slice(0, 4000);
  const convo = incoming.filter((m) => m && m.role !== 'system').slice(-20)
    .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '').slice(0, 2000) }));
  const lastUser = [...convo].reverse().find((m) => m.role === 'user')?.content || '';

  try {
    const [{ data: profile }, { data: contacts }, turn] = await Promise.all([
      supabase.from('profiles').select('language').eq('user_id', userId).maybeSingle(),
      supabase.from('contacts').select('name').eq('user_id', userId),
      prepareTurnContext({ supabase, userId, userText: lastUser, isVoiceCall: true }),
    ]);
    const system = buildSystemPrompt({
      userLanguage: LANGUAGE_NAMES[profile?.language] || 'English',
      contactsList: (contacts || []).map((c) => `- ${c.name}`).join('\n') || '(no contacts saved yet)',
      memoryPromptBlock: turn.memoryBundle?.promptBlock || '',
      emotionBlock: formatEmotionStateBlock(turn.emotionState),
      isVoiceCall: true,
    });
    const messages = [{ role: 'system', content: system }];
    if (brief) messages.push({ role: 'system', content: `Brief for this call (what the person wants said): ${brief}` });
    messages.push(...convo);

    const out = await generate({ messages, temperature: 0.6, max_tokens: 220, env });
    let text = stripSpeechMarkers(String(out?.content || '')).trim();
    // Guard: if the brain still answers in its JSON format, speak only its reply text.
    if (text.startsWith('{')) { try { text = String(JSON.parse(text).reply || JSON.parse(text).message || '').trim(); } catch { /* keep text */ } }
    if (!text) throw new Error('empty reply');
    // Remember what the person said on the call (best effort, after the reply is sent).
    Promise.resolve().then(() => turn.commitTurn?.({})).catch((e) => console.error(`[anam-llm] memory user=${userId} ${e.message}`));

    const id = `chatcmpl-${randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);
    const model = 'emysa-brain';
    if (req.body?.stream === false) {
      return res.status(200).json({ id, object: 'chat.completion', created, model,
        choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }] });
    }
    const chunk = (delta, finish) => `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.status(200);
    res.write(chunk({ role: 'assistant', content: text }, null));
    res.write(chunk({}, 'stop'));
    res.write('data: [DONE]\n\n');
    return res.end();
  } catch (err) {
    console.error(`[anam-llm] user=${userId} ${err.message}`);
    return res.status(502).json({ error: 'The brain could not answer. Try again.' });
  }
}
