// Which calling line a chat call request uses.
//
// One rule, used by the chat orchestration in api/assistant.js:
//   1. A line the user NAMES in this message always wins ("call him on WhatsApp").
//   2. A repeat ("call him again", "try her again", "call him back") reuses the line
//      this conversation already used. It never silently moves to another line.
//   3. Anything else uses the normal resolver (the app's line picker, or the only
//      line the user has, or a question when there are two).
//
// The conversation's line is read from what is persisted for it: the platform of
// its calls (any outcome) and of any phone call plan prepared in it. Nothing is
// held in memory between requests, so a refresh or a second device sees the same.

export const CALL_PLATFORMS = ['phone', 'whatsapp', 'telegram'];

export function namedPlatform(value) {
  return CALL_PLATFORMS.includes(value) ? value : null;
}

// Old rows may say 'twilio' for the phone line.
function normalize(platform) {
  const p = String(platform || '').toLowerCase();
  return p === 'twilio' ? 'phone' : p || null;
}

const ts = (row) => Date.parse(row?.created_at || '') || 0;

// The line this conversation most recently used, or null if it has none yet.
// `unsupported` is set when the most recent line cannot be started from chat
// (e.g. Signal), so the caller can say so rather than quietly using another.
export function conversationPlatform(priorCalls = [], plans = []) {
  const rows = [
    ...(priorCalls || []).map((c) => ({ platform: normalize(c.platform), at: ts(c) })),
    ...(plans || []).map((p) => ({ platform: 'phone', at: ts(p) })),
  ].filter((r) => r.platform);
  if (!rows.length) return { platform: null, unsupported: null };
  rows.sort((a, b) => b.at - a.at);
  const latest = rows[0].platform;
  return CALL_PLATFORMS.includes(latest)
    ? { platform: latest, unsupported: null }
    : { platform: null, unsupported: latest };
}

export function resolveCallPlatform({ action, intentChannel, uiChannel, priorCalls, plans }) {
  const named = namedPlatform(intentChannel);
  if (named) return { channel: named, source: 'named', unsupported: null };
  if (action === 'retry') {
    const { platform, unsupported } = conversationPlatform(priorCalls, plans);
    if (platform) return { channel: platform, source: 'conversation', unsupported: null };
    if (unsupported) return { channel: null, source: 'conversation', unsupported };
  }
  return { channel: namedPlatform(uiChannel), source: 'ui', unsupported: null };
}
