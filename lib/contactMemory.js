import { createHash } from 'node:crypto';
import { containsSensitiveSecret, sanitizeMemoryContent } from './memoryManager.js';
import { generateChatCompletion, hasConfiguredLlm } from './llmClient.js';

// Imported WhatsApp history -> per-contact memories, reviewed by the user.
//
// The rule that shapes everything here: the raw conversation is never put in
// a live call's prompt. A conversation is (1) mined for CANDIDATE memories the
// user reviews, and (2) optionally indexed so a few short, relevant snippets
// can be retrieved on demand. Only approved memories reach the model.

export const CONTACT_MEMORY_TYPES = Object.freeze([
  'identity', 'preferences', 'communication_style', 'important_relationships',
  'recurring_facts', 'previous_context', 'unresolved_issues', 'commitments',
  'important_dates', 'caller_preferences',
]);
export const REVIEW_STATUSES = Object.freeze(['candidate', 'approved', 'rejected', 'edited']);
export const USABLE_STATUSES = Object.freeze(['approved', 'edited']);

// What matters most on a call comes first when the block has to be trimmed.
const TYPE_PRIORITY = ['caller_preferences', 'commitments', 'unresolved_issues', 'important_dates', 'identity', 'preferences', 'communication_style', 'important_relationships', 'recurring_facts', 'previous_context'];
const TYPE_LABEL = {
  identity: 'Identity', preferences: 'Preferences', communication_style: 'How they communicate',
  important_relationships: 'People in their life', recurring_facts: 'Recurring facts', previous_context: 'Earlier context',
  unresolved_issues: 'Open issues', commitments: 'Commitments', important_dates: 'Important dates', caller_preferences: 'On calls',
};

const MIN_CONFIDENCE = 0.35;
const MAX_TEXT = 300;

// Chat exports are full of one-time codes, bank details and ID numbers. The
// general filter in memoryManager misses bare forms like "your code is 482913",
// so imported history gets a stricter guard on both the message and the memory.
const IMPORT_SECRET_PATTERNS = [
  /\b(?:code|otp|pin|passcode|token|cvv|cvc|password|passwd|pwd)\b[^\n]{0,25}?\d{4,}/i,        // "your code is 482913", "pin 4821"
  /\b(?:account|acct|routing|sort code|iban|bvn|nin|passport|licen[cs]e|ssn|tax id)\b[^\n]{0,30}?\d{4,}/i,
  /\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/,                                                         // IBAN
  /\d(?:[ -]?\d){8,}/,                                                                        // any 9+ digit run: card, account, BVN, ID
];
export function containsImportSecret(text = '') {
  const t = String(text || '');
  return containsSensitiveSecret(t) || IMPORT_SECRET_PATTERNS.some((re) => re.test(t));
}
export function sanitizeContactMemory(text = '') {
  const cleaned = sanitizeMemoryContent(text);
  return cleaned && !containsImportSecret(cleaned) ? cleaned : null;
}

export const hashText = (text) => createHash('md5').update(String(text).trim().toLowerCase()).digest('hex');

// ---------------------------------------------------------------------------
// Windows of conversation for analysis
// ---------------------------------------------------------------------------

function speaker(msg, who) {
  if (msg.sender === who.contactParticipant) return 'CONTACT';
  if (who.selfParticipant && msg.sender === who.selfParticipant) return 'USER';
  return null; // other group members are not analysed
}

// Newest window first. Only text from the contact and the user is considered.
export function buildWindows(messages, who, { maxChars = 6000, maxMessages = 80 } = {}) {
  const usable = (messages || []).filter((m) => (m.kind === 'text' || m.kind === 'call') && m.text && speaker(m, who));
  const windows = [];
  let current = [];
  let size = 0;
  for (const msg of usable) {
    const len = Math.min(msg.text.length, 500) + 40;
    if (current.length && (size + len > maxChars || current.length >= maxMessages)) {
      windows.push(current);
      current = [];
      size = 0;
    }
    current.push(msg);
    size += len;
  }
  if (current.length) windows.push(current);
  return windows.reverse();
}

function renderWindow(window, who) {
  return window.map((m) => `[#${m.index}] (${m.sentAt.slice(0, 10)}) ${speaker(m, who)}: ${m.text.replace(/\s+/g, ' ').slice(0, 500)}`).join('\n');
}

// ---------------------------------------------------------------------------
// LLM extraction
// ---------------------------------------------------------------------------

export const EXTRACTION_SYSTEM_PROMPT = `You read part of a WhatsApp conversation between the app USER and one CONTACT and propose long-lived memories ABOUT THE CONTACT that would help an AI assistant speak with them on a phone call.

Rules:
- Propose only things that stay useful later: who they are, stable preferences, how they like to communicate, important people in their life, recurring facts, unresolved issues, commitments, important dates, and how they like to be called or when.
- Do NOT turn every sentence into a memory. Skip small talk, jokes, one-off logistics, moods, and anything that will be stale next week.
- NEVER include passwords, verification codes, card/bank/account numbers, ID numbers, or addresses of third parties.
- Do not assume. If a memory is your conclusion rather than something stated outright, set "inferred": true and lower the confidence.
- Every memory must cite the single message that supports it by its [#number]. If you cannot cite one, leave it out.
- Write each memory as one short factual sentence in the third person (under 200 characters).
- Types: ${CONTACT_MEMORY_TYPES.join(', ')}.
- If nothing is worth keeping, return an empty list.

Reply with JSON only: {"memories":[{"type":"...","text":"...","source_index":123,"confidence":0.0-1.0,"inferred":true|false}]}`;

function parseJsonLoose(content) {
  const trimmed = String(content || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  try { return JSON.parse(trimmed); } catch { /* fall through */ }
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) { try { return JSON.parse(trimmed.slice(start, end + 1)); } catch { /* none */ } }
  return null;
}

const tokens = (s) => new Set(String(s).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 4));

// Turns raw model output into rows safe to insert. Nothing the model says is
// trusted: the source message is copied from the export (never from the
// model), unsupported or unsafe items are dropped, and anything the contact
// did not say themselves is forced to "inferred".
export function validateExtraction(content, window, who, { method = 'llm' } = {}) {
  const parsed = typeof content === 'string' ? parseJsonLoose(content) : content;
  const list = Array.isArray(parsed?.memories) ? parsed.memories : [];
  const byIndex = new Map(window.map((m) => [m.index, m]));
  const out = [];
  const seen = new Set();
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    if (!CONTACT_MEMORY_TYPES.includes(item.type)) continue;
    const source = byIndex.get(Number(item.source_index));
    if (!source) continue; // uncited or cited something outside this window
    const text = sanitizeContactMemory(item.text);
    if (!text || text.length < 8 || text.length > MAX_TEXT) continue;
    if (containsImportSecret(source.text)) continue; // never copy a message holding a code/password/card number into a memory
    let confidence = Number(item.confidence);
    if (!Number.isFinite(confidence)) confidence = 0.5;
    confidence = Math.min(1, Math.max(0, confidence));
    let inferred = item.inferred !== false;
    const statedByContact = source.sender === who.contactParticipant;
    if (!statedByContact) { inferred = true; confidence = Math.min(confidence, 0.6); }
    const overlap = [...tokens(text)].some((t) => tokens(source.text).has(t));
    if (!overlap) { inferred = true; confidence = Math.min(confidence, 0.5); }
    if (confidence < 0.7) inferred = true;
    if (confidence < MIN_CONFIDENCE) continue;
    const hash = hashText(text);
    if (seen.has(hash)) continue;
    seen.add(hash);
    out.push({
      memory_type: item.type,
      memory_text: text,
      confidence: Number(confidence.toFixed(2)),
      is_inferred: inferred,
      source_message: source.text.replace(/\s+/g, ' ').slice(0, 400),
      source_message_index: source.index,
      source_date: source.sentAt,
      status: 'candidate',
      original_text: text,
      method,
    });
  }
  return out;
}

export async function extractWithLlm(window, who, { contactName = 'the contact', generate = generateChatCompletion, env = process.env } = {}) {
  const res = await generate({
    messages: [
      { role: 'system', content: EXTRACTION_SYSTEM_PROMPT },
      { role: 'user', content: `CONTACT is "${contactName}".\n\nConversation:\n${renderWindow(window, who)}` },
    ],
    response_format: { type: 'json_object' },
    temperature: 0.1,
    maxTokens: 900,
    env,
    timeoutMs: 30000,
  });
  return validateExtraction(res.content, window, who);
}

// ---------------------------------------------------------------------------
// Offline fallback: a handful of high-precision patterns, used when no LLM is
// configured. Only the CONTACT's own words, always flagged for review.
// ---------------------------------------------------------------------------

const RULES = [
  { type: 'important_dates', re: /\bmy (?:birthday|bday) (?:is|falls)(?: on)? ([^.!?\n]{3,40})/i, text: (m) => `Birthday: ${m[1].trim()}`, confidence: 0.7, inferred: false },
  { type: 'identity', re: /\b(?:call me|you can call me|everyone calls me|i go by) ([\p{Lu}][\p{L}'-]{1,24})/u, text: (m) => `Prefers to be called ${m[1]}`, confidence: 0.65, inferred: false },
  { type: 'caller_preferences', re: /\b(?:don'?t|do not|please don'?t|never) call me (before|after|during|at|on) ([^.!?\n]{2,30})/i, text: (m) => `Does not want calls ${m[1].toLowerCase()} ${m[2].trim()}`, confidence: 0.7, inferred: false },
  { type: 'caller_preferences', re: /\bcall me (after|before) ([^.!?\n]{2,25})/i, text: (m) => `Prefers calls ${m[1].toLowerCase()} ${m[2].trim()}`, confidence: 0.6, inferred: false },
  { type: 'caller_preferences', re: /\b(?:text|message|whatsapp) me (?:first|instead)\b/i, text: () => 'Prefers a message before a call', confidence: 0.55, inferred: false },
  { type: 'preferences', re: /\bi (?:really )?(love|prefer|hate|can'?t stand|don'?t like|do not like) ([^.!?\n]{3,50})/i, text: (m) => `Says they ${m[1].toLowerCase().replace("can't", 'cannot')} ${m[2].trim()}`, confidence: 0.5, inferred: false },
  { type: 'commitments', re: /\bi(?:'ll| will) (send|bring|pay|call|check|get back to)([^.!?\n]{3,60})/i, text: (m) => `Said they would ${m[1].toLowerCase()}${m[2].replace(/\s+/g, ' ')}`.trim(), confidence: 0.45, inferred: true },
];

export function extractWithRules(window, who) {
  const out = [];
  const seen = new Set();
  for (const msg of window) {
    if (msg.sender !== who.contactParticipant || !msg.text) continue;
    if (containsImportSecret(msg.text)) continue;
    for (const rule of RULES) {
      const m = rule.re.exec(msg.text);
      if (!m) continue;
      const text = sanitizeContactMemory(rule.text(m));
      if (!text || text.length < 8) continue;
      const hash = hashText(text);
      if (seen.has(hash)) continue;
      seen.add(hash);
      out.push({
        memory_type: rule.type, memory_text: text, confidence: rule.confidence, is_inferred: rule.inferred || rule.confidence < 0.7,
        source_message: msg.text.replace(/\s+/g, ' ').slice(0, 400), source_message_index: msg.index, source_date: msg.sentAt,
        status: 'candidate', original_text: text, method: 'rules',
      });
    }
  }
  return out;
}

// Runs one batch of windows (newest first, resumable through `cursor`).
export async function analyzeWindows(windows, who, { cursor = 0, maxWindows = 12, contactName, extract, env = process.env } = {}) {
  const run = extract || (hasConfiguredLlm(env) ? (w) => extractWithLlm(w, who, { contactName, env }) : (w) => extractWithRules(w, who));
  const method = extract ? 'custom' : hasConfiguredLlm(env) ? 'llm' : 'rules';
  const slice = windows.slice(cursor, cursor + maxWindows);
  const found = [];
  let failed = 0;
  for (const window of slice) {
    try { found.push(...await run(window)); } catch { failed += 1; }
  }
  const seen = new Set();
  const candidates = found.filter((c) => { const h = hashText(c.memory_text); if (seen.has(h)) return false; seen.add(h); return true; });
  return { candidates, processed: slice.length, failed, nextCursor: cursor + slice.length, total: windows.length, done: cursor + slice.length >= windows.length, method };
}

// ---------------------------------------------------------------------------
// Conversation index (optional semantic/keyword retrieval)
// ---------------------------------------------------------------------------

export function buildChunks(messages, { maxChars = 1200, maxMessages = 14 } = {}) {
  const chunks = [];
  let current = null;
  const flush = () => { if (current && current.lines.length) chunks.push(current); current = null; };
  for (const msg of messages || []) {
    if (msg.kind !== 'text' || !msg.text) continue;
    const line = `[${msg.sentAt.slice(0, 10)}] ${msg.sender}: ${msg.text.replace(/\s+/g, ' ').slice(0, 600)}`;
    if (current && (current.chars + line.length > maxChars || current.lines.length >= maxMessages)) flush();
    if (!current) current = { lines: [], chars: 0, startedAt: msg.sentAt, endedAt: msg.sentAt, firstIndex: msg.index, lastIndex: msg.index };
    current.lines.push(line);
    current.chars += line.length + 1;
    current.endedAt = msg.sentAt;
    current.lastIndex = msg.index;
  }
  flush();
  return chunks.map((c, i) => ({ chunk_index: i, started_at: c.startedAt, ended_at: c.endedAt, first_message_index: c.firstIndex, last_message_index: c.lastIndex, content: c.lines.join('\n') }));
}

export function embeddingsEnabled(env = process.env) {
  return Boolean((env.EMBEDDINGS_API_KEY || env.OPENAI_API_KEY) && String(env.CONTACT_HISTORY_EMBEDDINGS || '').toLowerCase() !== 'off');
}

export async function embedTexts(texts, { env = process.env, fetchImpl = fetch } = {}) {
  const key = env.EMBEDDINGS_API_KEY || env.OPENAI_API_KEY;
  if (!key) throw new Error('embeddings are not configured');
  const base = String(env.EMBEDDINGS_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const vectors = [];
  for (let i = 0; i < texts.length; i += 64) {
    const resp = await fetchImpl(`${base}/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: env.EMBEDDINGS_MODEL || 'text-embedding-3-small', input: texts.slice(i, i + 64) }),
      signal: AbortSignal.timeout(25000),
    });
    if (!resp.ok) throw new Error(`embeddings request failed (${resp.status})`);
    const data = await resp.json();
    for (const row of data.data || []) vectors.push(row.embedding);
  }
  if (vectors.length !== texts.length) throw new Error('embeddings response was incomplete');
  return vectors;
}

export const toVectorLiteral = (v) => `[${v.join(',')}]`;

// ---------------------------------------------------------------------------
// Retrieval for a call
// ---------------------------------------------------------------------------

export async function loadApprovedMemories(supabase, { userId, contactId, limit = 14 }) {
  if (!supabase || !userId || !contactId) return [];
  const { data, error } = await supabase
    .from('contact_memories')
    .select('id, memory_type, memory_text, confidence, is_inferred, status, source_date, updated_at')
    .eq('user_id', userId)
    .eq('contact_id', contactId)
    .in('status', USABLE_STATUSES)
    .order('updated_at', { ascending: false })
    .limit(100);
  if (error || !Array.isArray(data)) return [];
  const rank = (m) => { const i = TYPE_PRIORITY.indexOf(m.memory_type); return i < 0 ? 99 : i; };
  return data
    .filter((m) => USABLE_STATUSES.includes(m.status)) // belt and braces: never a candidate or rejected row
    .sort((a, b) => rank(a) - rank(b) || String(b.updated_at).localeCompare(String(a.updated_at)))
    .slice(0, limit);
}

export async function retrieveHistorySnippets(supabase, { userId, contactId, query, limit = 3, env = process.env, fetchImpl } = {}) {
  const q = String(query || '').trim().slice(0, 300);
  if (!supabase || !userId || !contactId || q.length < 3) return [];
  const found = new Map();
  try {
    const { data } = await supabase.rpc('search_contact_history', { p_user_id: userId, p_contact_id: contactId, p_query: q, p_limit: limit });
    for (const row of data || []) found.set(row.chunk_id, { id: row.chunk_id, date: row.started_at, content: row.content, score: Number(row.rank) || 0 });
  } catch { /* keyword search is best-effort */ }
  if (embeddingsEnabled(env)) {
    try {
      const [vec] = await embedTexts([q], { env, fetchImpl });
      const { data } = await supabase.rpc('match_contact_history', { p_user_id: userId, p_contact_id: contactId, p_embedding: toVectorLiteral(vec), p_limit: limit });
      for (const row of data || []) {
        const prev = found.get(row.chunk_id);
        found.set(row.chunk_id, { id: row.chunk_id, date: row.started_at, content: row.content, score: Math.max(prev?.score || 0, Number(row.similarity) || 0) + (prev ? 0.2 : 0) });
      }
    } catch { /* semantic search is optional */ }
  }
  return [...found.values()].sort((a, b) => b.score - a.score).slice(0, limit)
    .map((s) => ({ ...s, content: s.content.slice(0, 450) }));
}

export function buildPromptBlock({ contactName = '', memories = [], snippets = [], maxChars = 1600 } = {}) {
  if (!memories.length && !snippets.length) return '';
  const lines = [];
  let used = 0;
  const add = (line) => { if (used + line.length + 1 > maxChars) return false; lines.push(line); used += line.length + 1; return true; };
  add(`<contact_memory contact="${String(contactName).replace(/["<>]/g, '')}">`);
  if (memories.length) {
    add('Things the user confirmed about this person (from their imported WhatsApp history). Use naturally; never read them out as a list; do not mention that they come from an import:');
    for (const m of memories) if (!add(`- ${TYPE_LABEL[m.memory_type] || m.memory_type}: ${m.memory_text}${m.is_inferred ? ' (confirmed by the user, originally inferred)' : ''}`)) break;
  }
  if (snippets.length) {
    add('Possibly relevant earlier messages (context only; do not quote them):');
    for (const s of snippets) if (!add(`- (${String(s.date || '').slice(0, 10)}) ${s.content.replace(/\s+/g, ' ')}`)) break;
  }
  lines.push('</contact_memory>');
  return lines.join('\n');
}

// Everything a call needs about one contact, already scoped and capped.
export async function buildContactContext(supabase, { userId, contactId, contactName = '', query = '', env = process.env, fetchImpl } = {}) {
  const memories = await loadApprovedMemories(supabase, { userId, contactId });
  const snippets = await retrieveHistorySnippets(supabase, { userId, contactId, query, env, fetchImpl });
  return { memories, snippets, promptBlock: buildPromptBlock({ contactName, memories, snippets }) };
}
