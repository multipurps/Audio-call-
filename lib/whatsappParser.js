import { unzipSync } from 'fflate';
import { normalizePhone } from './phoneNumbers.js';

// Parses WhatsApp "Export chat" files: a .txt, or a .zip holding the .txt with
// or without media. Pure functions, no I/O.
//
// What the formats look like (both exist in the wild, in many locales):
//   iOS      [12/03/2024, 14:05:09] Marilyn: hello          (24h or "2:05:09 PM")
//   Android  12/03/2024, 14:05 - Marilyn: hello             (24h or "2:05 PM")
// Complications handled here: bidi marks and BOMs, U+202F before AM/PM,
// day-first vs month-first dates (inferred from the whole file), multi-line
// messages, system lines with no sender, media placeholders, attachment file
// names, call lines, deleted messages, and unsaved contacts shown as phone
// numbers.

export const MAX_EXPORT_BYTES = 50 * 1024 * 1024;
export const MAX_CHAT_TEXT_BYTES = 50 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 20000;

// Invisible direction/format marks WhatsApp sprinkles into exports.
const INVISIBLE = /[\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;

const DATE = String.raw`(\d{1,4}[\/.\-]\d{1,2}[\/.\-]\d{1,4})`;
const TIME = String.raw`(\d{1,2}[:.]\d{2}(?:[:.]\d{2})?)`;
const MERIDIEM = String.raw`(?:[\s\u202f\u00a0]*([AaPp]\.?[Mm]\.?))?`;
const HEADER_IOS = new RegExp(String.raw`^\[${DATE},?\s+${TIME}${MERIDIEM}\]\s?(.*)$`);
const HEADER_ANDROID = new RegExp(String.raw`^${DATE},?\s+${TIME}${MERIDIEM}\s+[-\u2013\u2014]\s+(.*)$`);

const MEDIA_OMITTED = /^<?(?:media|image|video|audio|sticker|gif|document|contact card|video note|voice message|ptt)s?\s+omitted>?$/i;
const MEDIA_ATTACHED_IOS = /^<attached:\s*(.+?)>$/i;
const MEDIA_ATTACHED_ANDROID = /^(.+\.[a-z0-9]{2,5})\s+\(file attached\)$/i;
const CALL_LINE = /^(missed )?(voice|video) call(?:[,:].*)?$/i;
const DELETED = /^(you deleted this message|this message was deleted)\.?$/i;
const EDITED_MARK = /\s*<this message was edited>\s*$/i;
// iOS attributes some notices to the chat name, so they look like messages.
const SYSTEM_BODY = /^(messages and calls are end-to-end encrypted|your security code with .+ changed|.+ changed (their|his|her) phone number|.+ (joined|left) (using|via) .*|disappearing messages were turned (on|off).*)/i;
const PHONE_SENDER = /^\+?[\d\s().-]{7,}$/;

// A sender field: not too long, not a sentence. Everything else with no
// "Name: " prefix is a system line (encryption notice, "X added Y", ...).
const SENDER_MESSAGE = /^([^:\n]{1,80}?):\s([\s\S]*)$/;
// "Sam added Lee: welcome" style lines are system notices, not a sender called that.
const SYSTEM_SENDER = /\b(created (this )?group|added|removed|left|joined|changed (the |this )?(group|subject|icon|description|settings|number)|security code|disappearing messages)\b/i;

function decode(bytes) {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
  return new TextDecoder('utf-8').decode(bytes);
}

function isZip(bytes) {
  return bytes.length > 3 && bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 0x03 || bytes[2] === 0x05);
}

const MEDIA_EXT = /\.(jpe?g|png|webp|gif|heic|mp4|mov|3gp|opus|m4a|aac|mp3|ogg|wav|pdf|docx?|xlsx?|pptx?|vcf|zip)$/i;

export class ExportError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

// Find the chat text inside a zip WITHOUT inflating the media: the filter only
// lets .txt entries through, and every other entry is just counted.
export function readExport(input, { filename = '' } = {}) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length === 0) throw new ExportError('The file is empty.', 'empty');
  if (bytes.length > MAX_EXPORT_BYTES) throw new ExportError('The file is larger than 50 MB. Export again without media.', 'too_large');

  if (!isZip(bytes)) {
    if (/\.zip$/i.test(filename)) throw new ExportError('That file is not a valid zip.', 'bad_zip');
    return { kind: 'txt', chatFile: filename || 'chat.txt', text: decode(bytes), mediaCount: 0, mediaNames: [] };
  }

  const texts = [];
  const media = [];
  let entries = 0;
  let files;
  try {
    files = unzipSync(bytes, {
      filter: (file) => {
        entries += 1;
        if (entries > MAX_ZIP_ENTRIES) throw new ExportError('That zip has too many files.', 'too_many_entries');
        const name = file.name || '';
        if (name.endsWith('/') || name.startsWith('__MACOSX/') || name.split('/').pop().startsWith('._')) return false;
        if (/\.txt$/i.test(name)) {
          if (file.originalSize > MAX_CHAT_TEXT_BYTES) throw new ExportError('The chat text inside the zip is too large.', 'too_large');
          texts.push(name);
          return true;
        }
        media.push({ name, size: file.originalSize });
        return false;
      },
    });
  } catch (err) {
    if (err instanceof ExportError) throw err;
    throw new ExportError('That zip could not be read.', 'bad_zip');
  }

  const names = Object.keys(files);
  if (!names.length) throw new ExportError('No chat text (.txt) was found in the zip.', 'no_chat_file');
  // WhatsApp names it "_chat.txt" (iOS) or "WhatsApp Chat with X.txt" (Android).
  const chosen = names.find((n) => /(^|\/)_chat\.txt$/i.test(n))
    || names.find((n) => /whatsapp chat/i.test(n))
    || names.sort((a, b) => files[b].length - files[a].length)[0];
  return {
    kind: 'zip',
    chatFile: chosen,
    text: decode(files[chosen]),
    mediaCount: media.length,
    mediaNames: media.map((m) => m.name).filter((n) => MEDIA_EXT.test(n)).slice(0, 5000),
  };
}

function two(n) { return String(n).padStart(2, '0'); }

function splitDate(raw) {
  const parts = raw.split(/[\/.\-]/).map((p) => Number(p));
  return { parts, rawParts: raw.split(/[\/.\-]/) };
}

// Decide day-first / month-first / year-first from every date in the file.
export function inferDateOrder(rawDates) {
  let dayFirst = false;
  let monthFirst = false;
  let yearFirst = false;
  for (const raw of rawDates) {
    const { parts, rawParts } = splitDate(raw);
    if (rawParts[0].length === 4) { yearFirst = true; continue; }
    if (parts[0] > 12) dayFirst = true;
    if (parts[1] > 12) monthFirst = true;
  }
  if (yearFirst) return { order: 'ymd', ambiguous: false };
  if (dayFirst && !monthFirst) return { order: 'dmy', ambiguous: false };
  if (monthFirst && !dayFirst) return { order: 'mdy', ambiguous: false };
  // No evidence either way (or contradictory): default to day-first, flagged
  // so the user can flip it before anything is analysed.
  return { order: 'dmy', ambiguous: true };
}

function toIso(rawDate, rawTime, meridiem, order) {
  const { parts, rawParts } = splitDate(rawDate);
  let day; let month; let year;
  if (order === 'ymd') [year, month, day] = parts;
  else if (order === 'mdy') [month, day, year] = parts;
  else [day, month, year] = parts;
  if (rawParts[rawParts.length - 1].length === 2 && order !== 'ymd') year += 2000;
  const t = rawTime.split(/[:.]/).map(Number);
  let hour = t[0];
  const minute = t[1];
  const second = t[2] || 0;
  if (meridiem) {
    const pm = /^p/i.test(meridiem);
    if (pm && hour < 12) hour += 12;
    if (!pm && hour === 12) hour = 0;
  }
  if (!(month >= 1 && month <= 12 && day >= 1 && day <= 31 && hour <= 23 && minute <= 59 && second <= 59)) return null;
  // The export carries local wall-clock time with no zone; it is stored as if
  // it were UTC, consistently, so ordering and "how long ago" stay right.
  return `${year}-${two(month)}-${two(day)}T${two(hour)}:${two(minute)}:${two(second)}.000Z`;
}

function headerOf(line) {
  const m = HEADER_IOS.exec(line) || HEADER_ANDROID.exec(line);
  return m ? { date: m[1], time: m[2], meridiem: m[3] || '', rest: m[4] } : null;
}

function classify(text) {
  const t = text.trim();
  if (!t) return { kind: 'system', text: '' };
  if (MEDIA_OMITTED.test(t)) return { kind: 'media', text: '', attachment: null };
  let m = MEDIA_ATTACHED_IOS.exec(t);
  if (m) return { kind: 'media', text: '', attachment: m[1] };
  m = MEDIA_ATTACHED_ANDROID.exec(t);
  if (m) return { kind: 'media', text: '', attachment: m[1] };
  if (SYSTEM_BODY.test(t)) return { kind: 'system', text: '' };
  if (DELETED.test(t)) return { kind: 'deleted', text: '' };
  if (CALL_LINE.test(t)) return { kind: 'call', text: t };
  return { kind: 'text', text: t.replace(EDITED_MARK, '') };
}

export function parseChat(rawText, { dateOrder = null } = {}) {
  const text = String(rawText || '').replace(INVISIBLE, '').replace(/\r\n?/g, '\n');
  const lines = text.split('\n');

  // Pass 1: split into logical messages (header line + continuation lines).
  const logical = [];
  let unparsedLeading = 0;
  for (const line of lines) {
    const header = headerOf(line);
    if (header) logical.push({ ...header, extra: [] });
    else if (logical.length) logical[logical.length - 1].extra.push(line);
    else if (line.trim()) unparsedLeading += 1;
  }
  if (!logical.length) throw new ExportError('No WhatsApp messages were found in that file.', 'no_messages');

  const detected = inferDateOrder(logical.map((l) => l.date));
  const order = dateOrder || detected.order;
  const ambiguous = dateOrder ? false : detected.ambiguous;

  // Pass 2: sender / body / kind.
  const messages = [];
  const stats = { system: 0, media: 0, calls: 0, deleted: 0, text: 0, badDates: 0, unparsedLeading };
  for (const entry of logical) {
    const sentAt = toIso(entry.date, entry.time, entry.meridiem, order);
    if (!sentAt) { stats.badDates += 1; continue; }
    const full = [entry.rest, ...entry.extra].join('\n').replace(/\n+$/, '');
    const m = SENDER_MESSAGE.exec(full);
    if (!m || (m[1].trim().split(/\s+/).length > 2 && SYSTEM_SENDER.test(m[1]))) { stats.system += 1; continue; }
    const body = classify(m[2]);
    if (body.kind === 'system') { stats.system += 1; continue; }
    const message = { index: messages.length, sentAt, sender: m[1].trim(), kind: body.kind, text: body.text };
    if (body.attachment !== undefined && body.kind === 'media') message.attachment = body.attachment;
    if (body.kind === 'media') stats.media += 1;
    else if (body.kind === 'call') stats.calls += 1;
    else if (body.kind === 'deleted') stats.deleted += 1;
    else stats.text += 1;
    messages.push(message);
  }
  if (!messages.length) throw new ExportError('No WhatsApp messages were found in that file.', 'no_messages');

  // Participants (unsaved contacts appear as bare phone numbers).
  const byName = new Map();
  for (const msg of messages) {
    const p = byName.get(msg.sender) || { name: msg.sender, messages: 0, firstAt: msg.sentAt, lastAt: msg.sentAt, phone: null };
    p.messages += 1;
    if (msg.sentAt < p.firstAt) p.firstAt = msg.sentAt;
    if (msg.sentAt > p.lastAt) p.lastAt = msg.sentAt;
    byName.set(msg.sender, p);
  }
  const participants = [...byName.values()].sort((a, b) => b.messages - a.messages);
  for (const p of participants) if (PHONE_SENDER.test(p.name)) p.phone = normalizePhone(p.name.replace(/\s+/g, ''));

  const times = messages.map((m) => m.sentAt).sort();
  return {
    messages,
    participants,
    isGroup: participants.length > 2,
    dateOrder: order,
    dateOrderAmbiguous: ambiguous,
    firstMessageAt: times[0],
    lastMessageAt: times[times.length - 1],
    stats,
  };
}

// Reads a txt or zip and parses it. `mediaCount` counts only; media is never
// extracted, stored or sent anywhere.
export function parseExport(input, { filename = '', dateOrder = null } = {}) {
  const exp = readExport(input, { filename });
  const chat = parseChat(exp.text, { dateOrder });
  return { ...chat, source: { kind: exp.kind, chatFile: exp.chatFile, mediaCount: exp.mediaCount, hasMedia: exp.mediaCount > 0 || chat.stats.media > 0 }, chatText: exp.text };
}

// ---- who in the chat is the Emysa contact? ---------------------------------

function nameKey(value) {
  return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

// Phone number first (the one signal that is not a display name), then an
// exact name match, then "the other person" when the app user's own name is
// known. Returns null rather than guessing; the user then picks from the list.
export function identifyContactParticipant(participants, contact, { selfName = '' } = {}) {
  if (!participants?.length || !contact) return null;
  const e164 = normalizePhone(contact.phone_number || contact.phoneNumber || '');
  if (e164) {
    const hit = participants.filter((p) => p.phone === e164);
    if (hit.length === 1) return pick(participants, hit[0], 'phone');
  }
  const key = nameKey(contact.name);
  if (key) {
    const hit = participants.filter((p) => nameKey(p.name) === key);
    if (hit.length === 1) return pick(participants, hit[0], 'name');
  }
  const selfKey = nameKey(selfName);
  if (selfKey && participants.length === 2) {
    const me = participants.filter((p) => nameKey(p.name) === selfKey);
    if (me.length === 1) {
      const other = participants.find((p) => p !== me[0]);
      return { contactParticipant: other.name, selfParticipant: me[0].name, method: 'only_other' };
    }
  }
  return null;
}

function pick(participants, contactParticipant, method) {
  const others = participants.filter((p) => p !== contactParticipant);
  return { contactParticipant: contactParticipant.name, selfParticipant: others.length === 1 ? others[0].name : null, method };
}
