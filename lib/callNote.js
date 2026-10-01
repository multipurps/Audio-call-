// Passes a live note from the call's owner to Emysa while the call is running.
// Server-to-server: the bridge secret never reaches the browser. The assistant
// service only adds the note to the model's context, so it never interrupts
// what Emysa is saying.

export function assistantHttpBase(env = process.env) {
  const raw = (env.PUBLIC_ASSISTANT_WS_URL || env.ASSISTANT_BRIDGE_URL || '').trim();
  if (!raw) return '';
  return raw
    .replace(/^wss:/i, 'https:')
    .replace(/^ws:/i, 'http:')
    .replace(/\/stream\/?$/, '')
    .replace(/\/+$/, '');
}

// Returns { ok: true } or { ok: false, error }.
export async function sendCallNote(call, text, { env = process.env, fetchImpl = fetch } = {}) {
  const base = assistantHttpBase(env);
  const secret = env.ASSISTANT_BRIDGE_SECRET;
  if (!base || !secret) return { ok: false, error: 'live notes are not configured' };
  if (!call?.platform_call_id) return { ok: false, error: 'this call type does not support live notes' };
  const sessionId = `call-${call.platform_call_id}`;
  try {
    const resp = await fetchImpl(`${base}/calls/${encodeURIComponent(sessionId)}/note`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(5000),
    });
    if (resp.ok) return { ok: true };
    if (resp.status === 409) return { ok: false, error: 'the call is not live yet' };
    return { ok: false, error: `assistant service returned ${resp.status}` };
  } catch {
    return { ok: false, error: 'could not reach the assistant service' };
  }
}
