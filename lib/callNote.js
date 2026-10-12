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

// Bridge session id for a call. WhatsApp/Telegram calls use the provider call
// id; phone (Twilio) calls bridged to the assistant service use our own
// calls.id. Returns null when the call has no live stream to talk to.
export function callSessionId(call, env = process.env) {
  if (!call) return null;
  if (call.platform === 'phone' || call.platform === 'twilio') {
    const bridged = String(env.TWILIO_VIA_PIPECAT || '').toLowerCase() === 'true';
    return bridged && call.id ? `call-${call.id}` : null;
  }
  return call.platform_call_id ? `call-${call.platform_call_id}` : null;
}

// Returns { ok: true } or { ok: false, error }.
export async function sendCallNote(call, text, { env = process.env, fetchImpl = fetch } = {}) {
  const base = assistantHttpBase(env);
  const secret = env.ASSISTANT_BRIDGE_SECRET;
  if (!base || !secret) return { ok: false, error: 'live notes are not configured' };
  const sessionId = callSessionId(call, env);
  if (!sessionId) return { ok: false, error: 'this call type does not support live notes' };
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

// What the chat says after the user types something to a call that is live. Emysa is ONE
// voice: the same "I" that is on the call answers here, so this never talks about "Emysa"
// or "she" as if she were somebody else who has to be told.
const WRAP_UP = /\b(round(?:ing)?(?:\s+it)?\s+up|wrap(?:ping)?(?:\s+it|\s+this|\s+the\s+call)?\s+up|finish(?:ing)?\s+up|wind(?:ing)?(?:\s+it|\s+this)?\s+(?:down|up)|bring\s+it\s+to\s+a\s+close|conclude)\b/i;

export function callNoteReply(text, result) {
  if (!result?.ok) return `I couldn't get that to the call: ${result?.error || 'it did not go through'}.`;
  return WRAP_UP.test(String(text || '')) ? "Okay, I'll wrap it up." : "Got it. I'll work that in.";
}
