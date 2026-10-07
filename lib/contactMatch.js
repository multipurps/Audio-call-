import { normalizePhone } from './phoneNumbers.js';

// Incoming WhatsApp caller -> the Emysa contact it belongs to.
//
// Rules, because a wrong match would play one person's private history into a
// call with someone else:
//   * match on the phone number only (never the display name);
//   * the number must normalise to a full international (E.164) number;
//   * exact match, never a suffix/"last 9 digits" match;
//   * only inside the signed-in user's own contacts;
//   * two contacts with the same number = ambiguous = no memories are loaded.

// WhatsApp identifies callers as JIDs: "2348012345678@s.whatsapp.net",
// "2348012345678:12@s.whatsapp.net" (a linked device), or a privacy "@lid" id
// that carries no phone number at all.
export function normalizeWhatsappCaller(raw) {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value) return null;
  if (value.includes('@') && !/@(s\.whatsapp\.net|c\.us)$/i.test(value)) return null; // @lid, groups (@g.us), broadcasts: no person's number
  const user = value.includes('@') ? value.split('@')[0] : value;
  const bare = user.split(':')[0]; // drop ":device" suffix
  if (/^\+?[\d\s().-]+$/.test(bare)) {
    const digits = bare.replace(/[^\d+]/g, '').replace(/^00/, '');
    return normalizePhone(digits.startsWith('+') ? digits : `+${digits}`);
  }
  return null;
}

// Pure matcher over a user's contacts (already filtered to that user).
export function matchContactByNumber(contacts, callerNumber) {
  const e164 = normalizeWhatsappCaller(callerNumber);
  if (!e164) return { status: 'invalid', contact: null, number: null };
  const hits = (contacts || []).filter((c) => normalizePhone(String(c.phone_number || '').replace(/\s+/g, '')) === e164);
  if (hits.length === 1) return { status: 'matched', contact: hits[0], number: e164 };
  if (hits.length > 1) return { status: 'ambiguous', contact: null, number: e164, count: hits.length };
  return { status: 'none', contact: null, number: e164 };
}

// DB version. Always scoped by user_id in the query itself.
export async function resolveContactByCaller(supabase, userId, callerNumber) {
  if (!supabase || !userId) return { status: 'invalid', contact: null, number: null };
  const { data, error } = await supabase.from('contacts').select('id,name,phone_number').eq('user_id', userId);
  if (error) return { status: 'error', contact: null, number: null };
  return matchContactByNumber(data || [], callerNumber);
}
