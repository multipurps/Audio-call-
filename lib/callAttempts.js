// Call-attempt state, kept apart from account-link state and from contact memory.
//
// Three things used to be tangled together in one text blob that ended up in the
// recipient's call prompt:
//   * the OWNER's WhatsApp link (is Emysa's own linked account up?),
//   * the call attempt (what did the provider report for THIS dial?),
//   * what we know about the recipient (memory).
// This module owns only the second, and the rule that makes it trustworthy:
// a state is recorded only when something actually reported it. "We did not hear"
// is `unknown`, never `failed` and never `didn't ring`.
//
// Pure functions only; no I/O. api/assistant.js and api/social-calling.js do the writes.

export const ATTEMPT_STATES = Object.freeze(['requested', 'initiated', 'ringing', 'answered', 'ended', 'failed', 'unknown']);

// A state that can no longer be followed by 'ringing' or 'initiated'. A late event
// of those kinds arriving after one of these is stale and is not recorded.
const SETTLED = new Set(['answered', 'ended', 'failed']);
const ORDER = { requested: 0, initiated: 1, ringing: 2, answered: 3, ended: 4, failed: 4, unknown: 0 };

/**
 * Append one provider event to a call's own attempt_events.
 * Returns the new array, or null when the event adds nothing (a duplicate delivery,
 * or a stale event that arrived after a later state was already recorded).
 */
export function appendAttemptEvent(existing, { state, source = 'relay', code = null, at = null } = {}) {
  if (!ATTEMPT_STATES.includes(state)) return null;
  const list = Array.isArray(existing) ? existing.slice() : [];
  const seen = list.map((e) => e?.state);
  if (seen.includes(state) && state !== 'unknown') return null; // redelivery
  const latest = [...seen].reverse().find((s) => s && s !== 'unknown');
  if (latest && ORDER[state] < ORDER[latest] && state !== 'unknown') return null; // out of order
  if (SETTLED.has(latest) && (state === 'ringing' || state === 'initiated' || state === 'requested')) return null;
  list.push({ state, at: at || new Date().toISOString(), source, ...(code ? { code: String(code).slice(0, 60) } : {}) });
  return list;
}

/** What the recorded events support about one attempt. `rang` is true or null: a missing event is unknown. */
export function attemptFacts(row = {}) {
  const events = Array.isArray(row.attempt_events) ? row.attempt_events : [];
  const states = [...new Set(events.map((e) => e?.state).filter(Boolean))];
  return {
    states,
    rang: states.includes('ringing') ? true : null,
    answered: states.includes('answered') || Boolean(row.answered_at) || (row.status === 'completed' && Number(row.duration_seconds) > 0),
    unknown: states.length === 0 || states[states.length - 1] === 'unknown',
  };
}

/** Maps a provider/relay status word to the attempt state it actually reports. */
export function attemptStateForProviderStatus(raw, { durationSeconds = 0 } = {}) {
  const s = String(raw || '').toLowerCase();
  if (s === 'ringing') return 'ringing';
  if (['answered', 'active', 'in-progress', 'in_progress'].includes(s)) return 'answered';
  if (['completed', 'ended'].includes(s)) return 'ended';
  if (['rejected', 'declined', 'busy', 'no-answer', 'no_answer', 'unanswered', 'canceled', 'cancelled'].includes(s)) return 'ended';
  if (s === 'failed') return 'failed';
  // "disconnected" without any talk time says only that a connection was lost. It
  // does not say the call failed, and it does not say it never rang.
  if (s === 'disconnected') return Number(durationSeconds) > 0 ? 'ended' : 'unknown';
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Placement errors: who is the problem?
// ---------------------------------------------------------------------------

// The OWNER's own linked account is down. Anchored on purpose: a message such as
// "the assistant could not join (bridge not connected)" is a different problem and
// must never unlink the owner's WhatsApp.
const OWNER_LINK = /^(?:whatsapp|telegram) is not connected|(?:whatsapp|telegram) session (?:has )?expired|your telegram session expired|reconnect (?:whatsapp|telegram)|not paired|logged.?out|session parked|worker not available/i;
const NOT_OWNER_LINK = /assistant could not join|could not be tracked|ended before the assistant/i;
const TEMPORARY = /timed? ?out|timeout|temporar|econnreset|econnrefused|enotfound|socket hang up|fetch failed|aborted|try again in a moment|service unavailable|rate limit|too many requests/i;

/**
 * Classifies a failure to PLACE a call. The scope is for the owner's screens only:
 * it is never put into a call prompt, and never described to the recipient.
 *
 *   owner_link         the owner's own linked account is down: tell the owner to reconnect
 *   provider_temporary a hiccup (timeout, 5xx, rate limit): the outcome is UNKNOWN, not failed
 *   provider           the provider refused this call
 *   unknown            nothing reliable to say
 */
export function classifyPlacementError(err) {
  const status = Number(err?.statusCode) || 0;
  const message = String(err?.message || '');
  if (err?.callEnded) return { scope: 'provider', retryable: true, ownerLinkDown: false, attemptState: 'failed' };
  if (!NOT_OWNER_LINK.test(message) && OWNER_LINK.test(message)) {
    return { scope: 'owner_link', retryable: false, ownerLinkDown: true, attemptState: 'failed' };
  }
  if (status === 429 || status === 408 || status >= 500 || TEMPORARY.test(message) || err?.name === 'AbortError') {
    return { scope: 'provider_temporary', retryable: true, ownerLinkDown: false, attemptState: 'unknown' };
  }
  if (status >= 400) return { scope: 'provider', retryable: true, ownerLinkDown: false, attemptState: 'failed' };
  return { scope: 'unknown', retryable: true, ownerLinkDown: false, attemptState: 'unknown' };
}

/** What the OWNER is told about a failed attempt. Never shown to the recipient. */
export function ownerMessageFor(classification, { label, channelName, reason = null }) {
  switch (classification.scope) {
    case 'owner_link':
      return `Your ${channelName} link needs reconnecting before I can call ${label}. Open Profile, then Connected accounts, to reconnect, and say "try again" once it shows connected.`;
    case 'provider_temporary':
      return `The ${channelName} call service didn't respond, so I can't tell whether the call to ${label} went through. Say "try again" in a moment if it didn't.`;
    default:
      return `I couldn't place the call to ${label} on ${channelName}${reason ? `: ${reason}` : ''}.`;
  }
}

// ---------------------------------------------------------------------------
// Retry
// ---------------------------------------------------------------------------

const RETRY_COMMAND = /^\W*(?:please\s+)?(?:(?:try|call|ring|dial|redial|do it|go)(?:\s+(?:it|him|her|them|that|again|back|once more))*\s*(?:again|back)?|retry|try once more|one more (?:try|time)|again)\W*$/i;

/** A message that only asks for the last call to be repeated. */
export function isRetryCommand(text) {
  return RETRY_COMMAND.test(String(text || '').trim());
}

const LANGUAGE_PREFIX = /^Speak only in [^.]{2,40} for this entire call, regardless of what language this instruction is written in\.\s*/i;

/** Removes the language directive the call path prepends, so a retry does not stack a second one. */
export function stripLanguagePrefix(objective) {
  let out = String(objective || '');
  while (LANGUAGE_PREFIX.test(out)) out = out.replace(LANGUAGE_PREFIX, '');
  return out.trim();
}

/**
 * The identity of a retry, from this conversation's call history (newest first).
 * Everything about WHO and WHAT is inherited from the call being repeated; only the
 * attempt number and the chain root change. The user's retry wording is not part of
 * the call: it is recorded separately as the command that triggered the attempt.
 */
export function planRetry(priorCalls, { channel = null } = {}) {
  const calls = Array.isArray(priorCalls) ? priorCalls : [];
  const last = (channel ? calls.find((c) => c.platform === channel) : null) || calls[0] || null;
  if (!last) return null;
  const rootId = last.retry_of || last.id || null;
  const chain = calls.filter((c) => c.id === rootId || c.retry_of === rootId);
  const highest = Math.max(1, ...chain.map((c) => Number(c.attempt_number) || 1), Number(last.attempt_number) || 1);
  return {
    last,
    rootId,
    attemptNumber: highest + 1,
    toNumber: last.to_number || null,
    contactId: last.contact_id || null,
    platform: last.platform || null,
    objective: stripLanguagePrefix(last.objective || '') || null,
    // The original instructions, never the retry wording.
    instructions: last.instructions && !isRetryCommand(last.instructions) ? last.instructions : null,
  };
}

/** True when the unique (retry_of, attempt_number) index rejected a duplicate attempt. */
export function isDuplicateAttemptError(error) {
  const text = `${error?.code || ''} ${error?.message || ''}`;
  return /23505|duplicate key|calls_retry_attempt_unique/i.test(text);
}
