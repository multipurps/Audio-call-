// The audio app's server side of the WaCalls on Fly (wacalls/ in this repo). Audio and video
// calls share one WhatsApp link and one session. The browser does the media; this only calls the
// WaCalls API. Settings (server env only):
//   WACALLS_FLY_URL        e.g. https://wacalls-zeeyus12.fly.dev
//   WACALLS_FLY_API_KEY    the same value as WACALLS_API_KEY on the WaCalls app
//   WACALLS_FLY_SESSION_ID the paired session id on that WaCalls
// These are separate from the Render WACALLS_RELAY_* settings, which stay untouched.

export function flyConfig(env = process.env) {
  const baseUrl = String(env.WACALLS_FLY_URL || '').replace(/\/+$/, '');
  const apiKey = String(env.WACALLS_FLY_API_KEY || '');
  const sessionId = String(env.WACALLS_FLY_SESSION_ID || '');
  if (!baseUrl || !apiKey || !sessionId) {
    throw Object.assign(new Error('WaCalls on Fly is not configured (WACALLS_FLY_URL, WACALLS_FLY_API_KEY, WACALLS_FLY_SESSION_ID).'), { status: 500 });
  }
  return { baseUrl, apiKey, sessionId };
}

async function flyFetch(env, path, { method = 'GET', body, fetchImpl = fetch } = {}) {
  const { baseUrl, apiKey } = flyConfig(env);
  const headers = { 'X-API-Key': apiKey };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const r = await fetchImpl(`${baseUrl}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const raw = await r.text();
  let data = null;
  try { data = raw ? JSON.parse(raw) : null; } catch { /* not JSON */ }
  if (!r.ok) {
    const msg = (data && data.error) || raw.slice(0, 200) || 'no detail';
    throw Object.assign(new Error(`WaCalls ${method} ${path} failed (HTTP ${r.status}): ${msg}`), { status: r.status });
  }
  return data;
}

const callPath = (sessionId, callId = '') => `/api/sessions/${encodeURIComponent(sessionId)}/calls${callId ? `/${encodeURIComponent(callId)}` : ''}`;

// Starts a WhatsApp call to `phone`, audio or video. Returns the call id.
export async function startFlyCall({ phone, video = false, env = process.env, fetchImpl } = {}) {
  const { sessionId } = flyConfig(env);
  if (!phone) throw Object.assign(new Error('phone is required'), { status: 400 });
  const data = await flyFetch(env, callPath(sessionId), { method: 'POST', body: { phone, video: !!video }, fetchImpl });
  const callId = data?.call?.callId;
  if (!callId) throw new Error('WaCalls did not return a call id');
  return { callId };
}

// Sends the browser's SDP offer and returns WaCalls' answer. Renegotiate is for an audio call that
// becomes video mid-call.
export async function submitFlyOffer({ callId, sdpOffer, renegotiate = false, env = process.env, fetchImpl } = {}) {
  const { sessionId } = flyConfig(env);
  if (!callId || !sdpOffer) throw Object.assign(new Error('callId and sdpOffer are required'), { status: 400 });
  const suffix = renegotiate ? '/webrtc/renegotiate' : '/webrtc';
  const data = await flyFetch(env, `${callPath(sessionId, callId)}${suffix}`, { method: 'POST', body: { sdp_offer: sdpOffer }, fetchImpl });
  if (!data?.sdp_answer) throw new Error('WaCalls did not return an SDP answer');
  return { sdpAnswer: data.sdp_answer };
}

export async function flyVideoStart({ callId, env = process.env, fetchImpl } = {}) {
  const { sessionId } = flyConfig(env);
  return flyFetch(env, `${callPath(sessionId, callId)}/video/start`, { method: 'POST', fetchImpl });
}

export async function flyVideoAccept({ callId, env = process.env, fetchImpl } = {}) {
  const { sessionId } = flyConfig(env);
  return flyFetch(env, `${callPath(sessionId, callId)}/video/accept`, { method: 'POST', fetchImpl });
}

export async function flyVideoStop({ callId, env = process.env, fetchImpl } = {}) {
  const { sessionId } = flyConfig(env);
  return flyFetch(env, `${callPath(sessionId, callId)}/video/stop`, { method: 'POST', fetchImpl });
}

export async function flyEndCall({ callId, env = process.env, fetchImpl } = {}) {
  const { sessionId } = flyConfig(env);
  return flyFetch(env, callPath(sessionId, callId), { method: 'DELETE', fetchImpl });
}
