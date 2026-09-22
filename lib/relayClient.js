// Thin client for api/*.js to reach the call relay's plain-HTTP routes
// (server/directBridge.js handleHttp), the same way lib/socialRelayClient.js
// reaches the social relay.
//
// Needed because the w-okada voice changer is reachable only from the relay
// process: it sits on the relay's network (often a LAN or a GPU box behind a
// tunnel), rejects browser origins outright via TrustedOriginMiddleware, and
// may well be serving self-signed TLS. Vercel functions can't get to it, so
// they ask the relay, which can.
//
// Auth is a shared secret header, never the user's Supabase JWT — the relay
// re-derives nothing about the user from these calls, they're operator-level
// ("which voices exist", "load slot N").

const SECRET = process.env.SOCIAL_RELAY_INTERNAL_SECRET || process.env.DIRECT_BRIDGE_SECRET || '';

/**
 * RELAY_WS_URL is a wss:// URL (api/calls-twiml.js hands it to Twilio). The
 * relay's HTTP routes are the same host and port, so derive them rather than
 * adding a second env var to keep in sync. RELAY_HTTP_URL overrides for
 * setups where the WS and HTTP endpoints genuinely differ (TLS termination
 * on a different port, for instance).
 */
export function relayHttpBase() {
  if (process.env.RELAY_HTTP_URL) return process.env.RELAY_HTTP_URL.replace(/\/+$/, '');
  const wsUrl = process.env.RELAY_WS_URL;
  if (!wsUrl) return '';
  try {
    const u = new URL(wsUrl);
    u.protocol = u.protocol === 'ws:' ? 'http:' : 'https:';
    u.pathname = '/';
    u.search = '';
    return u.toString().replace(/\/+$/, '');
  } catch {
    return '';
}
}

export async function relayRequest(path, { method = 'GET', body } = {}) {
  const base = relayHttpBase();
  if (!base || !SECRET) {
    const err = new Error('Call relay not configured (needs RELAY_WS_URL and an internal secret)');
    err.statusCode = 500;
    throw err;
  }
  const resp = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': SECRET },
    body: body ? JSON.stringify(body) : undefined,
    // Loading an RVC model into VRAM can take a while on a cold box, and
    // Render free-tier instances fall asleep; give it real room.
    signal: AbortSignal.timeout(35_000),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const err = new Error(data.error || `Relay request failed (${resp.status})`);
    err.statusCode = resp.status >= 500 ? 502 : resp.status;
    throw err;
  }
  return data;
}
