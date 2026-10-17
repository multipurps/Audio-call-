// Stops the Pipecat assistant session for one call, on the app's instruction.
//
// Ending a call in the app has two legs: the carrier leg (WaCalls, mp-relay,
// Signal, Twilio) and the assistant leg (the Pipecat session that is speaking
// and listening). Before this helper only the carrier leg was told. The
// assistant session then waited for the carrier to drop its socket, which
// looked like a network failure and could keep audio running for a call the
// user had already ended.
//
// Returns a result object and never throws, so callers can decide how to
// report it. A missing session (404) is success: there is nothing to stop.
// `skipped` means the assistant service is not configured on this deployment.

export function pipecatHttpBase(env = process.env) {
  const raw = (env.PUBLIC_ASSISTANT_WS_URL || env.ASSISTANT_BRIDGE_URL || '')
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/stream$/, '');
  if (!raw) return null;
  return raw.replace(/^wss:/i, 'https:').replace(/^ws:/i, 'http:');
}

/**
 * @param {string} sessionKey  the suffix after `call-`: the platform call id for
 *   WaCalls / mp-relay / Signal, or calls.id for Twilio.
 */
export async function hangupPipecatSession(sessionKey, {
  reason = 'app-hangup',
  env = process.env,
  fetchImpl = fetch,
  timeoutMs = 8000,
} = {}) {
  if (!sessionKey) return { ok: false, skipped: true, error: 'no session key for this call' };
  const base = pipecatHttpBase(env);
  const secret = (env.ASSISTANT_BRIDGE_SECRET || '').trim();
  if (!base || !secret) return { ok: false, skipped: true, error: 'assistant service not configured' };

  const sessionId = `call-${sessionKey}`;
  try {
    const resp = await fetchImpl(`${base}/calls/${encodeURIComponent(sessionId)}/hangup`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (resp.status === 404) return { ok: true, found: false };
    if (!resp.ok) return { ok: false, httpStatus: resp.status, error: `assistant hangup returned ${resp.status}` };
    return { ok: true, found: true };
  } catch (err) {
    return { ok: false, error: err?.name === 'TimeoutError' ? 'assistant hangup timed out' : (err?.message || 'assistant hangup failed') };
  }
}
