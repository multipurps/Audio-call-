// Telephony transport switch. Twilio stays the default; set TELEPHONY_PROVIDER=telnyx to place calls through Telnyx.
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
  return String(env.TELEPHONY_PROVIDER || '').trim().toLowerCase() === 'telnyx' ? 'telnyx' : 'twilio';
}

// Telnyx call ids look like "v3:KBnLO0..."; Twilio's are "CA" + 32 hex. The relays use this to pick the right hangup
// without needing the provider env var.
export function isTelnyxSid(sid) {
  return /^v\d+:/.test(String(sid || ''));
}

export function telnyxConfigured(env = process.env) {
  return Boolean(env.TELNYX_API_KEY && env.TELNYX_CONNECTION_ID);
}

// ---- Webhook tokens --------------------------------------------------------

function tokenSecret(env) {
  return env.TELNYX_WEBHOOK_SECRET || env.TELNYX_API_KEY || '';
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
  if (!expected) return { ok: true, skipped: 'no TELNYX_API_KEY / TELNYX_WEBHOOK_SECRET' };
  if (!given) return { ok: false, reason: 'missing token' };
  return safeEqual(expected, given) ? { ok: true } : { ok: false, reason: 'token mismatch' };
}

// TELNYX_WEBHOOK_VALIDATION: "warn" (default) logs a bad token and lets the request through while you check real
// traffic in the logs, "enforce" rejects it with 403, "off" skips the check. Same rollout switch as Twilio's.
export function guardTelnyxWebhook(req, res, scope, env = process.env, log = console) {
  const mode = String(env.TELNYX_WEBHOOK_VALIDATION || 'warn').toLowerCase();
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

// ---- Errors ----------------------------------------------------------------

async function readError(resp) {
  const text = await resp.text().catch(() => '');
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  const first = json?.errors?.[0];
  return { status: resp.status, code: first?.code || null, title: first?.title || null, detail: first?.detail || text.slice(0, 300), raw: text.slice(0, 500) };
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
