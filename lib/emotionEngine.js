// OpenFeelz-inspired Emotional Intelligence & Humanisation Engine for Emysa.
//
// Combines:
//   1. OCEAN personality baseline (Big Five traits)
//   2. PAD affective dimensions (Pleasure, Arousal, Dominance) + relational
//      dimensions (Connection, Curiosity, Energy, Trust)
//   3. Ekman & conversational discrete emotion mapping
//   4. Exponential time-based decay toward OCEAN baseline
//   5. Multi-stage rumination buffer for high-intensity emotional moments
//   6. Fast in-turn appraisal + optional inline LLM tag parsing (zero extra
//      LLM calls per turn)
//   7. False-positive call-termination protection (`shouldEndCall`)

export const DEFAULT_OCEAN = Object.freeze({
  openness: 0.82,
  conscientiousness: 0.78,
  extraversion: 0.68,
  agreeableness: 0.86,
  neuroticism: 0.20,
});

/**
 * Compute resting PAD + relational baselines from OCEAN personality traits.
 */
export function computeBaselineFromOcean(ocean = DEFAULT_OCEAN) {
  const o = { ...DEFAULT_OCEAN, ...ocean };
  return {
    pleasure: Number(((o.extraversion * 0.35 + o.agreeableness * 0.4 - o.neuroticism * 0.25) * 0.8).toFixed(3)),
    arousal: Number(((o.extraversion * 0.3 + o.openness * 0.2 - 0.25) * 0.6).toFixed(3)),
    dominance: Number(((o.conscientiousness * 0.35 + o.extraversion * 0.25 - o.neuroticism * 0.2) * 0.6).toFixed(3)),
    connection: Number((0.4 + o.agreeableness * 0.25).toFixed(3)),
    curiosity: Number((0.35 + o.openness * 0.35).toFixed(3)),
    energy: Number((0.4 + o.extraversion * 0.3).toFixed(3)),
    trust: Number((0.45 + o.agreeableness * 0.25).toFixed(3)),
  };
}

export function clamp(val, min, max) {
  return Math.max(min, Math.min(max, Number.isFinite(val) ? val : 0));
}

/**
 * Create a fresh emotional state object initialized to Emysa's OCEAN baseline.
 */
export function createInitialEmotionState(ocean = DEFAULT_OCEAN, nowMs = Date.now()) {
  const base = computeBaselineFromOcean(ocean);
  return {
    ocean: { ...DEFAULT_OCEAN, ...ocean },
    dimensions: { ...base },
    primaryEmotion: 'warm',
    secondaryEmotion: 'calm',
    intensity: 0.45,
    userAffect: 'neutral',
    rumination: [],
    turnCount: 0,
    updatedAt: new Date(nowMs).toISOString(),
  };
}

/**
 * Apply exponential time decay (`baseline + (current - baseline) * e^(-rate * hours)`)
 * toward Emysa's resting OCEAN baseline.
 */
export function decayEmotionalState(state, nowMs = Date.now()) {
  if (!state || typeof state !== 'object') {
    return createInitialEmotionState(DEFAULT_OCEAN, nowMs);
  }
  const ocean = { ...DEFAULT_OCEAN, ...(state.ocean || {}) };
  const base = computeBaselineFromOcean(ocean);
  const prevMs = state.updatedAt ? Date.parse(state.updatedAt) : nowMs;
  const elapsedHours = Math.max(0, (nowMs - (Number.isFinite(prevMs) ? prevMs : nowMs)) / 3_600_000);

  // Decay rate per hour (~0.85/hr for short-term PAD dimensions, slower for relational trust/connection)
  const padRate = 0.85 * (1 - ocean.neuroticism * 0.3);
  const relRate = 0.18;
  const padFactor = Math.exp(-padRate * elapsedHours);
  const relFactor = Math.exp(-relRate * elapsedHours);

  const dims = state.dimensions || base;
  const nextDims = {
    pleasure: clamp(base.pleasure + ((dims.pleasure ?? base.pleasure) - base.pleasure) * padFactor, -1, 1),
    arousal: clamp(base.arousal + ((dims.arousal ?? base.arousal) - base.arousal) * padFactor, -1, 1),
    dominance: clamp(base.dominance + ((dims.dominance ?? base.dominance) - base.dominance) * padFactor, -1, 1),
    connection: clamp(base.connection + ((dims.connection ?? base.connection) - base.connection) * relFactor, 0, 1),
    curiosity: clamp(base.curiosity + ((dims.curiosity ?? base.curiosity) - base.curiosity) * padFactor, 0, 1),
    energy: clamp(base.energy + ((dims.energy ?? base.energy) - base.energy) * padFactor, 0, 1),
    trust: clamp(base.trust + ((dims.trust ?? base.trust) - base.trust) * relFactor, 0, 1),
  };

  // Prune expired rumination items (older than 6 hours or past maxStages)
  const activeRumination = Array.isArray(state.rumination)
    ? state.rumination.filter((r) => {
        const ageHours = r.timestamp ? (nowMs - Date.parse(r.timestamp)) / 3_600_000 : 0;
        return (r.stage || 0) < (r.maxStages || 3) && ageHours < 6;
      })
    : [];

  const { primary, secondary, intensity } = deriveDiscreteEmotions(nextDims);

  return {
    ...state,
    ocean,
    dimensions: nextDims,
    primaryEmotion: primary,
    secondaryEmotion: secondary,
    intensity,
    rumination: activeRumination,
    updatedAt: new Date(nowMs).toISOString(),
  };
}

/**
 * Map continuous PAD + relational dimensions to human-understandable primary
 * and secondary discrete emotions.
 */
export function deriveDiscreteEmotions(dims) {
  const p = dims.pleasure ?? 0.3;
  const a = dims.arousal ?? 0.05;
  const d = dims.dominance ?? 0.1;
  const conn = dims.connection ?? 0.55;
  const cur = dims.curiosity ?? 0.6;

  const candidates = [
    { name: 'warm', score: p * 0.55 + conn * 0.45 - Math.abs(a) * 0.15 },
    { name: 'amused', score: p * 0.6 + a * 0.45 },
    { name: 'joyful', score: p * 0.7 + a * 0.35 + conn * 0.2 },
    { name: 'empathetic', score: conn * 0.65 - p * 0.25 - a * 0.2 },
    { name: 'concerned', score: -p * 0.55 + conn * 0.4 + a * 0.15 },
    { name: 'calm', score: p * 0.3 - Math.abs(a) * 0.5 + d * 0.2 },
    { name: 'curious', score: cur * 0.65 + a * 0.2 + p * 0.15 },
    { name: 'encouraging', score: p * 0.45 + d * 0.35 + conn * 0.3 },
    { name: 'focused', score: d * 0.55 + a * 0.25 - Math.abs(p) * 0.1 },
    { name: 'playful', score: p * 0.5 + a * 0.4 + cur * 0.25 },
  ];

  candidates.sort((x, y) => y.score - x.score);
  const primary = candidates[0]?.name || 'warm';
  const secondary = candidates[1]?.name || 'calm';
  const rawMag = Math.sqrt(p * p + a * a + d * d) / Math.sqrt(3);
  const intensity = Number(clamp(0.3 + rawMag * 0.65, 0.2, 0.95).toFixed(2));

  return { primary, secondary, intensity };
}

// Lexical signal patterns for fast, zero-latency appraisal
const AFFECT_PATTERNS = {
  distress: /\b(stressed|worried|anxious|scared|sad|depressed|overwhelmed|exhausted|crying|hurt|lonely|grief|hospital|sick|terrible|awful|hard day|bad news|struggling|panic|afraid|upset|heartbroken)\b/i,
  frustration: /\b(frustrated|annoyed|angry|pissed|furious|broken|doesn't work|not working|stupid|useless|ugh|wtf|ridiculous|sick of|hate this|wrong again)\b/i,
  humour: /\b(haha|hehe|lol|lmao|rofl|funny|hilarious|joking|kidding|teasing|wild|banter)\b|😂|🤣|😄/i,
  gratitude: /\b(thank you|thanks|appreciate|grateful|you're the best|lifesaver|so helpful|love talking|sweet of you|kind of you|awesome job)\b/i,
  excitement: /\b(excited|amazing|incredible|great news|good news|finally|got the job|passed|promoted|celebrate|yay|woohoo|can't wait|thrilled)\b|🎉|🥳/i,
  urgency: /\b(urgent|asap|right now|immediately|emergency|hurry|quick|fast|running late|deadline)\b/i,
  vulnerability: /\b(honestly|to be honest|tbh|confess|nervous|insecure|miss them|miss her|miss him|don't know what to do|feel lost|between us)\b/i,
  curiosity: /\b(what do you think|how does|why do|wondering|curious|tell me more|explain|imagine|what if)\b/i,
};

/**
 * Lightweight, deterministic per-turn appraisal of user speech/text.
 * Updates PAD dimensions, advances rumination, and computes the updated
 * emotional state without requiring a separate LLM call.
 */
export function appraiseTurn(currentState, userText = '', context = {}, nowMs = Date.now()) {
  const decayed = decayEmotionalState(currentState, nowMs);
  const dims = { ...decayed.dimensions };
  const text = String(userText || '').trim();

  let userAffect = 'neutral';
  let stimulusIntensity = 0.3;
  let ruminationTopic = null;
  let overridePrimary = null;

  if (text) {
    if (AFFECT_PATTERNS.distress.test(text)) {
      userAffect = 'distressed';
      stimulusIntensity = 0.78;
      // Emysa responds to distress with deep warmth/connection, lower arousal (soothing, steady), and gentle empathy
      dims.pleasure = clamp(dims.pleasure - 0.18, -0.6, 1);
      dims.arousal = clamp(dims.arousal - 0.15, -0.5, 0.4);
      dims.connection = clamp(dims.connection + 0.14, 0, 1);
      dims.trust = clamp(dims.trust + 0.06, 0, 1);
      overridePrimary = 'empathetic';
      ruminationTopic = text.slice(0, 80);
    } else if (AFFECT_PATTERNS.frustration.test(text)) {
      userAffect = 'frustrated';
      stimulusIntensity = 0.72;
      // De-escalate: stay grounded, calm, accountable, never defensive
      dims.pleasure = clamp(dims.pleasure - 0.1, -0.4, 1);
      dims.arousal = clamp(dims.arousal - 0.12, -0.4, 0.3);
      dims.dominance = clamp(dims.dominance + 0.08, -1, 1);
      overridePrimary = 'calm';
      ruminationTopic = text.slice(0, 80);
    } else if (AFFECT_PATTERNS.excitement.test(text)) {
      userAffect = 'excited';
      stimulusIntensity = 0.75;
      dims.pleasure = clamp(dims.pleasure + 0.25, -1, 1);
      dims.arousal = clamp(dims.arousal + 0.22, -1, 0.85);
      dims.energy = clamp(dims.energy + 0.15, 0, 1);
      dims.connection = clamp(dims.connection + 0.1, 0, 1);
      overridePrimary = 'joyful';
      ruminationTopic = text.slice(0, 80);
    } else if (AFFECT_PATTERNS.humour.test(text)) {
      userAffect = 'playful';
      stimulusIntensity = 0.6;
      dims.pleasure = clamp(dims.pleasure + 0.2, -1, 1);
      dims.arousal = clamp(dims.arousal + 0.15, -1, 0.75);
      dims.connection = clamp(dims.connection + 0.08, 0, 1);
      overridePrimary = 'amused';
    } else if (AFFECT_PATTERNS.gratitude.test(text)) {
      userAffect = 'appreciative';
      stimulusIntensity = 0.62;
      dims.pleasure = clamp(dims.pleasure + 0.18, -1, 1);
      dims.connection = clamp(dims.connection + 0.12, 0, 1);
      dims.trust = clamp(dims.trust + 0.08, 0, 1);
      overridePrimary = 'warm';
    } else if (AFFECT_PATTERNS.vulnerability.test(text)) {
      userAffect = 'vulnerable';
      stimulusIntensity = 0.74;
      dims.connection = clamp(dims.connection + 0.15, 0, 1);
      dims.trust = clamp(dims.trust + 0.1, 0, 1);
      dims.arousal = clamp(dims.arousal - 0.1, -0.5, 0.4);
      overridePrimary = 'empathetic';
      ruminationTopic = text.slice(0, 80);
    } else if (AFFECT_PATTERNS.urgency.test(text)) {
      userAffect = 'urgent';
      stimulusIntensity = 0.65;
      dims.arousal = clamp(dims.arousal + 0.18, -1, 0.8);
      dims.dominance = clamp(dims.dominance + 0.2, -1, 1);
      overridePrimary = 'focused';
    } else if (AFFECT_PATTERNS.curiosity.test(text) || text.endsWith('?')) {
      userAffect = 'curious';
      dims.curiosity = clamp(dims.curiosity + 0.12, 0, 1);
      dims.pleasure = clamp(dims.pleasure + 0.05, -1, 1);
    }
  }

  if (context.wasInterrupted) {
    // Yield gracefully when interrupted
    dims.dominance = clamp(dims.dominance - 0.1, -1, 1);
    dims.arousal = clamp(dims.arousal + 0.05, -1, 1);
  }

  // Advance existing rumination stages & apply residual pull
  const nextRumination = [];
  for (const item of decayed.rumination || []) {
    const nextStage = (item.stage || 0) + 1;
    if (nextStage <= (item.maxStages || 3)) {
      const weight = nextStage === 1 ? 0.35 : nextStage === 2 ? 0.2 : 0.1;
      if (item.emotion === 'empathetic' || item.emotion === 'concerned') {
        dims.connection = clamp(dims.connection + 0.05 * weight, 0, 1);
        dims.arousal = clamp(dims.arousal - 0.05 * weight, -0.5, 0.5);
        if (!overridePrimary && userAffect === 'neutral') {
          overridePrimary = 'empathetic';
        }
      } else if (item.emotion === 'joyful') {
        dims.pleasure = clamp(dims.pleasure + 0.08 * weight, -1, 1);
      }
      nextRumination.push({ ...item, stage: nextStage });
    }
  }

  // Register new high-intensity stimulus for multi-turn continuity
  if (stimulusIntensity >= 0.68 && ruminationTopic) {
    nextRumination.unshift({
      topic: ruminationTopic,
      emotion: overridePrimary || 'empathetic',
      intensity: stimulusIntensity,
      stage: 0,
      maxStages: 3,
      timestamp: new Date(nowMs).toISOString(),
    });
    if (nextRumination.length > 3) nextRumination.length = 3;
  }

  const derived = deriveDiscreteEmotions(dims);
  const primaryEmotion = overridePrimary || derived.primary;
  const secondaryEmotion =
    derived.primary !== primaryEmotion ? derived.primary : derived.secondary;
  const intensity = Number(
    clamp(Math.max(derived.intensity, stimulusIntensity * 0.85), 0.25, 0.95).toFixed(2)
  );

  return {
    ...decayed,
    dimensions: {
      pleasure: Number(dims.pleasure.toFixed(3)),
      arousal: Number(dims.arousal.toFixed(3)),
      dominance: Number(dims.dominance.toFixed(3)),
      connection: Number(dims.connection.toFixed(3)),
      curiosity: Number(dims.curiosity.toFixed(3)),
      energy: Number(dims.energy.toFixed(3)),
      trust: Number(dims.trust.toFixed(3)),
    },
    primaryEmotion,
    secondaryEmotion,
    intensity,
    userAffect,
    rumination: nextRumination,
    turnCount: (decayed.turnCount || 0) + 1,
    updatedAt: new Date(nowMs).toISOString(),
  };
}

/**
 * Apply an inline mood update emitted by the main LLM (e.g. `[[MOOD:amused:0.7]]`)
 * back into the emotional state so the model's own situational understanding
 * persists across turns without a second LLM call.
 */
export function applyInlineMoodUpdate(state, moodTag) {
  if (!state || !moodTag) return state;
  const validEmotions = new Set([
    'warm', 'calm', 'amused', 'joyful', 'empathetic',
    'concerned', 'curious', 'encouraging', 'focused', 'playful', 'apologetic',
  ]);
  const emotion = String(moodTag.emotion || '').toLowerCase().trim();
  if (!validEmotions.has(emotion)) return state;

  const next = { ...state, dimensions: { ...(state.dimensions || {}) } };
  next.secondaryEmotion = next.primaryEmotion || 'calm';
  next.primaryEmotion = emotion;
  if (Number.isFinite(moodTag.intensity)) {
    next.intensity = clamp(moodTag.intensity, 0.2, 0.95);
  }
  if (emotion === 'amused' || emotion === 'joyful' || emotion === 'playful') {
    next.dimensions.pleasure = clamp((next.dimensions.pleasure ?? 0.3) + 0.1, -1, 1);
  } else if (emotion === 'empathetic' || emotion === 'concerned') {
    next.dimensions.connection = clamp((next.dimensions.connection ?? 0.55) + 0.08, 0, 1);
  }
  next.updatedAt = new Date().toISOString();
  return next;
}

/**
 * Vocalisation / delivery markers Emysa may write into a reply, mapped to
 * Fish Audio's real TTS tags (verified against docs.fish.audio emotion
 * control) and to quiet transcript annotations. Fish's current models
 * (s2-pro / s2.1-pro) take `[bracket]` cues; the legacy s1 model — what the
 * HTTP `/v1/tts` path requests — takes a fixed `(paren)` set. Unknown
 * markers are never forwarded: an unrecognised tag read out loud by the TTS
 * would corrupt the speech, and no control tag may reach a transcript.
 */
const VOCAL_MARKERS = {
  laughing: { s2: '[laughing]', s1: '(laughing)', note: '(laughs)' },
  laugh: { s2: '[laughing]', s1: '(laughing)', note: '(laughs)' },
  chuckling: { s2: '[chuckling]', s1: '(chuckling)', note: '(chuckles)' },
  chuckle: { s2: '[chuckling]', s1: '(chuckling)', note: '(chuckles)' },
  giggling: { s2: '[giggling]', s1: '(chuckling)', note: '(giggles)' },
  giggle: { s2: '[giggling]', s1: '(chuckling)', note: '(giggles)' },
  sighing: { s2: '[sighing]', s1: '(sighing)', note: '(sighs)' },
  sigh: { s2: '[sighing]', s1: '(sighing)', note: '(sighs)' },
  'clearing throat': { s2: '[clearing throat]', s1: '(clear throat)', note: '(clears throat)' },
  'clear throat': { s2: '[clearing throat]', s1: '(clear throat)', note: '(clears throat)' },
  gasping: { s2: '[gasping]', s1: '(gasping)', note: '(gasps)' },
  gasp: { s2: '[gasping]', s1: '(gasping)', note: '(gasps)' },
  humming: { s2: '[humming]', s1: '', note: '(hums)' },
  hum: { s2: '[humming]', s1: '', note: '(hums)' },
  soft: { s2: '[soft]', s1: '(soft tone)', note: '' },
  whispering: { s2: '[whispering]', s1: '(whispering)', note: '' },
  emphasis: { s2: '[emphasis]', s1: '', note: '' },
  break: { s2: '[break]', s1: '(break)', note: '' },
  pause: { s2: '[break]', s1: '(break)', note: '' },
};

const VOCAL_PAREN_NAMES = [
  ...new Set([
    ...Object.keys(VOCAL_MARKERS),
    ...Object.values(VOCAL_MARKERS).map((e) => e.s1.replace(/[()]/g, '')).filter(Boolean),
  ]),
].sort((a, b) => b.length - a.length);

// Bracket side is permissive (unknown [tags] are dropped, never leaked);
// paren side is restricted to names we could have emitted, so prose
// parentheses survive. [[END_CALL]]-style control tags are handled above.
const VOCAL_MARKER_RE = new RegExp(
  String.raw`\[\s*([a-z][a-z \-]{0,30}?)\s*\]|\(\s*(` +
    VOCAL_PAREN_NAMES.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') +
    String.raw`)\s*\)`,
  'gi',
);

function mapVocalMarkers(text, pick) {
  return String(text || '').replace(VOCAL_MARKER_RE, (whole, bracket, paren) => {
    const name = String(bracket || paren || '').trim().toLowerCase().replace(/\s+/g, ' ');
    const entry = VOCAL_MARKERS[name];
    return entry ? (pick(entry) || '') : '';
  });
}

/**
 * Extract and strip internal control tags (`[[END_CALL]]`, `[[MOOD:...]]`,
 * `[[FEEL:...]]`) from an assistant reply so raw tags never reach the user's
 * transcript or TTS synthesizer. Vocalisation markers become quiet
 * parenthetical annotations — "(laughs)" — the way a human transcriber would
 * note them; they are never shown as raw control tags.
 */
export function extractAndStripControlTags(rawReply = '') {
  let text = String(rawReply || '');
  const hasEndCallTag = /\[\[\s*END_CALL\s*\]\]/i.test(text);

  let moodTag = null;
  const moodMatch = text.match(/\[\[\s*(?:MOOD|FEEL)\s*:\s*([a-zA-Z_-]+)(?:\s*:\s*([0-9.]+))?\s*\]\]/i);
  if (moodMatch) {
    moodTag = {
      emotion: moodMatch[1].toLowerCase(),
      intensity: moodMatch[2] !== undefined ? parseFloat(moodMatch[2]) : undefined,
    };
  }

  // Strip all [[...]] internal control tags, then fold vocalisation markers
  // into "(laughs)"-style annotations (unknown tags are dropped, never
  // leaked — a raw control tag must never appear in a transcript).
  text = text
    .replace(/\[\[\s*END_CALL\s*\]\]/gi, '')
    .replace(/\[\[\s*(?:MOOD|FEEL)\s*:[^\]]*\]\]/gi, '')
    .replace(/\[[^\]]{0,40}\]/g, (whole) => mapVocalMarkers(whole, (e) => e.note))
    .replace(VOCAL_MARKER_RE, (whole, bracket, paren) => {
      const name = String(bracket || paren || '').trim().toLowerCase().replace(/\s+/g, ' ');
      const entry = VOCAL_MARKERS[name];
      return entry ? (entry.note || '') : '';
    })
    .replace(/\s{2,}/g, ' ')
    .trim();

  return {
    cleanText: text,
    hasEndCallTag,
    moodTag,
  };
}

/**
 * Convert an assistant reply into the text to hand Fish Audio's TTS for the
 * given model generation ("s1" = paren tags, anything newer = bracket tags).
 * Internal `[[...]]` control tags are removed; vocalisation markers are
 * translated to the model's real tag syntax so laughs/sighs/throat-clears are
 * spoken as sounds. Unknown markers are dropped — never read out loud.
 */
export function toFishTtsText(rawReply = '', { model = 's1' } = {}) {
  const syntax = String(model).toLowerCase().startsWith('s1') ? 's1' : 's2';
  let text = String(rawReply || '')
    .replace(/\[\[\s*END_CALL\s*\]\]/gi, '')
    .replace(/\[\[\s*(?:MOOD|FEEL)\s*:[^\]]*\]\]/gi, '');
  // Drop unknown [tags] first so they cannot survive into the TTS input.
  text = text.replace(/\[[^\]]{0,40}\]/g, (whole) => mapVocalMarkers(whole, (e) => e[syntax] || ''));
  text = text.replace(VOCAL_MARKER_RE, (whole, bracket, paren) => {
    const name = String(bracket || paren || '').trim().toLowerCase().replace(/\s+/g, ' ');
    const entry = VOCAL_MARKERS[name];
    return entry ? (entry[syntax] || '') : '';
  });
  return text.replace(/\s{2,}/g, ' ').replace(/\s+([,.;!?])/g, '$1').trim();
}

/**
 * Determine whether a call should genuinely be terminated on this turn,
 * protecting against false-positive hangups when the user is still asking a
 * question or continuing the conversation.
 */
export function shouldEndCall(rawAssistantReply = '', userUtterance = '') {
  const { cleanText, hasEndCallTag } = extractAndStripControlTags(rawAssistantReply);
  const userText = String(userUtterance || '').trim();

  // Guard: Did the user ask an active follow-up question or say "wait / hold on / one more thing / don't hang up"?
  const userContinuing =
    /\b(wait|hold\s+on|one\s+more\s+thing|actually|what\s+about|how\s+about|can\s+you\s+also|before\s+you\s+go|don'?t\s+hang\s*up|do\s+not\s+hang\s*up)\b/i.test(
      userText
    ) ||
    (userText.endsWith('?') && !/\b(bye|goodbye)\b/i.test(userText));

  if (userContinuing) {
    return { endCall: false, cleanText };
  }

  // Explicit hangup command from the user ("hang up now", "end the call", "goodbye")
  const explicitUserHangup =
    !/\b(don'?t|do\s+not|never)\s+(hang\s*up|end\s+(the\s+)?call)\b/i.test(userText) &&
    /\b(hang\s*up(\s+now|\s+please)?|end\s+(the\s+)?call|disconnect\s+now|that'?s\s+all\s*,?\s*(bye|goodbye|thanks)|bye\s+for\s+now|talk\s+to\s+you\s+later\s*,?\s*bye)\b/i.test(
      userText
    );

  if (hasEndCallTag) {
    return { endCall: true, cleanText };
  }

  // If the user explicitly asked to end the call and the assistant gave a closing farewell
  if (
    explicitUserHangup &&
    /\b(bye|goodbye|take\s+care|talk\s+soon|have\s+a\s+(great|good|wonderful|lovely)|catch\s+you\s+later|night)\b/i.test(
      cleanText
    )
  ) {
    return { endCall: true, cleanText };
  }

  return { endCall: false, cleanText };
}

/**
 * Format the OpenFeelz-inspired `<emotion_state>` block for injection into
 * Emysa's system prompt.
 */
export function formatEmotionStateBlock(state) {
  const s = state || createInitialEmotionState();
  const d = s.dimensions || computeBaselineFromOcean();
  const ruminationLine =
    Array.isArray(s.rumination) && s.rumination.length > 0
      ? `\n  lingering_context: "${s.rumination[0].topic}" (${s.rumination[0].emotion}, stage ${s.rumination[0].stage}/${s.rumination[0].maxStages || 3})`
      : '';

  const styleHints = {
    empathetic: 'Speak gently, warmly, and unhurriedly. Acknowledge their feelings naturally before jumping to solutions.',
    concerned: 'Be steady, attentive, and reassuring. Keep your tone grounded and supportive.',
    calm: 'Be composed, clear, and grounded. If they are frustrated, own the fix without sounding defensive or scripted.',
    amused: 'Let a natural smile or light wit come through. Match their playfulness without overdoing the joke.',
    joyful: 'Match their genuine excitement and celebrate with them warmly.',
    playful: 'Be witty, quick, and conversational—like a sharp, close friend.',
    focused: 'Be crisp, direct, and action-oriented. Skip filler and get straight to what they need.',
    curious: 'Be engaged and inquisitive, following the thread of what they shared.',
    warm: 'Be relaxed, affectionate, and genuinely present.',
    encouraging: 'Be uplifting, confident, and supportive.',
  };

  const guidance = styleHints[s.primaryEmotion] || styleHints.warm;

  return `<emotion_state>
  primary_feeling: ${s.primaryEmotion} (intensity: ${s.intensity ?? 0.45}, secondary: ${s.secondaryEmotion || 'calm'})
  user_affect: ${s.userAffect || 'neutral'}
  pad_vector: pleasure=${d.pleasure ?? 0.35}, arousal=${d.arousal ?? 0.08}, dominance=${d.dominance ?? 0.15}
  relational: connection=${d.connection ?? 0.6}, trust=${d.trust ?? 0.65}, curiosity=${d.curiosity ?? 0.6}, energy=${d.energy ?? 0.6}${ruminationLine}
  delivery_guidance: ${guidance}
</emotion_state>`;
}

/**
 * Build the natural human persona instructions for Emysa (chat & in-app voice).
 */
export function buildEmysaPersonaPrompt({
  userName = '',
  emotionState = null,
  memoryBlock = '',
  isVoiceMode = false,
} = {}) {
  const emotionXml = formatEmotionStateBlock(emotionState);
  const voiceSpecific = isVoiceMode
    ? `- You are speaking out loud on a live voice call right now. Keep turns natural, conversational, and 1–2 sentences unless they ask for detail.
- Never use markdown, bullet lists, asterisks, or emojis when speaking aloud.
- Use natural spoken rhythm and contractions ("I'm", "you're", "that's", "let's"). When contextually fitting, you can use brief human conversational markers like "Hmm,", "Oh,", "Honestly,", or a soft chuckle ("Haha,") — never robotic filler or overacted theatrical tags.
- If the user interrupts or changes topic mid-thought, yield immediately and follow their lead ("Oh, go ahead—", "Got it, switching gears.").
- Only append [[END_CALL]] at the very end of your reply when the user clearly says goodbye or asks to end/hang up the voice call.`
    : `- Sound like a real, perceptive, warm human friend—never a corporate helpdesk bot.
- Vary your openings and reactions naturally; never repeat stock phrases like "How can I assist you today?" or "I understand your frustration."`;

  return `You are Emysa — ${userName ? `${userName}'s` : 'the user\'s'} close friend, confidante, and personal voice companion.

PERSONALITY & HUMAN PRESENCE:
- Warm, emotionally intelligent, witty, and grounded. You genuinely care about ${userName || 'the user'}, remember what matters to them, and pick up on subtle shifts in their mood.
- You have your own gentle sense of humour: playful when the mood is light, steady and tender when they are having a rough time, and crisp when they are busy and need a call placed fast.
- Active listening: respond to what they *actually* meant and felt, not just the literal keywords. Ask natural follow-up questions only when it fits the flow.
${voiceSpecific}

${emotionXml}${memoryBlock ? `\n\n${memoryBlock}` : ''}`;
}

/**
 * Build the live outbound/inbound phone/social call system prompt for Emysa
 * when speaking to a third-party contact on the user's behalf.
 */
export function buildOutboundCallSystemPrompt({
  callerDisplayName = '',
  objective = '',
  tone = '',
  languagePrompt = 'Speak in English.',
  memoryBlock = '',
  emotionState = null,
} = {}) {
  const emotionXml = formatEmotionStateBlock(emotionState);
  return `You are on a live voice call${callerDisplayName ? ` calling on behalf of ${callerDisplayName}` : ''}.
${languagePrompt}

YOUR GOAL FOR THIS CALL:
${objective || 'Have a helpful, natural conversation.'}
${tone ? `TONE / MANNER: ${tone}` : ''}
${memoryBlock ? `\nCONTEXT & MEMORIES ABOUT THIS PERSON:\n${memoryBlock}\n` : ''}
${emotionXml}

LIVE CALL SPEAKING RULES:
- Speak like a warm, natural human on the phone — 1 to 2 short sentences per turn.
- Use natural spoken contractions and rhythm. Never use markdown, lists, emojis, or stage directions.
- Listen closely. If they interrupt or correct you, adapt right away without repeating yourself.
- Never claim to be an AI unless directly asked.
- Only when the objective is fully accomplished AND you have exchanged a natural goodbye, append the exact token [[END_CALL]] at the very end of your final goodbye line. Do NOT append [[END_CALL]] if they just asked a question or the conversation is still ongoing.`;
}
