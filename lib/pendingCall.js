// A call the assistant has decided to place, waiting for its spoken/written reply
// to be delivered first.
//
// The chat request resolves everything (who, which line, what to say) and answers
// with the natural reply plus this signed token; it does not dial. The app shows
// the reply, then sends the token back and only that second request places the
// call. The token is self-contained, so no table is needed, and it is signed so
// it can only ever describe a call the server itself resolved for this user.
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

export const PENDING_CALL_TTL_SECS = 180;

function secret(env = process.env) {
  return env.PENDING_CALL_SECRET || env.ASSISTANT_BRIDGE_SECRET || env.SUPABASE_SERVICE_ROLE_KEY || '';
}

const b64 = (s) => Buffer.from(s).toString('base64url');
const sign = (body, env) => createHmac('sha256', secret(env)).update(body).digest('base64url');

export function signPendingCall(payload, { env = process.env, now = Date.now() } = {}) {
  if (!secret(env)) throw new Error('No signing secret configured for pending calls');
  const iat = Math.floor(now / 1000);
  const body = b64(JSON.stringify({ v: 1, ...payload, nonce: randomUUID(), iat, exp: iat + PENDING_CALL_TTL_SECS }));
  return `${body}.${sign(body, env)}`;
}

// Returns the payload, or null if forged, expired, or issued to someone else.
export function verifyPendingCall(token, userId, { env = process.env, now = Date.now() } = {}) {
  try {
    if (typeof token !== 'string' || !secret(env)) return null;
    const [body, sig] = token.split('.');
    if (!body || !sig) return null;
    const expected = sign(body, env);
    if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (payload.v !== 1 || payload.uid !== userId) return null;
    if (Math.floor(now / 1000) > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}
