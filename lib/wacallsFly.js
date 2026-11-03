// Client for the WaCalls service on Fly (wacalls/ in this repo). One WaCalls serves every user:
// each user has their own session (whatsapp_accounts.wacalls_session_id) and the same routes
// serve audio and video calls. Server env only:
//   WACALLS_FLY_URL      e.g. https://<your-emysa-app>.fly.dev
//   WACALLS_FLY_API_KEY  the same value as WACALLS_API_KEY on the WaCalls app
// Routes and response shapes were checked against wacalls/cmd/server/httpapi.go.

import QRCode from 'qrcode';

export function flyEnabled(env = process.env) {
  return Boolean(env.WACALLS_FLY_URL && env.WACALLS_FLY_API_KEY);
}

export function flyConfig(env = process.env) {
  const baseUrl = String(env.WACALLS_FLY_URL || '').replace(/\/+$/, '');
  const apiKey = String(env.WACALLS_FLY_API_KEY || '');
  if (!baseUrl || !apiKey) {
    throw Object.assign(new Error('WaCalls on Fly is not configured (WACALLS_FLY_URL, WACALLS_FLY_API_KEY).'), { status: 500 });
  }
  return { baseUrl, apiKey };
}

// clientId is the signed-in person. WaCalls counts each X-Client-Id as one operator, so without it every
// person shares one operator and one person's call blocks everyone else's (409 operator already on a call).
async function flyFetch(env, path, { method = 'GET', body, fetchImpl = fetch, timeoutMs = 20_000, clientId } = {}) {
  const { baseUrl, apiKey } = flyConfig(env);
  const headers = { 'X-API-Key': apiKey };
  if (clientId) headers['X-Client-Id'] = String(clientId);
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const r = await fetchImpl(`${baseUrl}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const raw = await r.text();
  let data = null;
  try { data = raw ? JSON.parse(raw) : null; } catch { /* not JSON */ }
  if (!r.ok) {
    const msg = (data && data.error) || raw.slice(0, 200) || 'no detail';
    throw Object.assign(new Error(`WaCalls ${method} ${path} failed (HTTP ${r.status}): ${msg}`), { statusCode: r.status, fromRelay: Boolean(data?.error) });
  }
  return data;
}

const sessionPath = (sid, rest = '') => `/api/sessions/${encodeURIComponent(sid)}${rest}`;
const callPath = (sid, callId = '') => sessionPath(sid, `/calls${callId ? `/${encodeURIComponent(callId)}` : ''}`);

// ---- sessions (WhatsApp link) ----

export async function flyCreateSession({ name, env = process.env, fetchImpl } = {}) {
  const data = await flyFetch(env, '/api/sessions', { method: 'POST', body: { name: name || 'Session' }, fetchImpl });
  if (!data?.id) throw new Error('WaCalls did not return a session id');
  return { id: data.id };
}

export async function flyListSessions({ env = process.env, fetchImpl } = {}) {
  const data = await flyFetch(env, '/api/sessions', { fetchImpl });
  return Array.isArray(data?.sessions) ? data.sessions : [];
}

export async function flyStartPairing({ sid, env = process.env, fetchImpl } = {}) {
  await flyFetch(env, sessionPath(sid, '/pair'), { method: 'POST', fetchImpl });
}

// Phone-number linking. Returns the code the person types into WhatsApp.
export async function flyPairPhone({ sid, phone, env = process.env, fetchImpl } = {}) {
  if (!phone) throw Object.assign(new Error('phone is required'), { statusCode: 400 });
  const data = await flyFetch(env, sessionPath(sid, '/pair-phone'), { method: 'POST', body: { phone }, fetchImpl });
  return { code: data?.code || null };
}

export async function flyDeleteSession({ sid, env = process.env, fetchImpl } = {}) {
  await flyFetch(env, sessionPath(sid), { method: 'DELETE', fetchImpl });
}

// The QR is never returned by a GET: WaCalls pushes it on its event stream. Open the stream,
// wait for the next session-qr for this session, and return it as a PNG data URL. Gives up
// after timeoutMs and returns null (the caller shows "not yet" and asks again).
export async function flyWaitForQr({ sid, timeoutMs = 15_000, env = process.env, fetchImpl = fetch } = {}) {
  const { baseUrl, apiKey } = flyConfig(env);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetchImpl(`${baseUrl}/api/events`, { headers: { 'X-API-Key': apiKey, Accept: 'text/event-stream' }, signal: controller.signal });
    if (!r.ok || !r.body) throw Object.assign(new Error(`WaCalls event stream failed (HTTP ${r.status})`), { statusCode: r.status || 502 });
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const line = frame.split('\n').find((l) => l.startsWith('data: '));
        if (!line) continue;
        let ev;
        try { ev = JSON.parse(line.slice(6)); } catch { continue; }
        if (ev.type === 'session-qr' && ev.sessionId === sid && ev.qr) {
          controller.abort();
          return await QRCode.toDataURL(ev.qr, { margin: 1, width: 320 });
        }
      }
    }
    return null;
  } catch (err) {
    if (controller.signal.aborted) return null; // timed out waiting: not an error
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// Session detail in the shape the app reads: { id, paired, state, jid, qr, code }.
// Starts QR pairing only when the session is not paired and not already waiting for a code or QR.
export async function flySessionDetail({ sid, timeoutMs = 15_000, env = process.env, fetchImpl } = {}) {
  const sessions = await flyListSessions({ env, fetchImpl });
  const s = sessions.find((x) => x.id === sid);
  if (!s) throw Object.assign(new Error('no such WhatsApp session on WaCalls'), { statusCode: 404 });
  if (s.paired) return { id: sid, paired: true, state: 'open', jid: s.jid || null, qr: null, code: null };
  if (s.state === 'code') return { id: sid, paired: false, state: 'code', jid: null, qr: null, code: null };
  if (s.state !== 'qr') await flyStartPairing({ sid, env, fetchImpl });
  const qr = await flyWaitForQr({ sid, timeoutMs, env, fetchImpl });
  return { id: sid, paired: false, state: 'qr', jid: null, qr, code: null };
}

// ---- calls ----

export async function startFlyCall({ sid, phone, video = false, env = process.env, fetchImpl, clientId } = {}) {
  if (!phone) throw Object.assign(new Error('phone is required'), { statusCode: 400 });
  const data = await flyFetch(env, callPath(sid), { method: 'POST', body: { phone, video: !!video }, fetchImpl, clientId });
  const callId = data?.call?.callId;
  if (!callId) throw new Error('WaCalls did not return a call id');
  return { callId };
}

// Sends the browser's SDP offer and returns WaCalls' answer. Renegotiate is for an audio call
// that becomes video mid-call.
export async function submitFlyOffer({ sid, callId, sdpOffer, renegotiate = false, env = process.env, fetchImpl, clientId } = {}) {
  if (!callId || !sdpOffer) throw Object.assign(new Error('callId and sdpOffer are required'), { statusCode: 400 });
  const suffix = renegotiate ? '/webrtc/renegotiate' : '/webrtc';
  const data = await flyFetch(env, `${callPath(sid, callId)}${suffix}`, { method: 'POST', body: { sdp_offer: sdpOffer }, fetchImpl, clientId });
  if (!data?.sdp_answer) throw new Error('WaCalls did not return an SDP answer');
  return { sdpAnswer: data.sdp_answer };
}

export async function flyVideoStart({ sid, callId, env = process.env, fetchImpl, clientId } = {}) {
  return flyFetch(env, `${callPath(sid, callId)}/video/start`, { method: 'POST', fetchImpl, clientId });
}

export async function flyVideoAccept({ sid, callId, env = process.env, fetchImpl, clientId } = {}) {
  return flyFetch(env, `${callPath(sid, callId)}/video/accept`, { method: 'POST', fetchImpl, clientId });
}

export async function flyVideoStop({ sid, callId, env = process.env, fetchImpl, clientId } = {}) {
  return flyFetch(env, `${callPath(sid, callId)}/video/stop`, { method: 'POST', fetchImpl, clientId });
}

// Ends and forgets every call on the session ("unstick"). Used when WaCalls still counts an old call as live.
export async function flyClearCalls({ sid, env = process.env, fetchImpl, clientId } = {}) {
  const data = await flyFetch(env, callPath(sid), { method: 'DELETE', fetchImpl, clientId });
  return { cleared: data?.cleared ?? 0 };
}

// The call's state as WaCalls reports it: initiating | ringing | active | ended (active = picked up).
export async function flyCallState({ sid, callId, env = process.env, fetchImpl, clientId } = {}) {
  const data = await flyFetch(env, callPath(sid, callId), { fetchImpl, clientId });
  return { state: data?.state || 'unknown' };
}

export async function flyEndCall({ sid, callId, env = process.env, fetchImpl, clientId } = {}) {
  return flyFetch(env, callPath(sid, callId), { method: 'DELETE', fetchImpl, clientId });
}
