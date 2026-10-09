// Shared call/session service: one place that owns the logical call lifecycle
// (create -> placed -> in progress -> ended/failed), duplicate-call guarding,
// transcript append rules and automatic post-call summaries + memory
// extraction — used by api/social-calling.js (WhatsApp/Telegram), api/calls.js
// (hangup), api/calls-status.js (Twilio webhooks) and both Twilio relays, so
// every platform shares the same lifecycle, summary format and memory rules.
//
// Everything here runs server-side with the Supabase service-role client.
// No credentials ever reach the browser.

import { createChatCompletion } from './llmClient.js';
import { sendCallSummaryPush } from './summaryPush.js';
import { groundSummary, isUnintelligible } from './callContextGuard.js';
import {
  consolidateAndStoreMemories,
  containsSensitiveSecret,
  inferMemoryType,
} from './memoryManager.js';
import { appendAttemptEvent, isDuplicateAttemptError } from './callAttempts.js';

export const TERMINAL_CALL_STATUSES = Object.freeze(['completed', 'failed', 'rejected', 'no_answer', 'busy', 'canceled']);

export function isTerminalCallStatus(status) {
  return TERMINAL_CALL_STATUSES.includes(String(status || ''));
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/**
 * Insert the `calls` row BEFORE the provider is dialled, so the assistant
 * pipeline can resolve "which call is this?" the moment the provider connects
 * (the bridge session id is derived from the provider call id), the UI can
 * open the live call screen immediately, and a provider failure still leaves a
 * truthful `failed` row instead of nothing.
 */
export async function createCallRecord(supabase, userId, {
  platform = 'phone',
  toNumber,
  objective = '',
  instructions = null,
  contactId = null,
  sessionId = null,
  callKind = 'contact',
  retryOf = null,
  attemptNumber = 1,
  extra = {},
} = {}) {
  const row = {
    user_id: userId,
    platform,
    to_number: toNumber,
    objective: objective || '',
    instructions: instructions || null,
    contact_id: contactId || null,
    session_id: sessionId || null,
    call_kind: callKind,
    status: 'queued',
    transcript: [],
    // The first event of every attempt. Nothing later is recorded unless a provider reports it.
    attempt_events: [{ state: 'requested', at: new Date().toISOString(), source: 'app' }],
    ...extra,
  };
  // Attempt columns exist after sql/029. Before it, a retry is still placed (as an
  // ordinary call) rather than refused.
  if (retryOf) { row.retry_of = retryOf; row.attempt_number = attemptNumber; }
  let { data, error } = await supabase.from('calls').insert(row).select('id').single();
  if (error && /attempt_events|attempt_number|retry_of|failure_scope/.test(String(error.message))) {
    console.warn('createCallRecord: sql/029 is not applied; placing the call without attempt tracking');
    const { attempt_events: _e, retry_of: _r, attempt_number: _n, ...legacy } = row;
    ({ data, error } = await supabase.from('calls').insert(legacy).select('id').single());
  }
  if (error) {
    // Two simultaneous "try again" requests: the unique (retry_of, attempt_number)
    // index lets exactly one in. The loser is told which call is already running.
    if (retryOf && isDuplicateAttemptError(error)) {
      const { data: existing } = await supabase.from('calls').select('id').eq('retry_of', retryOf).eq('attempt_number', attemptNumber).maybeSingle();
      if (existing?.id) return { id: existing.id, duplicateOfAttempt: true };
    }
    throw new Error(error.message);
  }
  return data;
}

/**
 * Record one provider event on the call it belongs to (and only that call).
 * Duplicates and stale events are ignored. Never throws: attempt tracking must not
 * be able to break a call.
 */
export async function recordAttemptEvent(supabase, callId, event) {
  if (!supabase || !callId) return null;
  try {
    const { data: row, error } = await supabase.from('calls').select('attempt_events').eq('id', callId).maybeSingle();
    if (error || !row) return null;
    const next = appendAttemptEvent(row.attempt_events, event);
    if (!next) return null;
    await supabase.from('calls').update({ attempt_events: next }).eq('id', callId);
    return next;
  } catch (err) {
    console.warn('recordAttemptEvent failed', { callId, error: err?.message });
    return null;
  }
}

/**
 * Record the provider's call id. The row stays `queued` ("starting") because
 * the provider accepting the request does not mean any phone is ringing; the
 * provider's own ringing/answered events move it on.
 */
export async function markCallPlaced(supabase, callId, { platformCallId = null, status = 'queued' } = {}) {
  const patch = { status };
  if (platformCallId) patch.platform_call_id = platformCallId;
  const { error } = await supabase.from('calls').update(patch).eq('id', callId);
  if (error) throw new Error(error.message);
}

/**
 * Mark a call that never reached the provider as `failed`.
 *
 * `outcome_summary` here is the OWNER-facing reason shown on their call screens. It
 * is not a conversation summary: `summary_status` is set to 'skipped' so nothing
 * downstream (prior-call context for the next attempt, memory) can mistake it for
 * something that was said. `scope` records whose problem it was; `attemptState` is
 * 'unknown' for a temporary provider error, which is not a definitive failure.
 */
export async function markCallFailed(supabase, callId, reason, { scope = null, attemptState = 'failed', ownerMessage = null } = {}) {
  if (!callId) return;
  const update = { status: 'failed', ended_at: new Date().toISOString(), summary_status: 'skipped' };
  const text = String(ownerMessage || (reason ? `Couldn't connect: ${reason}` : '')).trim();
  if (text) update.outcome_summary = text.slice(0, 300);
  if (scope) update.failure_scope = scope;
  let { error } = await supabase.from('calls').update(update).eq('id', callId).neq('status', 'completed'); // never resurrect an ended call
  if (error && /failure_scope/.test(String(error.message))) {
    delete update.failure_scope;
    ({ error } = await supabase.from('calls').update(update).eq('id', callId).neq('status', 'completed'));
  }
  if (error) console.warn('markCallFailed: write failed', { callId, error: error.message });
  await recordAttemptEvent(supabase, callId, { state: attemptState, source: 'app', code: scope });
}

/**
 * Duplicate-call guard: a second placement button press (or a retried
 * request) must not dial the same number again while the first attempt is
 * still queued/ringing for this user and platform. Returns the existing call
 * row, or null when it is safe to place.
 */
export async function findDuplicateActiveCall(supabase, userId, platform, toNumber, { windowMs = 120_000 } = {}) {
  const digits = String(toNumber || '').replace(/[^\d+]/g, '');
  const { data } = await supabase
    .from('calls')
    .select('id, status, created_at, to_number')
    .eq('user_id', userId)
    .eq('platform', platform)
    .in('status', ['queued', 'ringing'])
    .order('created_at', { ascending: false })
    .limit(5);
  for (const row of data || []) {
    const rowDigits = String(row.to_number || '').replace(/[^\d+]/g, '');
    if (rowDigits !== digits) continue;
    const age = Date.now() - new Date(row.created_at).getTime();
    if (Number.isFinite(age) && age >= 0 && age <= windowMs) return row;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Transcript rules (shared by the relay callbacks and the Twilio relays)
// ---------------------------------------------------------------------------

/**
 * Append one transcript entry to a call's transcript array with duplicate
 * protection. Returns the new array, or null when the entry is a repeat of
 * the most recent one (retried callbacks / redelivered events).
 */
export function appendTranscriptEntry(existing, entry) {
  if (!entry || typeof entry !== 'object' || !String(entry.content || '').trim()) return null;
  const list = Array.isArray(existing) ? existing.slice() : [];
  const speaker = entry.speaker === 'ai' || entry.speaker === 'assistant' ? 'ai' : 'caller';
  const content = String(entry.content).trim();
  const last = list[list.length - 1];
  if (last && (last.speaker === 'ai' || last.speaker === 'assistant' ? 'ai' : 'caller') === speaker
    && String(last.content || '').trim() === content) {
    return null; // same speaker, same text, back to back -> a redelivery, not a new turn
  }
  list.push({ speaker, content, at: entry.at || new Date().toISOString() });
  return list;
}

// ---------------------------------------------------------------------------
// Automatic call summaries
// ---------------------------------------------------------------------------

const SUMMARY_SYSTEM_PROMPT = `You are Emysa, reporting to the person whose account placed this call. You made the call for them. Write the report yourself, in the first person, as you would tell them in a message. You receive the transcript of one finished call ("Me" is you, "Them" is the other person) and the facts the app recorded about it.

Voice:
- First person only: "I spoke with him", "I couldn't confirm", "I agreed to call back". Never write "Emysa introduced herself", "Emysa asked", "she told him" or any outside narration, and never refer to yourself as Emysa, the assistant or the AI.
- Say what actually happened and what is useful: the exchange, information learned, decisions, promises, the outcome, next actions. Do not retell the whole conversation. No filler such as "I was listening".

Grounding:
- The objective and the user's instructions are the owner's PRIVATE brief. They are NOT evidence of anything said or done on the call. Only "Them:" lines are evidence of what the recipient said, and only "Me:" lines of what you said. Never write that they asked a question, made a request or referred to an earlier conversation unless a "Them:" line in this transcript shows it. Never attribute the owner's questions or earlier chat to them.
- Leave unintelligible or garbled fragments OUT of "summary" and "outcome"; never turn them into meaningful statements, questions, intentions or follow-ups. Mention uncertainty (in "unclear") only when it materially affects the outcome.
- "followup" is "None" only when no follow-up was agreed or required; otherwise state the verified action. Never invent one.
- Use ONLY what is in the transcript and the recorded facts. Never invent facts, names, dates, amounts, agreements, preferences, or an outcome to make the report feel complete. If there was no meaningful outcome, say so briefly.
- Distinguish confirmed from uncertain. Speech that is garbled, cut off, marked [unintelligible], or looks like background noise goes in "unclear" and is never reported as something they said or agreed.
- Mention a partial transcript ONLY when the transcript really is partial (starts mid-conversation, cuts off, or is mostly unrecognised speech); then set "incomplete": true.
- If the call reached a voicemail or answering machine, the first sentence says so.
- Do not list a follow-up that the call itself completed. If the recorded facts say this call was a retry of an earlier attempt, the retry is done and is not a follow-up. Do not speculate about why an earlier attempt did not connect.
- Never say you will remember, note or save anything. Memory is handled separately.

"memories": 0-3 durable, non-secret facts about THEM worth knowing on a future call (stable preferences, relationships, standing arrangements), each as {"text": third-person fact, "evidence": the exact words THEY said that support it, copied from the transcript, "certainty": "confirmed" if stated clearly or "uncertain" if you are interpreting}. No passwords, codes, card numbers, one-off details, or anything you are unsure they said. Empty array when nothing qualifies.

Reply with ONLY a JSON object:
{"summary":"1-5 first-person sentences covering the exchange and useful information","outcome":"one short first-person line: the result, or that no clear outcome was reached","followup":"one short line, or \"None\" when nothing is pending","confirmed":["clearly established facts"],"unclear":["unclear or uncertain items"],"decisions":["decisions/agreements"],"commitments":["promises, with who made them when clear"],"details":["dates, amounts, specifics"],"followups":["concrete next actions still open"],"unresolved":["open questions"],"topics":["main topics"],"memories":[{"text":"","evidence":"","certainty":"confirmed|uncertain"}],"incomplete":true|false}`;

// The whole conversation goes to the model (a 30 minute call is well inside its context). Only a transcript
// beyond MAX_PROMPT_CHARS is trimmed, and then the middle is cut with an explicit marker (never the start or the
// end, which hold the greeting/objective and the outcome) and the model is told it is partial.
const MAX_PROMPT_CHARS = 60_000;

export function transcriptForPrompt(transcript) {
  const lines = (Array.isArray(transcript) ? transcript : [])
    .map((t) => {
      const speaker = t?.speaker === 'ai' || t?.speaker === 'assistant' || t?.role === 'assistant' ? 'Me' : 'Them';
      const text = String(t?.content || t?.text || '').trim();
      return text && !isUnintelligible(text) ? `${speaker}: ${text}` : '';
    })
    .filter(Boolean);
  const joined = lines.join('\n');
  if (joined.length <= MAX_PROMPT_CHARS) return { text: joined, omittedLines: 0 };
  const take = (list, budget) => {
    const out = [];
    let used = 0;
    for (const line of list) {
      if (used + line.length + 1 > budget) break;
      out.push(line);
      used += line.length + 1;
    }
    return out;
  };
  const head = take(lines, Math.floor(MAX_PROMPT_CHARS / 3));
  const tail = take([...lines].reverse(), Math.floor((MAX_PROMPT_CHARS * 2) / 3)).reverse();
  const omittedLines = Math.max(0, lines.length - head.length - tail.length);
  return { text: [...head, `[... ${omittedLines} lines from the middle of the call omitted for length ...]`, ...tail].join('\n'), omittedLines };
}

/**
 * Parse the summary model's reply. A reply cut off by the token limit is not valid JSON; instead of throwing the
 * whole summary away ("empty summary"), recover the summary text and every array that was completed.
 */
export function parseSummaryReply(content) {
  const raw = String(content || '').trim();
  try { return { parsed: JSON.parse(raw), salvaged: false }; } catch { /* fall through */ }
  const block = raw.match(/\{[\s\S]*\}/);
  if (block) { try { return { parsed: JSON.parse(block[0]), salvaged: false }; } catch { /* fall through */ } }
  const out = {};
  const sm = raw.match(/"summary"\s*:\s*"((?:[^"\\]|\\.)*)/);
  if (sm) {
    let text = sm[1].replace(/\\$/, '');
    try { text = JSON.parse(`"${text}"`); } catch { /* keep the raw capture */ }
    out.summary = text;
  }
  for (const key of ['topics', 'learned', 'confirmed', 'unclear', 'decisions', 'commitments', 'details', 'followups', 'unresolved', 'memories']) {
    const am = raw.match(new RegExp(`"${key}"\\s*:\\s*(\\[[^\\]]*\\])`));
    if (am) { try { out[key] = JSON.parse(am[1]); } catch { /* skip an incomplete array */ } }
  }
  return { parsed: out, salvaged: true };
}

// ---------------------------------------------------------------------------
// Report voice, follow-up and memory validation (pure; unit-tested)
// ---------------------------------------------------------------------------

const OUTSIDE_NARRATION = /\bemysa\b|^\s*(?:the )?(?:assistant|ai|caller|bot)\b|\b(?:she|the assistant|the ai) (?:introduced|asked|told|said|greeted|explained|tried)\b/i;
// Mirrors the assistant service's rule: any 9+ digit run (account, ID, card, phone) is never a memory.
const LONG_DIGITS = /\d(?:[ -]?\d){8,}/;
const UNCLEAR_MARKER = /\[(?:unintelligible|inaudible|noise|crosstalk)[^\]]*\]|\b(?:unintelligible|inaudible)\b/i;

/** True when the report reads as Emysa speaking to the owner, not an outside observer. */
export function isFirstPersonReport(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (OUTSIDE_NARRATION.test(t)) return false;
  return /\b(?:I|I'm|I've|I'd|I'll|my|me)\b/.test(t) || /^(?:No clear|Nothing)/i.test(t);
}

/** A report built only from structured fields, used when the model cannot be made to use the right voice. */
export function fallbackReport(parsed, { who = 'them' } = {}) {
  const outcome = String(parsed?.outcome || '').trim();
  const parts = [`I spoke with ${who}.`];
  if (outcome && isFirstPersonReport(outcome)) parts.push(outcome);
  else if (asStringArray(parsed?.decisions).length) parts.push(`We settled: ${asStringArray(parsed.decisions).join('; ')}.`);
  else parts.push("We didn't establish a clear outcome.");
  return parts.join(' ');
}

const RETRY_FOLLOWUP = /\b(?:try again|call (?:him|her|them|again|back)|retry|redial|ring (?:him|her|them) again)\b/i;

/** Removes follow-ups the call itself already completed (a retry that got through is not a pending retry). */
export function dropCompletedFollowups(followups, { attemptNumber = 1, answered = true } = {}) {
  const list = asStringArray(followups);
  if (!(attemptNumber > 1 && answered)) return list;
  return list.filter((f) => !RETRY_FOLLOWUP.test(f));
}

const norm = (v) => String(v || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();

/**
 * Turns the model's memory proposals into rows that may be saved. A proposal is kept only if its
 * evidence really appears in something THEY said, is not an unclear fragment, and is not a secret.
 * Everything else is dropped, so a hallucination or a noise fragment can never become a "fact".
 */
export function validateMemoryCandidates(raw, transcript, { callId = null, observedAt = null } = {}) {
  const theirTurns = (Array.isArray(transcript) ? transcript : [])
    .filter((t) => !(t?.speaker === 'ai' || t?.speaker === 'assistant' || t?.role === 'assistant'))
    .map((t) => String(t?.content || t?.text || ''))
    .filter((t) => t.trim() && !UNCLEAR_MARKER.test(t))
    .map(norm);
  const kept = [];
  const dropped = { noEvidence: 0, unclear: 0, tooShort: 0, secret: 0 };
  for (const item of Array.isArray(raw) ? raw : []) {
    if (!item || typeof item !== 'object') { dropped.noEvidence += 1; continue; }
    const text = String(item.text || '').trim();
    const evidence = String(item.evidence || '').trim();
    if (!text) continue;
    if (UNCLEAR_MARKER.test(text) || UNCLEAR_MARKER.test(evidence)) { dropped.unclear += 1; continue; }
    const ev = norm(evidence);
    if (ev.split(' ').filter(Boolean).length < 3) { dropped.tooShort += 1; continue; }
    if (!theirTurns.some((turn) => turn.includes(ev))) { dropped.noEvidence += 1; continue; }
    if (LONG_DIGITS.test(text) || containsSensitiveSecret(text) || containsSensitiveSecret(evidence)) { dropped.secret += 1; continue; }
    kept.push({
      content: text,
      memory_type: inferMemoryType(text, callId),
      status: item.certainty === 'uncertain' ? 'uncertain' : 'confirmed',
      evidence: evidence.slice(0, 300),
      observed_at: observedAt,
    });
  }
  return { kept: kept.slice(0, 3), dropped };
}

/** The contact a call belongs to: the row's own, else the owner's single exact number match, else null. */
export async function resolveMemoryContactId(supabase, call) {
  if (call.contact_id) return call.contact_id;
  const digits = String(call.to_number || '').replace(/\D/g, '');
  if (digits.length < 7 || !call.user_id) return null;
  const { data } = await supabase.from('contacts').select('id, phone_number').eq('user_id', call.user_id);
  const hits = (data || []).filter((c) => String(c.phone_number || '').replace(/\D/g, '') === digits);
  return hits.length === 1 ? hits[0].id : null;
}


/**
 * Generate + persist the summary (and extract memories) for a finished call.
 *
 * Idempotent: a compare-and-set claim on `summary_status`/`summary_json` makes
 * concurrent triggers (relay callback, hangup webhook, UI hangup) safe, and a
 * completed summary is never regenerated. Failed generations are retried on
 * the next trigger.
 *
 * Order of operations honours the brief: the transcript is already persisted
 * live by the pipeline/relay; this writes the summary first, then stores any
 * extracted memories, so a crash after the summary still leaves a usable
 * record.
 */
export async function maybeGenerateCallSummary(supabase, callId, { env = process.env, notify = true } = {}) {
  if (!supabase || !callId) return { status: 'noop' };

  const { data: call } = await supabase
    .from('calls')
    .select('id, user_id, contact_id, to_number, platform, objective, instructions, status, transcript, outcome_summary, summary_status, summary_json, duration_seconds, created_at, answered_at, retry_of, attempt_number')
    .eq('id', callId)
    .maybeSingle();
  if (!call) return { status: 'missing' };
  // In-app calls with Emysa are briefings, not conversations: no summary, no push.
  if (call.platform === 'app') return { status: 'skipped-app' };
  if (!isTerminalCallStatus(call.status)) return { status: 'not-terminal' };
  if (call.outcome_summary) return { status: 'already-summarised', summary: call.outcome_summary };

  const transcript = Array.isArray(call.transcript) ? call.transcript : [];
  const spokenTurns = transcript.filter((t) => String(t?.content || t?.text || '').trim());

  // Nothing was said (busy signal / no answer / instant failure): record that
  // deliberately instead of leaving the state ambiguous — and say plainly
  // that no summary exists because the conversation was not captured, rather
  // than leaving a generic "Call finished" in its place.
  if (spokenTurns.length === 0) {
    if (!call.summary_status) {
      const endedNoTalk = ['rejected', 'no_answer', 'busy', 'canceled'].includes(call.status);
      const outcome = endedNoTalk
        ? 'No summary — the call was never answered, so there was no conversation to capture.'
        : 'No summary could be generated because the conversation was not captured.';
      await supabase
        .from('calls')
        .update({ summary_status: 'skipped', outcome_summary: outcome })
        .eq('id', callId)
        .is('outcome_summary', null);
    }
    return { status: 'skipped' };
  }

  // A fresh claim from another trigger wins; a stale claim (>3 min old, e.g.
  // a crashed generator) may be retaken.
  const claimedAt = call.summary_json?.claimedAt ? Date.parse(call.summary_json.claimedAt) : NaN;
  const claimIsFresh = call.summary_status === 'pending' && Number.isFinite(claimedAt) && Date.now() - claimedAt < 180_000;
  if (call.summary_status === 'completed' || claimIsFresh) return { status: 'claimed-elsewhere' };

  const myClaim = new Date().toISOString();
  const { data: claimed, error: claimError } = await supabase
    .from('calls')
    .update({ summary_status: 'pending', summary_json: { claimedAt: myClaim } })
    .eq('id', callId)
    // NULL means "never attempted". In SQL NULL <> 'completed' is NULL, so a plain
    // .neq() matched no rows for a fresh call and every trigger believed another
    // one owned the summary: nothing was ever generated.
    .or('summary_status.is.null,summary_status.neq.completed')
    .select('summary_json');
  if (claimError) return { status: 'error', error: claimError.message };
  // Read-back CAS: whoever wrote the latest claimedAt is the claimant.
  if (!claimed || claimed[0]?.summary_json?.claimedAt !== myClaim) return { status: 'claimed-elsewhere' };

  const { text: transcriptText, omittedLines } = transcriptForPrompt(transcript);
  const prompt = [
    `Contact/platform: ${call.platform || 'phone'} call${call.objective ? '' : '.'}${call.objective ? ` — private objective (owner's brief, not evidence of what was said): ${call.objective}` : ''}`,
    call.instructions ? `Owner's private instructions (not evidence of what was said): ${call.instructions}` : '',
    `Call status: ${call.status}${call.duration_seconds ? `, duration ${call.duration_seconds}s` : ''}.`,
    Number(call.attempt_number) > 1 ? `Recorded fact: this call was attempt ${call.attempt_number} of the same request. The earlier attempt(s) are not part of this transcript.` : '',
    omittedLines ? `Note: ${omittedLines} lines from the middle of a long call were omitted; treat the transcript as partial.` : '',
    '',
    'Transcript:',
    transcriptText,
  ].filter(Boolean).join('\n');

  try {
    // 2000 output tokens is plenty for the whole schema; if the model still hits the limit, retry once with double
    // before falling back to salvaging what it did write.
    const startedMs = Date.now();
    const generate = async (system) => {
      let result;
      let first;
      for (const maxTokens of [2000, 4000]) {
        result = await createChatCompletion({
          messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
          temperature: 0.2,
          max_tokens: maxTokens,
          response_format: { type: 'json_object' },
          env,
          timeoutMs: 30_000,
        });
        if (!result.ok) throw new Error(result.errorText || 'summary LLM request failed');
        first = result.data?.choices?.[0];
        if (first?.finish_reason !== 'length') break;
        console.warn('callSummary: reply hit the token limit', { callId, maxTokens });
        // This runs inside a 60s serverless function: do not start a second attempt that cannot finish.
        if (Date.now() - startedMs > 25_000) break;
      }
      return { llmResult: result, ...parseSummaryReply(first?.message?.content) };
    };

    let { llmResult, parsed, salvaged } = await generate(SUMMARY_SYSTEM_PROMPT);
    let voiceFallback = false;
    if (!isFirstPersonReport(parsed.summary) && Date.now() - startedMs < 30_000) {
      // One stricter attempt, then a deterministic report: the owner is never shown an outside-observer summary.
      ({ llmResult, parsed, salvaged } = await generate(`${SUMMARY_SYSTEM_PROMPT}\n\nYour previous answer narrated Emysa from the outside. Rewrite it entirely in the first person ("I ..."). Do not use the name Emysa anywhere.`));
    }
    if (!isFirstPersonReport(parsed.summary)) {
      voiceFallback = true;
      parsed = { ...parsed, summary: fallbackReport(parsed, { who: call.contact_label || 'them' }) };
    }
    parsed = groundSummary(parsed, transcript);
    if (salvaged) console.warn('callSummary: reply was cut off; salvaged what was complete', { callId });

    const summaryText = String(parsed.summary || '').trim();
    if (!summaryText) throw new Error('empty summary');
    const incomplete = parsed.incomplete === true;
    const answered = Boolean(call.answered_at) || spokenTurns.length > 0;
    const followups = dropCompletedFollowups(parsed.followups, { attemptNumber: Number(call.attempt_number) || 1, answered });
    const followupLine = String(parsed.followup || '').trim();
    const summaryJson = {
      topics: asStringArray(parsed.topics),
      confirmed: asStringArray(parsed.confirmed),
      unclear: asStringArray(parsed.unclear),
      decisions: asStringArray(parsed.decisions),
      commitments: asStringArray(parsed.commitments),
      details: asStringArray(parsed.details),
      followups,
      unresolved: asStringArray(parsed.unresolved),
      outcome: String(parsed.outcome || '').trim() || null,
      followup: followups.length ? (followupLine && !/^none/i.test(followupLine) ? followupLine : followups[0]) : 'None',
      incomplete,
      ...(voiceFallback ? { voiceFallback: true } : {}),
      ...(salvaged ? { truncatedReply: true } : {}),
      ...(omittedLines ? { omittedLines } : {}),
      generatedAt: new Date().toISOString(),
      model: llmResult.model,
      provider: llmResult.provider,
    };
    const outcome = incomplete
      ? `${summaryText} (Summary based on a partial transcript.)`
      : summaryText;

    const { error: writeError } = await supabase
      .from('calls')
      .update({ outcome_summary: outcome, summary_json: summaryJson, summary_status: 'completed' })
      .eq('id', callId)
      .eq('summary_status', 'pending');
    if (writeError) throw new Error(writeError.message);

    // Summary persisted first; memories afterwards, so a memory failure can never cost us the
    // summary. The outcome is written back to summary_json so what the app says about memory
    // reflects what was actually saved.
    const memoryReport = { saved: 0, updated: 0, uncertain: 0, failed: 0, skipped: null };
    try {
      const contactId = await resolveMemoryContactId(supabase, call);
      const { kept, dropped } = validateMemoryCandidates(parsed.memories, transcript, { callId, observedAt: call.answered_at || call.created_at || null });
      if (!call.user_id || !kept.length) {
        memoryReport.skipped = 'nothing-qualified';
      } else if (!contactId) {
        memoryReport.skipped = 'no-contact';
        console.log('[memory] skipped: call has no matching contact', { callId });
      } else {
        const res = await consolidateAndStoreMemories({ supabase, userId: call.user_id, contactId, sourceCallId: callId, candidates: kept, observedAt: call.answered_at || call.created_at || null });
        memoryReport.saved = res.inserted;
        memoryReport.updated = res.updated;
        memoryReport.failed = res.failed;
        memoryReport.uncertain = kept.filter((k) => k.status === 'uncertain').length;
        if (res.error) memoryReport.error = res.error;
      }
      console.log('[memory] extraction', { callId, proposed: Array.isArray(parsed.memories) ? parsed.memories.length : 0, kept: kept.length, dropped, ...memoryReport });
    } catch (memErr) {
      memoryReport.failed += 1;
      memoryReport.error = String(memErr?.message || memErr).slice(0, 200);
      console.error('callSummary: memory storage failed', memoryReport.error);
    }
    await supabase.from('calls').update({ summary_json: { ...summaryJson, memory: memoryReport } }).eq('id', callId);
    summaryJson.memory = memoryReport;

    // Only the claimant that wrote the summary reaches this point, so the
    // push goes out exactly once per call.
    if (call.user_id && notify) {
      await sendCallSummaryPush(supabase, { userId: call.user_id, callId, summary: outcome, env });
    }

    return { status: 'completed', summary: outcome, summaryJson };
  } catch (err) {
    console.error('callSummary: generation failed', err?.message || err);
    await supabase
      .from('calls')
      .update({
        summary_status: 'failed',
        // Keep the reason so the app can show WHY there is no summary
        // instead of silently showing only the transcript.
        summary_json: { error: String(err?.message || err).slice(0, 300), failedAt: new Date().toISOString() },
      })
      .eq('id', callId)
      .eq('summary_status', 'pending');
    return { status: 'failed', error: err?.message || String(err) };
  }
}

/**
 * Summary generation is claimed by whichever trigger (End button, carrier
 * callback, assistant end-report) gets there first; the others get
 * 'claimed-elsewhere' and used to post a generic "Finished the call" line to
 * the chat instead of the real summary. This waits (bounded) for the
 * claimant to finish and returns the finished summary, so every trigger can
 * report the real thing. Resolves to { status, summary? } like
 * maybeGenerateCallSummary; 'pending' means it was still running at timeout.
 */
export async function waitForCallSummary(supabase, callId, { timeoutMs = 20_000, intervalMs = 1_500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { data } = await supabase
      .from('calls')
      .select('outcome_summary, summary_status, summary_json')
      .eq('id', callId)
      .maybeSingle();
    if (data?.outcome_summary && data.summary_status !== 'skipped') {
      return { status: 'completed', summary: data.outcome_summary, summaryJson: data.summary_json || null };
    }
    if (data?.summary_status === 'skipped') return { status: 'skipped' };
    if (data?.summary_status === 'failed') return { status: 'failed' };
    if (Date.now() + intervalMs > deadline) return { status: 'pending' };
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

// What the chat bubble shows for a finished call: the summary plus the concrete
// specifics (decisions, commitments, details, follow-ups, open questions), so
// the user learns what was actually discussed rather than that a call happened.
export function formatSummaryForChat(summaryText, summaryJson = {}) {
  const lines = [String(summaryText || '').trim()];
  const outcome = String(summaryJson?.outcome || '').trim();
  if (outcome && !lines[0].includes(outcome)) lines.push('', `Outcome: ${outcome}`);
  const followup = String(summaryJson?.followup || '').trim();
  if (followup && outcome) lines.push('', `Follow-up: ${followup}`);
  const sections = [
    ['Decisions', summaryJson?.decisions],
    ['Commitments', summaryJson?.commitments],
    ['Details', summaryJson?.details],
    ...(outcome ? [] : [['Follow-ups', summaryJson?.followups]]),
    ['Unclear', summaryJson?.unclear],
    ['Still open', summaryJson?.unresolved],
  ];
  for (const [label, items] of sections) {
    const list = asStringArray(items).slice(0, 5);
    if (list.length) lines.push('', `${label}:`, ...list.map((item) => `- ${item}`));
  }
  return lines.join('\n').trim();
}

const GENERIC_CALL_LINE = /^(Finished the call|There is no summary|Couldn't complete|I called|Call finished)/i;

// Self-healing: finished calls that have a transcript but never got a summary
// (an earlier bug, a crashed generator, a failed model call) are summarised
// the next time the app asks, and the generic "Finished the call" line in the
// chat is replaced with what was actually discussed. Only calls that ended in
// the last 30 minutes raise a push; older ones fill in silently.
export async function recoverMissingSummaries(supabase, userId, { env = process.env, limit = 4, maxAgeDays = 21 } = {}) {
  if (!supabase || !userId) return { recovered: 0 };
  const since = new Date(Date.now() - maxAgeDays * 86_400_000).toISOString();
  const { data: rows } = await supabase
    .from('calls')
    .select('id, user_id, session_id, platform, status, transcript, outcome_summary, summary_status, summary_json, ended_at, created_at')
    .eq('user_id', userId)
    .in('status', ['completed'])
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(30);
  const staleClaim = (r) => r.summary_status === 'pending'
    && !(r.summary_json?.claimedAt && Date.now() - Date.parse(r.summary_json.claimedAt) < 180_000);
  const candidates = (rows || []).filter((r) => r.platform !== 'app'
    && !r.outcome_summary
    && (r.summary_status == null || r.summary_status === 'failed' || staleClaim(r))
    && Array.isArray(r.transcript) && r.transcript.some((t) => String(t?.content || t?.text || '').trim()))
    .slice(0, limit);

  let recovered = 0;
  for (const call of candidates) {
    const endedAt = Date.parse(call.ended_at || call.created_at);
    const recent = Number.isFinite(endedAt) && Date.now() - endedAt < 30 * 60_000;
    // A failed row must be reset so the claim step can retake it.
    if (call.summary_status === 'failed') {
      await supabase.from('calls').update({ summary_status: null }).eq('id', call.id).eq('summary_status', 'failed');
    }
    const result = await maybeGenerateCallSummary(supabase, call.id, { env, notify: recent });
    if (result?.status !== 'completed') continue;
    recovered++;
    if (!call.session_id) continue;
    const text = formatSummaryForChat(result.summary, result.summaryJson);
    const { data: existing } = await supabase
      .from('assistant_messages')
      .select('id, content')
      .eq('user_id', userId)
      .eq('session_id', call.session_id)
      .eq('call_id', call.id)
      .eq('role', 'assistant');
    const generic = (existing || []).find((m) => GENERIC_CALL_LINE.test(String(m.content || '')));
    if (generic) {
      await supabase.from('assistant_messages').update({ content: text }).eq('id', generic.id);
    } else if (!(existing || []).length) {
      await supabase.from('assistant_messages').insert({ user_id: userId, session_id: call.session_id, role: 'assistant', content: text, call_id: call.id, source: 'call' });
    }
  }
  return { recovered };
}

function asStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map((v) => String(v).trim()).filter(Boolean).slice(0, 12);
}


/**
 * Post a message from Emysa into the chat thread that placed the call. Idempotent per call + text, so several end
 * paths (End button, carrier callback, the assistant's own end report) can all try without duplicating it.
 */
export async function postCallChatMessage(supabase, { userId, sessionId, callId, text }) {
  if (!supabase || !userId || !sessionId || !text) return { posted: false, reason: 'missing-fields' };
  // Duplicate guard: the same text, or the same summary already posted by another path (the recovery step in
  // recoverMissingSummaries writes the formatted bubble; the End button and the carrier callback write it too).
  let query = supabase
    .from('assistant_messages')
    .select('id, content')
    .eq('session_id', sessionId)
    .eq('role', 'assistant');
  if (callId) query = query.eq('call_id', callId);
  const { data: existing } = await query;
  const firstLine = String(text).split('\n')[0].trim();
  if ((existing || []).some((m) => m.content === text || (firstLine.length > 20 && String(m.content || '').startsWith(firstLine)))) {
    return { posted: false, reason: 'duplicate' };
  }
  const { error } = await supabase
    .from('assistant_messages')
    .insert({ user_id: userId, session_id: sessionId, role: 'assistant', content: text, call_id: callId || null, source: 'text' });
  if (error) {
    console.error('callSummary: could not post the call message to the chat', { callId, error: error.message });
    return { posted: false, reason: 'insert-failed' };
  }
  await supabase.from('chat_sessions').update({ updated_at: new Date().toISOString() }).eq('id', sessionId);
  return { posted: true };
}

/**
 * The one "a call just ended, produce its summary and put it where the user will see it" step, used by the End
 * button, the app-call end and the carrier callback. Summarises (retrying a failed generation once), waits for
 * another trigger's in-flight generation instead of posting a generic line, then posts the real summary to the chat
 * thread. A failure is reported honestly in the chat, never swallowed.
 */
export async function finishCallSummary(supabase, call, { env = process.env } = {}) {
  const callId = call?.id;
  let result = await maybeGenerateCallSummary(supabase, callId, { env });
  if (result?.status === 'claimed-elsewhere') result = await waitForCallSummary(supabase, callId);
  if (result?.status === 'failed' || result?.status === 'error') {
    const retry = await maybeGenerateCallSummary(supabase, callId, { env });
    if (retry?.status === 'completed') result = retry;
  }
  if (call?.session_id && call?.user_id) {
    if (result?.status === 'completed' && result.summary) {
      await postCallChatMessage(supabase, { userId: call.user_id, sessionId: call.session_id, callId, text: formatSummaryForChat(result.summary, result.summaryJson) });
    } else if (result?.status === 'failed' || result?.status === 'error') {
      const { data: row } = await supabase.from('calls').select('summary_json').eq('id', callId).maybeSingle();
      const why = row?.summary_json?.error || result.error || 'unknown error';
      await postCallChatMessage(supabase, {
        userId: call.user_id, sessionId: call.session_id, callId,
        text: `The call has ended but I couldn't write its summary (${String(why).slice(0, 160)}). Open the call to try again.`,
      });
    }
  }
  return result;
}
