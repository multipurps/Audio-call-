// Turns developer-flavoured text into something a person can act on. Pure.

// Telegram login errors people can actually fix.
const TELEGRAM_CODES = [
  [/PHONE_CODE_INVALID/, 'That code isn\u2019t right. Check it and try again.'],
  [/PHONE_CODE_EXPIRED/, 'That code has expired. Request a new one.'],
  [/PHONE_NUMBER_INVALID/, 'Check the phone number and include the country code.'],
  [/PASSWORD_HASH_INVALID/, 'That password isn\u2019t right.'],
  [/FLOOD_WAIT|FLOOD_PREMIUM_WAIT|PHONE_PASSWORD_FLOOD/, 'Too many attempts. Wait a little and try again.'],
];

// A WhatsApp link that was revoked on the phone (Linked devices) or by WhatsApp:
// the only fix is to link again, so say that instead of relay wording.
const WHATSAPP_DISCONNECTED = /not paired|worker not available|logged.?out|session parked/i;

// Configuration / infrastructure wording that means nothing to a caller:
// ALL_CAPS_ENV_NAMES, hosting names, wss:// URLs, "not configured", migrations.
const DEVELOPER_TEXT = [
  /\b[A-Z][A-Z0-9]*_[A-Z0-9_]{2,}\b/,
  /\b(Vercel|Render service|Supabase|mp-relay|webhook|migration)\b/i,
  /wss?:\/\//i,
  /not (yet )?configured|not set up|is missing on|\bmissing [A-Z0-9_]{4,}/i,
  /assistant service|app server/i,
];

/** `raw` is a server error string. Returns it unchanged unless it is developer
 *  text, in which case the friendlier mapping or `fallback` is returned. */
export function userError(raw, fallback) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) return fallback;
  for (const [re, friendly] of TELEGRAM_CODES) if (re.test(text)) return friendly;
  if (WHATSAPP_DISCONNECTED.test(text)) return 'WhatsApp is disconnected. Reconnect it in Profile > Connected accounts, then try again.';
  if (DEVELOPER_TEXT.some((re) => re.test(text))) {
    if (typeof console !== 'undefined') console.warn('[hidden from user]', text);
    return fallback;
  }
  return text;
}

/** Account label for "Connected as …". WhatsApp reports a JID such as
 *  "15049470572:2@s.whatsapp.net" when it has no profile name. */
export function friendlyAccountName(raw, fallback) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) return fallback;
  const jid = text.match(/^(\d{6,15})(?::\d+)?@(s\.whatsapp\.net|c\.us)$/i);
  if (jid) return `+${jid[1]}`;
  if (/^\d+(?::\d+)?@\S+$/.test(text)) return fallback; // opaque id (e.g. @lid): not a number or a name
  return text;
}
