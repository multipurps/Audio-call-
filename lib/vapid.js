// One place that decides which VAPID keys push uses, and one place that explains a failed push.
//
// Why the public key is derived from the private key: a device subscribes with the PUBLIC key, and every
// push is signed with the PRIVATE key. If the two env vars are not a matching pair (a key was regenerated
// or only one was updated), every push service refuses every push (403/401) while subscribing and
// saving a device still "work", so nothing looks broken except that nothing arrives. The private key is
// the one that signs, so the public key the app hands to devices is always derived from it.
import crypto from 'node:crypto';

const b64u = (buf) => Buffer.from(buf).toString('base64url');

// Uncompressed P-256 point, base64url: the same format web-push generates. null if the key is unusable.
export function publicKeyFromPrivate(privateKey) {
  try {
    const raw = Buffer.from(String(privateKey || '').trim(), 'base64url');
    if (raw.length !== 32) return null;
    const ecdh = crypto.createECDH('prime256v1');
    ecdh.setPrivateKey(raw);
    return b64u(ecdh.getPublicKey());
  } catch { return null; }
}

export function subjectProblem(subject) {
  const s = String(subject || '').trim();
  if (!s) return 'VAPID_SUBJECT is not set';
  if (!/^(mailto:[^\s@]+@[^\s@]+|https:\/\/\S+)$/.test(s)) return 'VAPID_SUBJECT must look like mailto:you@example.com (or an https:// address)';
  return null;
}

// env -> what to use. configured=false means push cannot be sent at all.
export function readVapid(env = process.env) {
  const privateKey = String(env.VAPID_PRIVATE_KEY || '').trim();
  const envPublic = String(env.VAPID_PUBLIC_KEY || '').trim();
  const subject = String(env.VAPID_SUBJECT || '').trim();
  const derived = publicKeyFromPrivate(privateKey);
  const publicKey = derived || envPublic || null;
  return {
    configured: Boolean(privateKey && publicKey && subject),
    subject,
    privateKey,
    publicKey,
    envPublicKey: envPublic || null,
    privateKeyValid: Boolean(derived),
    keysMismatch: Boolean(derived && envPublic && derived !== envPublic),
    subjectProblem: subjectProblem(subject),
  };
}

// A failed send -> { status, kind, reason }. `kind` groups failures; `reason` is what an admin can act on.
export function classifyPushFailure(err) {
  const status = Number(err?.statusCode) || 0;
  const body = String(err?.body || err?.message || '').slice(0, 200);
  let host = '';
  try { host = new URL(err?.endpoint || '').host; } catch { /* endpoint not attached */ }
  if (status === 404 || status === 410) {
    return { status, kind: 'expired', reason: 'The device unsubscribed or the notification permission was removed. It was dropped and registers again the next time the app is opened.' };
  }
  if (status === 401 || status === 403) {
    return { status, kind: 'rejected', reason: `The push service refused the server's signature (${status}${body ? `: ${body}` : ''}). Usually the device was subscribed with a different key than the server signs with. Opening the app on that device re-registers it.` };
  }
  if (status === 413) return { status, kind: 'payload', reason: 'The message was too large for the push service.' };
  if (status === 429) return { status, kind: 'rate', reason: 'The push service is rate-limiting this server. Try again in a few minutes.' };
  if (status >= 500) return { status, kind: 'service', reason: `The push service had a problem (${status}). Try again shortly.` };
  if (!status && /timeout|ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|fetch failed/i.test(body)) return { status, kind: 'network', reason: 'The server could not reach the push service (network or timeout).' };
  return { status, kind: 'other', reason: `Send failed${status ? ` (${status})` : ''}${body ? `: ${body}` : ''}.` };
}

// [{kind, reason, count}], most common first, so the admin sees one line per cause.
export function summarizeFailures(failures) {
  const map = new Map();
  for (const f of failures || []) {
    const key = `${f.kind}|${f.status}`;
    const cur = map.get(key) || { ...f, count: 0 };
    cur.count += 1;
    map.set(key, cur);
  }
  return [...map.values()].sort((a, b) => b.count - a.count);
}
