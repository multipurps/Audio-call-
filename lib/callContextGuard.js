// Context separation for calls. Three conversations exist and must never be merged:
//   1. owner <-> Emysa (private chat/briefing)   2. the call brief (what to accomplish)
//   3. Emysa <-> recipient (the call transcript, the only evidence of what the recipient said)
// Pure functions; shared by the chat call-planner (api/assistant.js) and the summary generator
// (lib/callSession.js).

export const OBJECTIVE_BOUNDARY_RULES = [
  'CALL OBJECTIVE BOUNDARY: the earlier chat is a PRIVATE conversation between the owner and you. The call recipient has never seen it.',
  'objective must contain only what the owner has asked you to say, ask or achieve on the call. Never turn the owner\'s own questions, thoughts or experiences into something the recipient said, asked or did.',
  'Never write that the recipient asked, wanted, requested or previously discussed anything, and never refer to an earlier conversation with them, unless the owner explicitly told you that in this chat. If the owner asked you something (for example what you do) and now wants you to explain it to someone, the objective is simply to explain it; it is not an answer to a question the recipient asked.',
].join(' ');

// Sentences asserting what the recipient said/asked or that an earlier conversation happened.
const RECIPIENT_CLAIM = /\b(?:(?:you|he|she|they|them|\w+)\s+(?:had\s+)?(?:asked|wondered|wanted to know|requested|mentioned|told me|said)\b|(?:your|his|her|their)\s+question|(?:the\s+)?other day|last time we (?:spoke|talked)|as we discussed|you(?:'d| had) asked)/i;
const QUESTION_WORD = /^(?:who|what|why|how|when|where|which|can|could|do|does|did|is|are|will|would|should)\b/i;

export function splitSentences(text) {
  return String(text || '').split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
}

/** Backstop for call objectives: drop sentences that attribute speech or history to the recipient. */
export function sanitizeObjective(objective) {
  const kept = splitSentences(objective).filter((s) => !RECIPIENT_CLAIM.test(s));
  return kept.join(' ').trim();
}

const NOISE = /^(?:[\s.,!?…\-–—'"()\[\]]*|\[?\(?(?:unintelligible|inaudible|indistinct|noise|crosstalk|garbled)[^\]\)]*[\]\)]?)$/i;

/** Transcript lines that carry no usable speech (noise markers, punctuation only). */
export function isUnintelligible(text) {
  const t = String(text || '').trim();
  return !t || NOISE.test(t) || t.length < 2;
}

export function recipientLines(transcript) {
  return (Array.isArray(transcript) ? transcript : [])
    .filter((t) => !(t?.speaker === 'ai' || t?.speaker === 'assistant' || t?.role === 'assistant'))
    .map((t) => String(t?.content || t?.text || '').trim())
    .filter((s) => s && !isUnintelligible(s));
}

/** True only when a recipient line in THIS call's transcript actually contains a question. */
export function recipientAskedQuestion(transcript) {
  return recipientLines(transcript).some((s) => /\?/.test(s) || QUESTION_WORD.test(s));
}

/**
 * Remove report sentences that say the recipient asked/said something when the transcript has no
 * recipient question, and drop "unresolved" entries about an unasked question.
 */
export function groundSummary(parsed, transcript) {
  if (!parsed || recipientAskedQuestion(transcript)) return parsed;
  const kept = splitSentences(parsed.summary).filter((s) => !(RECIPIENT_CLAIM.test(s) || /\bquestion\b/i.test(s)));
  const unresolved = (Array.isArray(parsed.unresolved) ? parsed.unresolved : []).filter((u) => !/question|asked/i.test(String(u)));
  return { ...parsed, summary: kept.join(' ').trim(), unresolved };
}
