// Telephony transport switch. SignalWire is the default; set TELEPHONY_PROVIDER=telnyx to place calls through Telnyx.
//
// SignalWire runs the same flow through its Twilio-compatible cXML/LaML API:
//   outbound call  POST https://{SIGNALWIRE_SPACE}/api/laml/2010-04-01/Accounts/{SIGNALWIRE_PROJECT_ID}/Calls.json
//                  (Basic auth, project id : SIGNALWIRE_API_TOKEN)
//   instructions   /api/calls-twiml answers with <Connect><Stream> to the relay. SignalWire does not allow a query
//                  string on the stream URL, so the call id travels in a <Parameter> and arrives in the start frame.
//   hangup         POST .../Calls/{sid}.json  Status=completed
//
// Telnyx runs the same flow through TeXML (its TwiML-compatible call instructions):
//   outbound call  POST https://api.telnyx.com/v2/texml/calls/{TELNYX_CONNECTION_ID}   (Bearer TELNYX_API_KEY)
//   instructions   /api/calls-twiml  answers with <Connect><Stream> to the relay (same as Twilio)
//   status         /api/calls-status gets Twilio-style form fields (CallSid, CallStatus, CallDuration ...)
//   hangup         POST /v2/texml/Accounts/{TELNYX_ACCOUNT_ID}/Calls/{call_sid}  Status=completed
//
// Telnyx webhooks to these URLs are protected with a per-call token in the URL we hand to Telnyx, because the
// TeXML requests are form posts and cannot be signature-checked from the parsed body. See guardTelnyxWebhook.
import crypto from 'node:crypto';

const API = 'https://api.telnyx.com/v2';

export function telephonyProvider(env = process.env) {
  return String(env.TELEPHONY_PROVIDER || '').trim().toLowerCase() === 'telnyx' ? 'telnyx' : 'signalwire';
}

// Telnyx call ids look like "v3:KBnLO0..."; SignalWire's are UUIDs. The relays use this to pick the right hangup
// without needing the provider env var.
export function isTelnyxSid(sid) {
  return /^v\d+:/.test(String(sid || ''));
}

export function telnyxConfigured(env = process.env) {
  return Boolean(env.TELNYX_API_KEY && env.TELNYX_CONNECTION_ID);
}

// ---- Webhook tokens --------------------------------------------------------

function tokenSecret(env) {
  const own = telephonyProvider(env) === 'signalwire' ? env.SIGNALWIRE_API_TOKEN : env.TELNYX_API_KEY;
  return env.TELEPHONY_WEBHOOK_SECRET || env.TELNYX_WEBHOOK_SECRET || own || env.TELNYX_API_KEY || '';
}

export function webhookToken(scope, env = process.env) {
  const secret = tokenSecret(env);
  if (!secret) return '';
  return crypto.createHmac('sha256', secret).update(`telnyx-webhook:${scope}`).digest('hex').slice(0, 32);
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export function checkWebhookToken(scope, given, env = process.env) {
  const expected = webhookToken(scope, env);
  if (!expected) return { ok: true, skipped: 'no SIGNALWIRE_API_TOKEN / TELNYX_API_KEY / TELEPHONY_WEBHOOK_SECRET' };
  if (!given) return { ok: false, reason: 'missing token' };
  return safeEqual(expected, given) ? { ok: true } : { ok: false, reason: 'token mismatch' };
}

// WEBHOOK_VALIDATION (or the older TELNYX_WEBHOOK_VALIDATION): "warn" (default) logs a bad token and lets the request
// through while you check real traffic in the logs, "enforce" rejects it with 403, "off" skips the check.
export function guardTelnyxWebhook(req, res, scope, env = process.env, log = console) {
  const mode = String(env.WEBHOOK_VALIDATION || env.TELNYX_WEBHOOK_VALIDATION || 'warn').toLowerCase();
  if (mode === 'off') return true;
  const result = checkWebhookToken(scope, req.query?.t, env);
  if (result.ok) return true;
  if (mode === 'enforce') {
    log.warn?.(`[telnyx-webhook] rejected ${req.url?.split('?')[0]}: ${result.reason}`);
    res.status(403).send('invalid token');
    return false;
  }
  log.warn?.(`[telnyx-webhook] would reject ${req.url?.split('?')[0]} (warn mode): ${result.reason}`);
  return true;
}

export { guardTelnyxWebhook as guardWebhook };

// ---- Errors ----------------------------------------------------------------

async function readError(resp) {
  const text = await resp.text().catch(() => '');
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  const first = json?.errors?.[0];
  return { status: resp.status, code: first?.code || json?.code || null, title: first?.title || null, detail: first?.detail || json?.message || text.slice(0, 300), raw: text.slice(0, 500) };
}

// ---- Outbound call ---------------------------------------------------------

// Returns { ok:true, sid, status } or { ok:false, status, code, detail }.
export async function telnyxDial({ to, from, callId, appUrl, record = true, ringSeconds = 25 }, env = process.env, fetchImpl = fetch) {
  const connectionId = env.TELNYX_CONNECTION_ID;
  const q = `callId=${encodeURIComponent(callId)}&t=${webhookToken(`call:${callId}`, env)}`;
  const url = `${API}/texml/calls/${encodeURIComponent(connectionId)}`;
  const headers = { Authorization: `Bearer ${env.TELNYX_API_KEY}`, 'Content-Type': 'application/json', Accept: 'application/json' };

  const full = {
    To: to, From: from,
    Url: `${appUrl}/api/calls-twiml?${q}`, UrlMethod: 'POST',
    StatusCallback: `${appUrl}/api/calls-status?${q}`, StatusCallbackMethod: 'POST',
    StatusCallbackEvent: 'initiated ringing answered completed',
    Timeout: ringSeconds,
    MachineDetection: 'Enable', // calls-twiml.js hangs up on voicemail instead of connecting the relay
    Record: Boolean(record),
  };
  // If Telnyx rejects an optional field, retry with the smallest request that still carries our two callbacks.
  const minimal = { To: to, From: from, Url: full.Url, Method: 'POST', StatusCallback: full.StatusCallback };

  let last = null;
  for (const body of [full, minimal]) {
    const resp = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body) });
    if (resp.ok) {
      const data = await resp.json().catch(() => ({}));
      const sid = data.call_sid || data.sid || data.data?.call_sid || data.data?.sid || null;
      return { ok: true, sid, status: data.status || data.data?.status || 'queued' };
    }
    last = await readError(resp);
    if (![400, 422].includes(resp.status)) break; // auth, balance, network: a smaller body will not help
  }
  return { ok: false, ...last };
}

// ---- Hang up ---------------------------------------------------------------

// accountId: TELNYX_ACCOUNT_ID, or the user_id Telnyx puts in the stream's start frame when the env var is not set.
export async function telnyxHangup(sid, { accountId, env = process.env, fetchImpl = fetch } = {}) {
  const account = env.TELNYX_ACCOUNT_ID || accountId;
  if (!env.TELNYX_API_KEY || !account || !sid) return { ok: false, status: 0, detail: 'telnyx hangup not configured (TELNYX_API_KEY, TELNYX_ACCOUNT_ID)' };
  const resp = await fetchImpl(`${API}/texml/Accounts/${encodeURIComponent(account)}/Calls/${encodeURIComponent(sid)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.TELNYX_API_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ Status: 'completed' }),
  });
  if (resp.ok) return { ok: true, status: resp.status };
  return { ok: false, ...(await readError(resp)) };
}

// ---- SignalWire (Twilio-compatible LaML REST API) ---------------------------

export function signalwireConfigured(env = process.env) {
  return Boolean(env.SIGNALWIRE_SPACE && env.SIGNALWIRE_PROJECT_ID && env.SIGNALWIRE_API_TOKEN);
}

// "octopusfur.signalwire.com" (a pasted https:// prefix or trailing slash is tolerated).
function signalwireHost(env) {
  return String(env.SIGNALWIRE_SPACE || '').trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
}

export function lamlBase(env = process.env) {
  return `https://${signalwireHost(env)}/api/laml/2010-04-01/Accounts/${encodeURIComponent(env.SIGNALWIRE_PROJECT_ID || '')}`;
}

export function lamlAuthHeader(env = process.env) {
  return 'Basic ' + Buffer.from(`${env.SIGNALWIRE_PROJECT_ID}:${env.SIGNALWIRE_API_TOKEN}`).toString('base64');
}

// Any LaML REST call (numbers, caller ids, calls). `path` is relative to the account, e.g. "Calls.json".
// Returns the parsed JSON; throws an Error with .statusCode and .code when SignalWire refuses.
export async function lamlRequest(path, { method = 'GET', body, env = process.env, fetchImpl = fetch, timeoutMs = 20_000 } = {}) {
  const resp = await fetchImpl(`${lamlBase(env)}/${path}`, {
    method,
    headers: {
      Authorization: lamlAuthHeader(env),
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    body: body ? new URLSearchParams(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (resp.status === 204) return {};
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const err = new Error(data.message || `SignalWire request failed (${resp.status})`);
    err.code = data.code;
    err.statusCode = resp.status;
    throw err;
  }
  return data;
}

// SignalWire's own REST API (JSON), used for verified caller IDs, which the LaML API does not offer.
// `path` is relative to /api/relay/rest/, e.g. "verified_caller_ids". Throws like lamlRequest.
export async function relayRestRequest(path, { method = 'GET', body, env = process.env, fetchImpl = fetch, timeoutMs = 20_000 } = {}) {
  const resp = await fetchImpl(`https://${signalwireHost(env)}/api/relay/rest/${path}`, {
    method,
    headers: {
      Authorization: lamlAuthHeader(env),
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (resp.status === 204) return {};
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const first = Array.isArray(data.errors) ? data.errors[0] : null;
    const detail = typeof first === 'string' ? first : first?.detail || first?.message;
    const err = new Error(detail || data.message || `SignalWire request failed (${resp.status})`);
    err.code = (first && typeof first === 'object' && first.code) || data.code;
    err.statusCode = resp.status;
    throw err;
  }
  return data;
}

// Returns { ok:true, sid, status } or { ok:false, status, code, detail }.
export async function signalwireDial({ to, from, callId, appUrl, record = true, ringSeconds = 25 }, env = process.env, fetchImpl = fetch) {
  const q = `callId=${encodeURIComponent(callId)}&t=${webhookToken(`call:${callId}`, env)}`;
  const resp = await fetchImpl(`${lamlBase(env)}/Calls.json`, {
    method: 'POST',
    headers: { Authorization: lamlAuthHeader(env), 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      To: to,
      From: from,
      Url: `${appUrl}/api/calls-twiml?${q}`,
      StatusCallback: `${appUrl}/api/calls-status?${q}`,
      StatusCallbackEvent: 'initiated ringing answered completed',
      Record: record ? 'true' : 'false',
      Timeout: String(ringSeconds),
      MachineDetection: 'Enable', // calls-twiml.js hangs up on voicemail instead of connecting the relay
    }),
  });
  if (resp.ok) {
    const data = await resp.json().catch(() => ({}));
    return { ok: true, sid: data.sid || null, status: data.status || 'queued' };
  }
  return { ok: false, ...(await readError(resp)) };
}

export async function signalwireHangup(sid, { env = process.env, fetchImpl = fetch } = {}) {
  if (!signalwireConfigured(env) || !sid) return { ok: false, status: 0, detail: 'signalwire hangup not configured (SIGNALWIRE_SPACE, SIGNALWIRE_PROJECT_ID, SIGNALWIRE_API_TOKEN)' };
  const resp = await fetchImpl(`${lamlBase(env)}/Calls/${encodeURIComponent(sid)}.json`, {
    method: 'POST',
    headers: { Authorization: lamlAuthHeader(env), 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ Status: 'completed' }),
  });
  if (resp.ok) return { ok: true, status: resp.status };
  return { ok: false, ...(await readError(resp)) };
}

// Hang up a phone call on whichever provider placed it (picked from the call id's shape, so no env switch is needed).
export function hangupCall(sid, { accountId, env = process.env, fetchImpl = fetch } = {}) {
  return isTelnyxSid(sid)
    ? telnyxHangup(sid, { accountId, env, fetchImpl })
    : signalwireHangup(sid, { env, fetchImpl });
}
