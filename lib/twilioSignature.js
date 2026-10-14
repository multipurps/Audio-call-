// Twilio request validation for the webhook routes (calls-incoming, calls-twiml,
// calls-status). Twilio signs every webhook: X-Twilio-Signature =
// base64(HMAC-SHA1(authToken, fullUrl + each POST param as name+value, sorted by name)).
// Without this check anyone who can reach the URL can forge call state or open a call
// session for a user (see tests/twilio-signature.test.mjs).
//
// Rollout switch TWILIO_WEBHOOK_VALIDATION:
//   unset / "warn"  validate and log a bad signature, but let the request through, so real
//                   Twilio traffic can be checked in the logs before anything is rejected
//   "enforce"       reject a bad or missing signature with 403
//   "off"           skip validation
import crypto from 'node:crypto';

export function twilioSignatureFor(authToken, url, params = {}) {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + (Array.isArray(params[key]) ? params[key].join('') : String(params[key] ?? '')), url);
  return crypto.createHmac('sha1', authToken).update(Buffer.from(data, 'utf-8')).digest('base64');
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function bodyParams(req) {
  const body = req.body;
  if (body && typeof body === 'object' && !Buffer.isBuffer(body)) return body;
  if (typeof body === 'string' && body) return Object.fromEntries(new URLSearchParams(body));
  return {};
}

// The URLs Twilio may have signed: the one we gave it (PUBLIC_APP_URL) and the one this
// request actually arrived on.
export function candidateUrls(req, env = process.env) {
  const path = req.url || '';
  const urls = [];
  const configured = String(env.PUBLIC_APP_URL || '').replace(/\/+$/, '');
  if (configured) urls.push(configured + path);
  const host = req.headers?.['x-forwarded-host'] || req.headers?.host;
  if (host) urls.push(`https://${String(host).split(',')[0].trim()}${path}`);
  return [...new Set(urls)];
}

export function checkTwilioSignature(req, env = process.env) {
  const authToken = env.TWILIO_AUTH_TOKEN;
  if (!authToken) return { ok: true, skipped: 'no TWILIO_AUTH_TOKEN' };
  const given = req.headers?.['x-twilio-signature'];
  if (!given) return { ok: false, reason: 'missing signature' };
  const params = bodyParams(req);
  const match = candidateUrls(req, env).some((url) => safeEqual(twilioSignatureFor(authToken, url, params), given));
  return match ? { ok: true } : { ok: false, reason: 'signature mismatch' };
}

// Returns true when the handler may continue. When it returns false the response is sent.
export function guardTwilioWebhook(req, res, env = process.env, log = console) {
  const mode = String(env.TWILIO_WEBHOOK_VALIDATION || 'warn').toLowerCase();
  if (mode === 'off') return true;
  const result = checkTwilioSignature(req, env);
  if (result.ok) return true;
  if (mode === 'enforce') {
    log.warn?.(`[twilio-signature] rejected ${req.url?.split('?')[0]}: ${result.reason}`);
    res.status(403).send('invalid signature');
    return false;
  }
  log.warn?.(`[twilio-signature] would reject ${req.url?.split('?')[0]} (warn mode): ${result.reason}`);
  return true;
}
