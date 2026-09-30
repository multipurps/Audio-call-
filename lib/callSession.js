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
import {
  consolidateAndStoreMemories,
  inferMemoryType,
} from './memoryManager.js';

export const TERMINAL_CALL_STATUSES = Object.freeze(['completed', 'failed', 'no_answer', 'busy', 'canceled']);

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
  extra = {},
} = {}) {
  const { data, error } = await supabase
    .from('calls')
    .insert({
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
      ...extra,
    })
    .select('id')
    .single();
  if (error) throw new Error(error.message);
  return data;
}

/** Record the provider's call id and move the row to `ringing`. */
export async function markCallPlaced(supabase, callId, { platformCallId = null, status = 'ringing' } = {}) {
  const patch = { status };
  if (platformCallId) patch.platform_call_id = platformCallId;
  const { error } = await supabase.from('calls').update(patch).eq('id', callId);
  if (error) throw new Error(error.message);
}

/** Mark a call that never reached the provider as `failed`. */
export async function markCallFailed(supabase, callId) {
  if (!callId) return;
  await supabase
    .from('calls')
    .update({ status: 'failed', ended_at: new Date().toISOString() })
    .eq('id', callId)
    .neq('status', 'completed'); // never resurrect an ended call
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

const SUMMARY_SYSTEM_PROMPT = `You are Emysa's call summariser. You receive the transcript of one finished phone/WhatsApp/Telegram call and must produce a structured summary of ONLY what is actually in the transcript.

Rules:
- Never invent facts, names, dates, amounts or agreements that are not present in the transcript.
- If the transcript is partial (starts mid-conversation, cuts off, or contains a lot of unrecognised speech marked [unintelligible]/noise), set "incomplete": true and only summarise what is clearly there.
- Distinguish confirmed facts from uncertainty: put uncertain or unclear items in "unresolved" rather than "decisions".
- "commitments" records promises/agreements and who made them when the transcript says.
- "memories" holds 0-3 short, durable, non-secret personal facts worth remembering for future calls with this person (preferences, stable details about them or the user's arrangement with them). Never include passwords, codes, card numbers, OTPs or one-off transient details. Use plain third person (e.g. "Prefers morning calls").

Reply with ONLY a JSON object, no other text:
{"summary":"2-5 plain sentences logging what happened and the outcome","topics":["main topics discussed"],"learned":["important information learned"],"decisions":["decisions/agreements made"],"commitments":["promises or commitments, with who when clear"],"details":["dates, amounts and other important specifics mentioned"],"followups":["concrete follow-up actions"],"unresolved":["open/unanswered questions"],"memories":["up to 3 durable facts or empty array"],"incomplete":true|false}`;

function transcriptForPrompt(transcript) {
  const lines = (Array.isArray(transcript) ? transcript : [])
    .map((t) => {
      const speaker = t?.speaker === 'ai' || t?.speaker === 'assistant' || t?.role === 'assistant' ? 'Emysa' : 'Caller';
      const text = String(t?.content || t?.text || '').trim();
      return text ? `${speaker}: ${text}` : '';
    })
    .filter(Boolean);
  const joined = lines.join('\n');
  return joined.length > 8000 ? lines.slice(-120).join('\n') : joined;
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
export async function maybeGenerateCallSummary(supabase, callId, { env = process.env } = {}) {
  if (!supabase || !callId) return { status: 'noop' };

  const { data: call } = await supabase
    .from('calls')
    .select('id, user_id, contact_id, platform, objective, instructions, status, transcript, outcome_summary, summary_status, summary_json, duration_seconds, created_at')
    .eq('id', callId)
    .maybeSingle();
  if (!call) return { status: 'missing' };
  if (!isTerminalCallStatus(call.status)) return { status: 'not-terminal' };
  if (call.outcome_summary) return { status: 'already-summarised' };

  const transcript = Array.isArray(call.transcript) ? call.transcript : [];
  const spokenTurns = transcript.filter((t) => String(t?.content || t?.text || '').trim());

  // Nothing was said (busy signal / no answer / instant failure): record that
  // deliberately instead of leaving the state ambiguous — and say plainly
  // that no summary exists because the conversation was not captured, rather
  // than leaving a generic "Call finished" in its place.
  if (spokenTurns.length === 0) {
    if (!call.summary_status) {
      const endedNoTalk = ['no_answer', 'busy', 'canceled'].includes(call.status);
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
    .neq('summary_status', 'completed')
    .select('summary_json');
  if (claimError) return { status: 'error', error: claimError.message };
  // Read-back CAS: whoever wrote the latest claimedAt is the claimant.
  if (!claimed || claimed[0]?.summary_json?.claimedAt !== myClaim) return { status: 'claimed-elsewhere' };

  const prompt = [
    `Contact/platform: ${call.platform || 'phone'} call${call.objective ? '' : '.'}${call.objective ? ` — objective: ${call.objective}` : ''}`,
    call.instructions ? `User's instructions for this call: ${call.instructions}` : '',
    `Call status: ${call.status}${call.duration_seconds ? `, duration ${call.duration_seconds}s` : ''}.`,
    '',
    'Transcript:',
    transcriptForPrompt(transcript),
  ].filter(Boolean).join('\n');

  try {
    const llmResult = await createChatCompletion({
      messages: [
        { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
      temperature: 0.2,
      max_tokens: 500,
      response_format: { type: 'json_object' },
      env,
    });
    if (!llmResult.ok) throw new Error(llmResult.errorText || 'summary LLM request failed');

    let parsed;
    try {
      parsed = JSON.parse(llmResult.data?.choices?.[0]?.message?.content || '{}');
    } catch {
      const match = String(llmResult.data?.choices?.[0]?.message?.content || '').match(/\{[\s\S]*\}/);
      parsed = match ? JSON.parse(match[0]) : {};
    }

    const summaryText = String(parsed.summary || '').trim();
    if (!summaryText) throw new Error('empty summary');
    const incomplete = parsed.incomplete === true;
    const summaryJson = {
      topics: asStringArray(parsed.topics),
      learned: asStringArray(parsed.learned),
      decisions: asStringArray(parsed.decisions),
      commitments: asStringArray(parsed.commitments),
      details: asStringArray(parsed.details),
      followups: asStringArray(parsed.followups),
      unresolved: asStringArray(parsed.unresolved),
      incomplete,
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

    // Summary persisted first; memories afterwards, so a memory failure can
    // never cost us the summary.
    const candidates = asStringArray(parsed.memories)
      .map((m) => ({ content: String(m), memory_type: inferMemoryType(String(m), callId) }))
      .filter((m) => m.content);
    if (candidates.length > 0 && call.user_id) {
      try {
        await consolidateAndStoreMemories({
          supabase,
          userId: call.user_id,
          contactId: call.contact_id || null,
          sourceCallId: callId,
          candidates,
        });
      } catch (memErr) {
        console.error('callSummary: memory storage failed', memErr?.message || memErr);
      }
    }

    return { status: 'completed', summary: outcome };
  } catch (err) {
    console.error('callSummary: generation failed', err?.message || err);
    await supabase
      .from('calls')
      .update({ summary_status: 'failed' })
      .eq('id', callId)
      .eq('summary_status', 'pending');
    return { status: 'failed', error: err?.message || String(err) };
  }
}

function asStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map((v) => String(v).trim()).filter(Boolean).slice(0, 12);
}
