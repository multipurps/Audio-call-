// Xmax (X2.1) realtime: the browser never sees the platform's permanent key.
// This route mints a short-lived TEMPORARY key (tk-...) for a call and can deactivate it when
// the call ends. The permanent key is XMAX_API_KEY on the server. It never reaches the browser.
import { serverKey } from './userKeys.js';

export const XMAX_BASE_URL = 'https://api.xmax.ai/open/api/v1';
export const XMAX_TEMP_KEY_RE = /^tk-[A-Za-z0-9_-]+$/;

export function xmaxPointsLimit(env = process.env) {
  const n = Number(env.XMAX_POINTS_LIMIT);
  return Number.isFinite(n) && n >= 1 && n <= 10000 ? Math.floor(n) : 3000;
}

export async function mintXmaxTemporaryKey({ permanentKey, pointsLimit = 3000, expireSeconds = 3600, fetchImpl = fetch }) {
  const r = await fetchImpl(`${XMAX_BASE_URL}/temporary-api-key`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Api-Key': permanentKey },
    body: JSON.stringify({ expireSeconds, pointsLimit, temporaryApiKeySessionLimit: 1 }),
  });
  const raw = await r.text();
  let data = null;
  try { data = JSON.parse(raw); } catch { /* not JSON */ }
  const d = data && data.data;
  if (!r.ok || !data || !data.success || !d || !XMAX_TEMP_KEY_RE.test(d.temporaryApiKey || '')) {
    const msg = (data && (data.message || data.error)) || raw.slice(0, 200) || 'no body';
    const err = new Error(`Xmax returned ${r.status}: ${msg}`);
    err.status = r.ok ? 502 : r.status;
    throw err;
  }
  return { temporaryApiKey: d.temporaryApiKey, expireTimestamp: d.expireTimestamp || null };
}

export async function revokeXmaxTemporaryKey({ permanentKey, temporaryApiKey, fetchImpl = fetch }) {
  const r = await fetchImpl(`${XMAX_BASE_URL}/temporary-api-key/${encodeURIComponent(temporaryApiKey)}/inactive`, {
    method: 'PUT',
    headers: { 'X-Api-Key': permanentKey },
  });
  return r.ok;
}

// POST /api/assistant?action=xmax-token  body: { op: 'mint' } or { op: 'revoke', temporaryApiKey }
export async function xmaxTokenRoute(req, res, supabase, userId, { fetchImpl = fetch, env = process.env, getKey = () => serverKey('xmax', env) } = {}) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const permanentKey = await getKey('xmax');
  if (!permanentKey) return res.status(400).json({ error: 'XMAX_API_KEY is not set on the server.' });
  const body = req.body || {};
  try {
    if (body.op === 'revoke') {
      if (!XMAX_TEMP_KEY_RE.test(String(body.temporaryApiKey || ''))) return res.status(400).json({ error: 'Bad temporary key' });
      await revokeXmaxTemporaryKey({ permanentKey, temporaryApiKey: body.temporaryApiKey, fetchImpl });
      return res.status(200).json({ ok: true });
    }
    if (body.op !== 'mint') return res.status(400).json({ error: 'op must be mint or revoke' });
    const tk = await mintXmaxTemporaryKey({ permanentKey, pointsLimit: xmaxPointsLimit(env), fetchImpl });
    return res.status(200).json(tk);
  } catch (err) {
    console.error(`[xmax-token] user=${userId} ${err.message}`);
    return res.status(err.status || 500).json({ error: err.message || 'Xmax request failed' });
  }
}
