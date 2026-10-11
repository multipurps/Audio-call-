// Letta-inspired Tiered Persistent Memory & Emotional State Manager for Emysa.
//
// Tiers:
//   - semantic:   Durable facts, preferences, relationships, biographical details
//   - episodic:   Specific calls, events, outcomes, appointments, shared moments
//   - emotional:  Relationship rapport, comfort preferences, emotional triggers
//   - working:    Active turn/session context
//
// Designed to reuse the existing Supabase Postgres database (`memories` and
// `user_emotional_states` tables) within the $5 budget constraint, with
// automatic fallback if the extended SQL migration (`016_memory_and_emotion.sql`)
// has not yet been applied.

import {
  createInitialEmotionState,
  decayEmotionalState,
  appraiseTurn,
  applyInlineMoodUpdate,
} from './emotionEngine.js';

// 'instruction' = standing do / don't rules the user gave ("never mention the price").
export const MEMORY_TYPES = Object.freeze(['semantic', 'episodic', 'emotional', 'working', 'instruction']);

// A standing rule is phrased as an instruction to Emysa, not a statement about the user
// ("I always prefer..." is a preference/fact, not a rule).
const RULE_START_RE = /^(?:(?:please|ok(?:ay)?|also|and|so|hey|emysa)[\s,.:-]+)*(?:from now on|going forward|in (?:the )?future|every time|whenever|always|never|don'?t ever|do not ever|remember (?:to|not to)|make sure (?:you|to))\b/i;
const RULE_ANYWHERE_RE = /\b(?:from now on|going forward|every time you|whenever you|in the future,? (?:don'?t|do not|always|never))\b/i;
const RULE_FILLER_RE = /\b(?:please|from now on|going forward|in the future|every time|whenever|always|never|ever|don'?t|do not|remember to|remember not to|make sure|you|to|not|the|a|an)\b/gi;

export function extractStandingRules(text = '') {
  const out = [];
  for (const raw of String(text || '').split(/[.!?\n]+/)) {
    const sentence = raw.trim();
    if (sentence.length < 8 || /^i\b/i.test(sentence)) continue;
    if (RULE_START_RE.test(sentence) || RULE_ANYWHERE_RE.test(sentence)) out.push(sentence);
  }
  return out;
}

// Same key for "never mention the price" and "you can always mention the price" so the
// newer rule replaces the older one instead of both being kept.
export function ruleSubjectKey(content = '') {
  const words = String(content).toLowerCase().replace(RULE_FILLER_RE, ' ').split(/[^a-z0-9]+/).filter(Boolean).slice(0, 4);
  return `rule:${words.join('_') || 'general'}`;
}

// Whether this call's own instructions ask to build on an earlier call.
export function referencesPriorCall(text = '') {
  return /\b(again|last call|previous call|earlier call|follow(?:ing)?[- ]?up|continue|pick up where|call (?:him|her|them) back|callback|as we discussed|as discussed|remind (?:him|her|them))\b/i.test(String(text || ''));
}

// In-process fallback cache for emotional state per `userId:contactId` so
// emotional continuity works even if the DB table isn't migrated yet.
const emotionStateCache = new Map();
const MAX_EMOTION_CACHE = 500;

function cacheKey(userId, contactId = null) {
  return `${userId || 'anon'}:${contactId || 'self'}`;
}

function setCachedEmotion(userId, contactId, state) {
  const key = cacheKey(userId, contactId);
  if (emotionStateCache.size >= MAX_EMOTION_CACHE && !emotionStateCache.has(key)) {
    const oldest = emotionStateCache.keys().next().value;
    if (oldest) emotionStateCache.delete(oldest);
  }
  emotionStateCache.set(key, state);
}

// ---------------------------------------------------------------------------
// Privacy & Secret Guardrails
// ---------------------------------------------------------------------------

const SENSITIVE_PATTERNS = [
  /\b(sk-[a-zA-Z0-9_-]{16,}|gsk_[a-zA-Z0-9_-]{16,}|eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,})\b/,
  /\b(api[_ -]?key|secret[_ -]?key|access[_ -]?token|bearer\s+[a-zA-Z0-9._-]{12,})\b/i,
  /\b(password|passcode|pin\s+number|my\s+pin|cvv|cvc|social\s+security|ssn|otp|verification\s+code|one-time\s+code)\s*(is|:|=)\s*\S+/i,
  /\b\d{3}-\d{2}-\d{4}\b/, // SSN
  /\b(?:\d[ -]*?){13,19}\b/, // Credit card number sequence
];

/**
 * Check whether candidate memory text contains secrets, credentials, OTPs,
 * or financial/government identifiers that must never be persisted.
 */
export function containsSensitiveSecret(text = '') {
  const s = String(text || '');
  if (!s) return false;
  return SENSITIVE_PATTERNS.some((re) => re.test(s));
}

/**
 * Sanitize and normalize a candidate memory string. Returns `null` if empty,
 * too short, or containing sensitive secrets.
 */
export function sanitizeMemoryContent(text = '') {
  const cleaned = String(text || '')
    .replace(/\[\[\s*(?:END_CALL|MOOD|FEEL)[^\]]*\]\]/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned || cleaned.length < 4) return null;
  if (containsSensitiveSecret(cleaned)) return null;
  return cleaned.slice(0, 500);
}

// ---------------------------------------------------------------------------
// Metadata encoding/decoding for backward compatibility with 008_memories.sql
// ---------------------------------------------------------------------------

const TIER_PREFIX_RE = /^\[(semantic|episodic|emotional|working)(?::([a-z0-9_.-]+))?\]\s*/i;

/**
 * Parse a raw DB row from `memories` into a normalized tiered memory object.
 */
export function normalizeMemoryRow(row) {
  if (!row || typeof row !== 'object') return null;
  let content = String(row.content || '').trim();
  let memoryType = row.memory_type || 'semantic';
  let subjectKey = row.subject_key || null;

  const prefixMatch = content.match(TIER_PREFIX_RE);
  if (prefixMatch) {
    memoryType = prefixMatch[1].toLowerCase();
    if (prefixMatch[2] && !subjectKey) subjectKey = prefixMatch[2].toLowerCase();
    content = content.slice(prefixMatch[0].length).trim();
  } else if (!row.memory_type) {
    memoryType = inferMemoryType(content, row.source_call_id);
  }

  if (!subjectKey) {
    subjectKey = inferSubjectKey(content);
  }

  return {
    id: row.id,
    user_id: row.user_id,
    contact_id: row.contact_id || null,
    content,
    memory_type: MEMORY_TYPES.includes(memoryType) ? memoryType : 'semantic',
    subject_key: subjectKey,
    importance: Number.isFinite(row.importance) ? Number(row.importance) : inferImportance(content, memoryType),
    confidence: Number.isFinite(row.confidence) ? Number(row.confidence) : 0.85,
    emotional_valence: Number.isFinite(row.emotional_valence) ? Number(row.emotional_valence) : 0,
    source_call_id: row.source_call_id || null,
    created_at: row.created_at || new Date().toISOString(),
    updated_at: row.updated_at || row.created_at || new Date().toISOString(),
  };
}

/**
 * Infer whether a memory is `semantic`, `episodic`, or `emotional` from its
 * phrasing and whether it originated from a call summary.
 */
export function inferMemoryType(content = '', sourceCallId = null) {
  if (extractStandingRules(content).length) return 'instruction';
  const text = String(content || '').toLowerCase();
  if (
    /\b(feels|feeling|anxious|stressed|happy when|comforted|trusts|rapport|emotional|mood|sensitive about|toned|prefers a .* tone)\b/.test(
      text
    )
  ) {
    return 'emotional';
  }
  if (
    /\b(called|spoke|talked|asked|agreed|confirmed|scheduled|booked|promised|mentioned on the call|yesterday|last week|on monday|on tuesday|on wednesday|on thursday|on friday|appointment)\b/.test(
      text
    )
  ) {
    return 'episodic';
  }
  if (
    /\b(prefers|likes|loves|hates|allergic|works as|lives in|moved to|birthday|anniversary|sister|brother|mother|mom|mum|father|dad|wife|husband|partner|child|son|daughter|doctor|dentist|timezone|always|never|usually)\b/.test(
      text
    )
  ) {
    return 'semantic';
  }
  return sourceCallId ? 'episodic' : 'semantic';
}

/**
 * Infer a canonical `subject_key` for semantic facts so later corrections on
 * the same topic can supersede the old fact cleanly.
 */
export function inferSubjectKey(content = '') {
  const s = String(content || '').toLowerCase();
  const patterns = [
    { re: /\b(lives?\s+in|moved\s+to|located\s+in|home\s+city|based\s+in)\b/, key: 'user_location' },
    { re: /\b(works?\s+as|job\s+is|profession|occupation|works?\s+at)\b/, key: 'user_occupation' },
    { re: /\b(birthday|born\s+on)\b/, key: 'user_birthday' },
    { re: /\b(allergic\s+to|allergy|dietary)\b/, key: 'user_allergy_diet' },
    { re: /\b(sister'?s?\s+name|sister\s+is)\b/, key: 'family_sister' },
    { re: /\b(brother'?s?\s+name|brother\s+is)\b/, key: 'family_brother' },
    { re: /\b(mother'?s?\s+name|mom'?s?\s+name|mum'?s?\s+name)\b/, key: 'family_mother' },
    { re: /\b(father'?s?\s+name|dad'?s?\s+name)\b/, key: 'family_father' },
    { re: /\b(partner'?s?\s+name|wife'?s?\s+name|husband'?s?\s+name)\b/, key: 'family_partner' },
    { re: /\b(prefers?\s+.*calls?|best\s+time\s+to\s+call|call\s+preference)\b/, key: 'call_time_preference' },
    { re: /\b(favorite\s+food|favourite\s+food|loves?\s+eating)\b/, key: 'favorite_food' },
    { re: /\b(timezone|time\s+zone)\b/, key: 'user_timezone' },
  ];
  for (const p of patterns) {
    if (p.re.test(s)) return p.key;
  }
  return null;
}

export function inferImportance(content = '', memoryType = 'semantic') {
  const s = String(content || '').toLowerCase();
  let score = memoryType === 'semantic' ? 0.72 : memoryType === 'emotional' ? 0.68 : 0.58;
  if (/\b(important|always|never|allergic|emergency|doctor|medication|birthday|prefer)\b/.test(s)) {
    score += 0.15;
  }
  return Math.min(0.98, Number(score.toFixed(2)));
}

// ---------------------------------------------------------------------------
// Relevance + Recency Retrieval
// ---------------------------------------------------------------------------

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'that', 'this', 'with', 'from', 'have', 'has', 'had',
  'was', 'were', 'are', 'is', 'be', 'been', 'being', 'what', 'when', 'where',
  'who', 'whom', 'which', 'why', 'how', 'can', 'could', 'would', 'should',
  'will', 'shall', 'may', 'might', 'must', 'about', 'into', 'over', 'after',
  'before', 'between', 'under', 'again', 'further', 'then', 'once', 'here',
  'there', 'all', 'any', 'both', 'each', 'few', 'more', 'most', 'other',
  'some', 'such', 'only', 'own', 'same', 'than', 'too', 'very', 'just',
  'call', 'emysa', 'user', 'they', 'them', 'their', 'you', 'your', 'hers',
  'his', 'our', 'ours',
]);

export function tokenize(text = '') {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOP_WORDS.has(w));
}

/**
 * Score a normalized memory item against the current query context using
 * lexical overlap, contact match, tier weight, importance, and recency decay.
 */
export function scoreMemory(memory, { queryText = '', contactId = null, contactName = '', nowMs = Date.now() } = {}) {
  if (!memory || !memory.content) return 0;
  const memTokens = new Set(tokenize(memory.content));
  const queryTokens = tokenize(`${queryText} ${contactName}`);

  let overlap = 0;
  for (const qt of queryTokens) {
    if (memTokens.has(qt)) {
      overlap += 1;
    } else {
      for (const mt of memTokens) {
        if (mt.startsWith(qt) || qt.startsWith(mt)) {
          overlap += 0.5;
          break;
        }
      }
    }
  }
  const relevanceScore = queryTokens.length > 0 ? Math.min(1, overlap / Math.max(2, Math.min(queryTokens.length, 5))) : 0.25;

  // Contact match bonus
  let contactBonus = 0;
  if (contactId && memory.contact_id === contactId) {
    contactBonus = 0.45;
  } else if (contactName && memory.content.toLowerCase().includes(contactName.toLowerCase())) {
    contactBonus = 0.35;
  } else if (!contactId && !memory.contact_id) {
    contactBonus = 0.1;
  }

  // Recency decay (episodic decays faster than semantic)
  const createdMs = Date.parse(memory.updated_at || memory.created_at || '');
  const ageDays = Number.isFinite(createdMs) ? Math.max(0, (nowMs - createdMs) / 86_400_000) : 7;
  const decayLambda = memory.memory_type === 'episodic' ? 0.035 : 0.004;
  const recencyScore = Math.exp(-decayLambda * ageDays);

  const tierBonus =
    memory.memory_type === 'semantic' ? 0.18 : memory.memory_type === 'emotional' ? 0.15 : 0.1;

  const importance = Number.isFinite(memory.importance) ? memory.importance : 0.65;

  return Number(
    (
      relevanceScore * 0.42 +
      recencyScore * 0.22 +
      importance * 0.18 +
      tierBonus +
      contactBonus
    ).toFixed(4)
  );
}

/**
 * Retrieve and rank the most relevant memories for a user (and optional contact)
 * from Supabase. Gracefully returns empty results if Supabase fails.
 */
export async function retrieveRelevantMemories({
  supabase,
  userId,
  contactId = null,
  contactName = '',
  queryText = '',
  limit = 10,
  includeEpisodic = true,
} = {}) {
  if (!supabase || !userId) {
    return { memories: [], coreMemories: [], episodicMemories: [], emotionalMemories: [], instructionMemories: [], promptBlock: '' };
  }

  try {
    let query = supabase
      .from('memories')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(50);

    if (contactId && typeof query.or === 'function') {
      // Fetch both contact-specific and general user memories
      query = supabase
        .from('memories')
        .select('*')
        .eq('user_id', userId)
        .or(`contact_id.eq.${contactId},contact_id.is.null`)
        .order('created_at', { ascending: false })
        .limit(50);
    }

    const { data, error } = await query;
    if (error || !Array.isArray(data)) {
      return { memories: [], coreMemories: [], episodicMemories: [], emotionalMemories: [], promptBlock: '' };
    }

    // Standing rules are loaded on their own, never by recency: otherwise a rule saved
    // months ago would fall out of the 50 newest memories and silently stop applying.
    let instructionMemories = [];
    try {
      let iq = supabase.from('memories').select('*').eq('user_id', userId).eq('memory_type', 'instruction');
      iq = contactId ? iq.or(`contact_id.eq.${contactId},contact_id.is.null`) : iq.is('contact_id', null);
      const { data: ruleRows } = await iq.order('created_at', { ascending: false }).limit(30);
      if (Array.isArray(ruleRows)) instructionMemories = ruleRows.map(normalizeMemoryRow).filter(Boolean);
    } catch { /* rules are best effort; the rest of memory still loads */ }

    const normalized = data.map(normalizeMemoryRow).filter((m) => m && m.memory_type !== 'instruction');
    const scored = normalized
      .map((m) => ({
        ...m,
        _score: scoreMemory(m, { queryText, contactId, contactName }),
      }))
      .sort((a, b) => b._score - a._score)
      .slice(0, limit);

    const coreMemories = scored.filter((m) => m.memory_type === 'semantic');
    const emotionalMemories = scored.filter((m) => m.memory_type === 'emotional');
    const episodicMemories = includeEpisodic ? scored.filter((m) => m.memory_type === 'episodic') : [];

    const promptBlock = formatMemoryBlockForPrompt({
      instructionMemories,
      coreMemories,
      emotionalMemories,
      episodicMemories,
    });

    return {
      memories: [...instructionMemories, ...coreMemories, ...emotionalMemories, ...episodicMemories],
      instructionMemories,
      coreMemories,
      episodicMemories,
      emotionalMemories,
      promptBlock,
    };
  } catch {
    return { memories: [], coreMemories: [], episodicMemories: [], emotionalMemories: [], instructionMemories: [], promptBlock: '' };
  }
}

/**
 * Format tiered memories into a structured Letta-style memory block for
 * system prompt injection.
 */
export function formatMemoryBlockForPrompt({
  instructionMemories = [],
  coreMemories = [],
  emotionalMemories = [],
  episodicMemories = [],
} = {}) {
  const sections = [];
  if (instructionMemories.length > 0) {
    sections.push(
      `  <standing_instructions note="The user's own do / don't rules. Follow them on every call unless this call's instructions say otherwise.">\n${instructionMemories.map((m) => `    - ${m.content}`).join('\n')}\n  </standing_instructions>`
    );
  }
  if (coreMemories.length > 0) {
    sections.push(
      `  <core_semantic_memory>\n${coreMemories.map((m) => `    - ${m.content}`).join('\n')}\n  </core_semantic_memory>`
    );
  }
  if (emotionalMemories.length > 0) {
    sections.push(
      `  <relationship_and_emotional_memory>\n${emotionalMemories.map((m) => `    - ${m.content}`).join('\n')}\n  </relationship_and_emotional_memory>`
    );
  }
  if (episodicMemories.length > 0) {
    sections.push(
      `  <recent_episodic_memory>\n${episodicMemories.map((m) => `    - ${m.content}`).join('\n')}\n  </recent_episodic_memory>`
    );
  }
  if (sections.length === 0) return '';
  const note = `  <note>Memory is background only. This call's own instructions decide what to do. Never continue, repeat or bring up a previous call's topic unless this call's instructions ask for it.</note>`;
  return `<persistent_memory>\n${note}\n${sections.join('\n')}\n</persistent_memory>`;
}

// ---------------------------------------------------------------------------
// Contradiction, Correction & Real-time Turn Memory Extraction
// ---------------------------------------------------------------------------

/**
 * Inspect a user's message for explicit memory operations:
 *   - `forget`: user asks to forget/remove a topic
 *   - `correct`: user corrects a previous fact ("actually I live in Seattle, not Austin")
 *   - `remember`: user shares a durable personal fact/preference
 */
export function detectUserMemoryOperations(userText = '') {
  const text = String(userText || '').trim();
  const ops = {
    forgetTopics: [],
    corrections: [],
    newFacts: [],
  };
  if (!text || text.length < 5) return ops;

  // 1. Explicit forget / delete requests
  const forgetMatch = text.match(
    /\b(?:forget\s+(?:that\s+)?|delete\s+(?:the\s+)?memory\s+(?:that\s+|about\s+)?|don'?t\s+remember\s+(?:that\s+)?)(.+?)(?:[.!?]|$)/i
  );
  if (forgetMatch && forgetMatch[1]) {
    ops.forgetTopics.push(forgetMatch[1].trim());
  }

  // 2. Explicit corrections ("Actually my X is Y, not Z" / "I moved to Y" / "Correction: ...")
  const correctionPatterns = [
    /\b(?:actually|correction|just\s+so\s+you\s+know|update)\s*[,:]?\s*(?:my\s+|i\s+)(.+?)(?:[.!?]|$)/i,
    /\bi\s+(?:no\s+longer|don'?t\s+anymore|stopped|moved\s+to|switched\s+to|changed\s+my)\s+(.+?)(?:[.!?]|$)/i,
  ];
  for (const re of correctionPatterns) {
    const m = text.match(re);
    if (m && m[0]) {
      const candidate = sanitizeMemoryContent(m[0]);
      if (candidate) {
        ops.corrections.push({
          content: candidate,
          memory_type: inferMemoryType(candidate),
          subject_key: inferSubjectKey(candidate),
        });
      }
    }
  }

  // 3. Explicit "remember that..." or durable personal preferences/facts
  const rememberPatterns = [
    /\b(?:please\s+)?remember\s+(?:that\s+)?(.+?)(?:[.!?]|$)/i,
    /\bmy\s+(sister|brother|mom|mum|mother|dad|father|wife|husband|partner|son|daughter|doctor|dentist|boss|best\s+friend)(?:'s\s+name)?\s+is\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/,
    /\bi\s+(?:live\s+in|work\s+as|am\s+allergic\s+to|always\s+prefer|really\s+love|really\s+hate)\s+(.+?)(?:[.!?]|$)/i,
  ];
  for (const re of rememberPatterns) {
    const m = text.match(re);
    if (m && m[0]) {
      const rawFact = m[1] && /^remember/i.test(m[0]) ? m[1] : m[0];
      const candidate = sanitizeMemoryContent(rawFact);
      if (candidate && !ops.corrections.some((c) => c.content === candidate)) {
        ops.newFacts.push({
          content: candidate,
          memory_type: inferMemoryType(candidate),
          subject_key: inferSubjectKey(candidate),
        });
      }
    }
  }

  // 4. Standing do / don't rules ("never mention the price", "from now on keep calls short")
  for (const rule of extractStandingRules(text)) {
    const candidate = sanitizeMemoryContent(rule);
    if (!candidate || ops.newFacts.some((f) => f.content === candidate || candidate.includes(f.content))) continue;
    // A rule replaces any plain "remember that..." capture of the same sentence.
    ops.newFacts = ops.newFacts.filter((f) => !f.content.includes(candidate) && !candidate.includes(f.content));
    ops.newFacts.push({ content: candidate, memory_type: 'instruction', subject_key: ruleSubjectKey(candidate), importance: 1 });
  }

  return ops;
}

/**
 * Determine whether two memories refer to the same underlying subject or are
 * near-duplicates so the newer one should update/supersede the older one.
 */
export function isSameOrConflictingTopic(existingRow, candidate) {
  const existing = normalizeMemoryRow(existingRow);
  if (!existing || !candidate) return false;

  const existingNorm = existing.content.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
  const candNorm = String(candidate.content || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
  if (!candNorm) return false;
  if (existingNorm === candNorm) return 'duplicate';

  // Same canonical subject_key on the same contact
  const candKey = candidate.subject_key || inferSubjectKey(candidate.content);
  if (
    candKey &&
    existing.subject_key === candKey &&
    (existing.contact_id || null) === (candidate.contact_id || null)
  ) {
    return 'contradiction';
  }

  // Facts about different people never overwrite each other.
  if ((existing.contact_id || null) !== (candidate.contact_id || null)) return false;

  // High lexical overlap in short semantic facts (e.g. "Sister's name is Maya" vs "Sister's name is Sara")
  const tokensA = tokenize(existing.content);
  const tokensB = tokenize(candidate.content);
  if (tokensA.length >= 2 && tokensB.length >= 2 && existing.memory_type === 'semantic') {
    const setA = new Set(tokensA);
    const shared = tokensB.filter((t) => setA.has(t));
    const ratio = shared.length / Math.min(tokensA.length, tokensB.length);
    if (ratio >= 0.75) {
      return 'contradiction';
    }
  }

  return false;
}

/**
 * Persist a list of candidate memories for a user, automatically resolving
 * duplicates, contradictions, and explicit user forget requests.
 */
export async function consolidateAndStoreMemories({
  supabase,
  userId,
  contactId = null,
  sourceCallId = null,
  candidates = [],
  forgetTopics = [],
  observedAt = null,
} = {}) {
  const result = { inserted: 0, updated: 0, deleted: 0, failed: 0, error: null };
  if (!supabase || !userId) return result;
  // Safe log: ids and counts only, never the memory text.
  const log = (event, extra = {}) => console.log(`[memory] ${event}`, { callId: sourceCallId, contact: contactId ? 'set' : 'none', ...extra });
  try {
    // Only this contact's memories are candidates for update or de-duplication, so a
    // fact about one person can never overwrite or suppress another person's.
    let query = supabase.from('memories').select('*').eq('user_id', userId);
    query = contactId ? query.eq('contact_id', contactId) : query.is('contact_id', null);
    const { data: existingRows, error: readError } = await query.order('created_at', { ascending: false }).limit(100);
    if (readError) throw new Error(readError.message);
    const existing = (Array.isArray(existingRows) ? existingRows : []).filter((r) => r.status !== 'superseded');

    for (const topic of forgetTopics) {
      const topicTokens = tokenize(topic);
      if (!topicTokens.length) continue;
      for (const row of existing) {
        const rowText = String(row.content || '').toLowerCase();
        if (topicTokens.every((t) => rowText.includes(t))) {
          const { error } = await supabase.from('memories').delete().eq('id', row.id).eq('user_id', userId);
          if (error) result.failed += 1; else result.deleted += 1;
        }
      }
    }

    for (const rawCand of candidates) {
      const text = typeof rawCand === 'string' ? rawCand : rawCand?.content;
      const clean = sanitizeMemoryContent(text);
      if (!clean) continue;
      const obj = typeof rawCand === 'object' && rawCand ? rawCand : {};
      const memoryType = obj.memory_type || inferMemoryType(clean, sourceCallId);
      const subjectKey = obj.subject_key || inferSubjectKey(clean);
      const status = obj.status === 'uncertain' ? 'uncertain' : 'confirmed';
      const provenance = { status, evidence: obj.evidence || null, observed_at: obj.observed_at || observedAt || null };
      const candidateObj = { content: clean, memory_type: memoryType, subject_key: subjectKey, contact_id: contactId || null };

      let matchRow = null;
      let matchKind = false;
      for (const row of existing) {
        const kind = isSameOrConflictingTopic(row, candidateObj);
        if (kind) { matchRow = row; matchKind = kind; break; }
      }
      if (matchKind === 'duplicate') continue;

      // A later, reliable statement corrects the earlier one in place. An uncertain
      // interpretation never overwrites a confirmed fact.
      if (matchKind === 'contradiction' && matchRow?.id) {
        if (status === 'uncertain' && matchRow.status !== 'uncertain') continue;
        const updateRes = await safeUpdateMemoryRow(supabase, matchRow.id, userId, {
          content: clean, memory_type: memoryType, subject_key: subjectKey,
          source_call_id: sourceCallId || matchRow.source_call_id || null,
          previous_content: matchRow.content, ...provenance,
        });
        if (updateRes) result.updated += 1; else result.failed += 1;
        continue;
      }

      const insertRes = await safeInsertMemoryRow(supabase, {
        user_id: userId, contact_id: contactId || null, content: clean, memory_type: memoryType,
        subject_key: subjectKey, importance: inferImportance(clean, memoryType), source_call_id: sourceCallId || null,
        ...provenance,
      });
      if (insertRes) { result.inserted += 1; existing.unshift(insertRes); } else result.failed += 1;
    }
  } catch (err) {
    result.failed += 1;
    result.error = String(err?.message || err).slice(0, 200);
    console.error('[memory] consolidation failed', { callId: sourceCallId, error: result.error });
  }
  log('write finished', { inserted: result.inserted, updated: result.updated, deleted: result.deleted, failed: result.failed });
  return result;
}

/**
 * Insert a memory row using the extended schema (`memory_type`, `subject_key`,
 * `importance`), falling back transparently to the base 008 schema if the
 * extended columns are not present in Supabase yet.
 */
export async function safeInsertMemoryRow(supabase, payload) {
  const {
    user_id, contact_id = null, content, memory_type = 'semantic', subject_key = null,
    importance = 0.7, source_call_id = null, status = 'confirmed', evidence = null, observed_at = null,
  } = payload;
  const clean = sanitizeMemoryContent(content);
  if (!clean) return null;

  const base = { user_id, contact_id, content: clean, memory_type, subject_key, importance, source_call_id };
  const provenance = { status, evidence: evidence ? String(evidence).slice(0, 300) : null, observed_at };
  // Provenance columns arrive with sql/029, the type columns with 016. Try the richest
  // shape first and step down, so an un-migrated database still saves the fact.
  const shapes = [{ ...base, ...provenance }, base, { user_id, contact_id, content: clean, source_call_id }];
  let lastError = null;
  for (const [i, row] of shapes.entries()) {
    const { data, error } = await supabase.from('memories').insert(row).select('*').single();
    if (!error && data) return data;
    lastError = error;
    if (i === shapes.length - 1) break;
  }
  console.error('[memory] insert failed', { callId: source_call_id, error: String(lastError?.message || 'unknown').slice(0, 160) });
  return null;
}

export async function safeUpdateMemoryRow(supabase, id, userId, patch) {
  const clean = sanitizeMemoryContent(patch.content);
  if (!clean) return null;
  const core = {
    content: clean,
    ...(patch.memory_type ? { memory_type: patch.memory_type } : {}),
    ...(patch.subject_key !== undefined ? { subject_key: patch.subject_key } : {}),
    ...(patch.source_call_id !== undefined ? { source_call_id: patch.source_call_id } : {}),
    updated_at: new Date().toISOString(),
  };
  const provenance = {
    ...(patch.status ? { status: patch.status } : {}),
    ...(patch.evidence !== undefined ? { evidence: patch.evidence ? String(patch.evidence).slice(0, 300) : null } : {}),
    ...(patch.observed_at ? { observed_at: patch.observed_at } : {}),
    ...(patch.previous_content ? { previous_content: String(patch.previous_content).slice(0, 500) } : {}),
  };
  let lastError = null;
  for (const row of [{ ...core, ...provenance }, core, { content: clean }]) {
    const { data, error } = await supabase.from('memories').update(row).eq('id', id).eq('user_id', userId).select('*').single();
    if (!error && data) return data;
    lastError = error;
  }
  console.error('[memory] update failed', { error: String(lastError?.message || 'unknown').slice(0, 160) });
  return null;
}

// ---------------------------------------------------------------------------
// Persistent Emotional State Load & Save
// ---------------------------------------------------------------------------

export async function loadEmotionalState({ supabase, userId, contactId = null } = {}) {
  const cached = emotionStateCache.get(cacheKey(userId, contactId));
  if (!supabase || !userId) {
    return decayEmotionalState(cached || createInitialEmotionState());
  }

  try {
    let q = supabase
      .from('user_emotional_states')
      .select('state_json, updated_at')
      .eq('user_id', userId);
    if (contactId) {
      q = q.eq('contact_id', contactId);
    } else {
      q = q.is('contact_id', null);
    }
    const { data, error } = await q.maybeSingle();
    if (!error && data?.state_json && typeof data.state_json === 'object') {
      const state = decayEmotionalState({
        ...createInitialEmotionState(),
        ...data.state_json,
        updatedAt: data.updated_at || data.state_json.updatedAt,
      });
      setCachedEmotion(userId, contactId, state);
      return state;
    }
  } catch {
    // Table may not exist yet; use cache
  }

  const fallback = decayEmotionalState(cached || createInitialEmotionState());
  setCachedEmotion(userId, contactId, fallback);
  return fallback;
}

export async function saveEmotionalState({ supabase, userId, contactId = null, state } = {}) {
  if (!state) return;
  setCachedEmotion(userId, contactId, state);
  if (!supabase || !userId) return;

  try {
    await supabase.from('user_emotional_states').upsert(
      {
        user_id: userId,
        contact_id: contactId || null,
        state_json: state,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id,contact_id' }
    );
  } catch {
    // Non-fatal if migration 016 is not yet applied
  }
}

/**
 * Convenience helper for a conversation turn: loads & appraises emotional state,
 * retrieves relevant tiered memories, and returns the combined context along
 * with an async `commitTurn` callback to persist mood & memory updates without
 * blocking the user response.
 */
export async function prepareTurnContext({
  supabase,
  userId,
  contactId = null,
  contactName = '',
  userText = '',
  isVoiceCall = false,
  wasInterrupted = false,
} = {}) {
  const [prevEmotion, memoryBundle] = await Promise.all([
    loadEmotionalState({ supabase, userId, contactId }),
    retrieveRelevantMemories({
      supabase,
      userId,
      contactId,
      contactName,
      queryText: userText,
      limit: 10,
    }),
  ]);

  const emotionState = appraiseTurn(prevEmotion, userText, {
    isVoiceCall,
    wasInterrupted,
  });

  const memoryOps = detectUserMemoryOperations(userText);

  const commitTurn = async ({ moodTag = null, extraMemories = [], sourceCallId = null } = {}) => {
    const finalEmotion = moodTag ? applyInlineMoodUpdate(emotionState, moodTag) : emotionState;
    await saveEmotionalState({ supabase, userId, contactId, state: finalEmotion });

    const allCandidates = [
      ...memoryOps.corrections,
      ...memoryOps.newFacts,
      ...extraMemories,
    ];
    if (allCandidates.length > 0 || memoryOps.forgetTopics.length > 0) {
      await consolidateAndStoreMemories({
        supabase,
        userId,
        contactId,
        sourceCallId,
        candidates: allCandidates,
        forgetTopics: memoryOps.forgetTopics,
      });
    }
    return finalEmotion;
  };

  return {
    emotionState,
    memoryBundle,
    memoryOps,
    commitTurn,
  };
}
