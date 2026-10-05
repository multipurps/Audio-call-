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

/** Mark a call that never reached the provider as `failed`. */
export async function markCallFailed(supabase, callId, reason) {
  if (!callId) return;
  const update = { status: 'failed', ended_at: new Date().toISOString() };
  // Keep the real reason on the row. Every screen that lists or opens the
  // call prefers outcome_summary, so the person sees WHY (declined, busy,
  // not on WhatsApp...) instead of a generic "failed to connect".
  const text = String(reason || '').trim();
  if (text) update.outcome_summary = `Couldn't connect: ${text}`.slice(0, 300);
  await supabase
    .from('calls')
    .update(update)
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
- If the call reached a voicemail or answering machine (a recorded greeting, "leave a message", a beep), the first sentence of the summary must say so.
- If the transcript is partial (starts mid-conversation, cuts off, or contains a lot of unrecognised speech marked [unintelligible]/noise), set "incomplete": true and only summarise what is clearly there.
- Distinguish confirmed facts from uncertainty: put uncertain or unclear items in "unresolved" rather than "decisions".
- "commitments" records promises/agreements and who made them when the transcript says.
- "memories" holds 0-3 short, durable, non-secret personal facts worth remembering for future calls with this person (preferences, stable details about them or the user's arrangement with them). Never include passwords, codes, card numbers, OTPs or one-off transient details. Use plain third person (e.g. "Prefers morning calls").

Reply with ONLY a JSON object, no other text:
{"summary":"a clear account of EVERYTHING discussed, in order, in 3-8 plain sentences, ending with the outcome","topics":["main topics discussed"],"learned":["important information learned"],"decisions":["decisions/agreements made"],"commitments":["promises or commitments, with who when clear"],"details":["dates, amounts and other important specifics mentioned"],"followups":["concrete follow-up actions"],"unresolved":["open/unanswered questions"],"memories":["up to 3 durable facts or empty array"],"incomplete":true|false}`;

// The whole conversation goes to the model (a 30 minute call is well inside its context). Only a transcript
// beyond MAX_PROMPT_CHARS is trimmed, and then the middle is cut with an explicit marker (never the start or the
// end, which hold the greeting/objective and the outcome) and the model is told it is partial.
const MAX_PROMPT_CHARS = 60_000;

export function transcriptForPrompt(transcript) {
  const lines = (Array.isArray(transcript) ? transcript : [])
    .map((t) => {
      const speaker = t?.speaker === 'ai' || t?.speaker === 'assistant' || t?.role === 'assistant' ? 'Emysa' : 'Caller';
      const text = String(t?.content || t?.text || '').trim();
      return text ? `${speaker}: ${text}` : '';
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
  for (const key of ['topics', 'learned', 'decisions', 'commitments', 'details', 'followups', 'unresolved', 'memories']) {
    const am = raw.match(new RegExp(`"${key}"\\s*:\\s*(\\[[^\\]]*\\])`));
    if (am) { try { out[key] = JSON.parse(am[1]); } catch { /* skip an incomplete array */ } }
  }
  return { parsed: out, salvaged: true };
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
    .select('id, user_id, contact_id, platform, objective, instructions, status, transcript, outcome_summary, summary_status, summary_json, duration_seconds, created_at')
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
    `Contact/platform: ${call.platform || 'phone'} call${call.objective ? '' : '.'}${call.objective ? ` — objective: ${call.objective}` : ''}`,
    call.instructions ? `User's instructions for this call: ${call.instructions}` : '',
    `Call status: ${call.status}${call.duration_seconds ? `, duration ${call.duration_seconds}s` : ''}.`,
    omittedLines ? `Note: ${omittedLines} lines from the middle of a long call were omitted; treat the transcript as partial.` : '',
    '',
    'Transcript:',
    transcriptText,
  ].filter(Boolean).join('\n');

  try {
    // 2000 output tokens is plenty for the whole schema; if the model still hits the limit, retry once with double
    // before falling back to salvaging what it did write.
    let llmResult;
    let reply;
    const startedMs = Date.now();
    for (const maxTokens of [2000, 4000]) {
      llmResult = await createChatCompletion({
        messages: [
          { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
          { role: 'user', content: prompt },
        ],
        temperature: 0.2,
        max_tokens: maxTokens,
        response_format: { type: 'json_object' },
        env,
        timeoutMs: 30_000,
      });
      if (!llmResult.ok) throw new Error(llmResult.errorText || 'summary LLM request failed');
      reply = llmResult.data?.choices?.[0];
      if (reply?.finish_reason !== 'length') break;
      console.warn('callSummary: reply hit the token limit', { callId, maxTokens });
      // This runs inside a 60s serverless function: do not start a second attempt that cannot finish.
      if (Date.now() - startedMs > 25_000) break;
    }

    const { parsed, salvaged } = parseSummaryReply(reply?.message?.content);
    if (salvaged) console.warn('callSummary: reply was cut off; salvaged what was complete', { callId });

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
  const sections = [
    ['Decisions', summaryJson?.decisions],
    ['Commitments', summaryJson?.commitments],
    ['Details', summaryJson?.details],
    ['Follow-ups', summaryJson?.followups],
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
  let query = supabase
    .from('assistant_messages')
    .select('id')
    .eq('session_id', sessionId)
    .eq('role', 'assistant')
    .eq('content', text);
  if (callId) query = query.eq('call_id', callId);
  const { data: existing } = await query.limit(1);
  if (existing?.length) return { posted: false, reason: 'duplicate' };
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
      await postCallChatMessage(supabase, { userId: call.user_id, sessionId: call.session_id, callId, text: result.summary });
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
