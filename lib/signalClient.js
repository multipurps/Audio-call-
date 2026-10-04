// Thin client for api/social-calling.js to reach the Signal bridge
// (signal-bridge/ in this repo, deployed on Fly.io). The bridge owns the
// signal-cli data; this app only keeps the user_id -> number mapping in
// signal_accounts.

const BRIDGE_URL = process.env.SIGNAL_BRIDGE_URL; // e.g. https://live-call-signal.fly.dev
const BRIDGE_SECRET = process.env.SIGNAL_BRIDGE_SECRET;

async function bridge(path, { method = 'GET', body, timeoutMs = 30_000 } = {}) {
  if (!BRIDGE_URL || !BRIDGE_SECRET) {
    const err = new Error('Signal calling bridge not configured');
    err.statusCode = 500;
    throw err;
  }
  const resp = await fetch(`${BRIDGE_URL}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-bridge-secret': BRIDGE_SECRET },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const err = new Error(data.error || `Signal bridge request failed (${resp.status})`);
    err.statusCode = resp.status;
    throw err;
  }
  return data;
}

export const signalStartLink = () => bridge('/signal/link/start', { method: 'POST', timeoutMs: 45_000 });
export const signalLinkStatus = (linkId, opts) => bridge(`/signal/link/${encodeURIComponent(linkId)}`, opts);
export const signalRemoveAccount = (number) => bridge(`/signal/accounts/${encodeURIComponent(number)}`, { method: 'DELETE', timeoutMs: 60_000 });
