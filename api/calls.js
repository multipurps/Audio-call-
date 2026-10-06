import { confirmCallPlan, saveCallPlan } from '../lib/callPlans.js';
import { getServiceClient, getAuthedUserId } from '../lib/supabaseAdmin.js';
import { endCallRow } from '../lib/callHangup.js';
import { createHmac, randomUUID } from 'node:crypto';
import { resolveVoiceChoice } from '../lib/voiceChoice.js';
import { createChatCompletion, hasConfiguredLlm } from '../lib/llmClient.js';
import { resolvePersonSession } from '../lib/personSession.js';
import { normalizePhone } from '../lib/phoneNumbers.js';
import { callSessionId } from '../lib/callNote.js';
import { maybeGenerateCallSummary, waitForCallSummary } from '../lib/callSession.js';
import {
  availableChannels, checkVerification, getPhoneLine, isApproved, publicLine,
  removeLine, rentNumber, rentSettings, searchNumbers, startVerification,
} from '../lib/phoneLines.js';

export default async function handler(req, res) {
  const supabase = getServiceClient();
  const userId = await getAuthedUserId(req, supabase);
  if (!userId) return res.status(401).json({ error: 'Not signed in' });

  const action = req.query?.action || req.body?.action;

  switch (action) {
    // Legacy endpoint must not bypass script confirmation.
    case 'create': return confirmCallPlan(req, res, supabase, userId);
    case 'hangup': return hangupCall(req, res, supabase, userId);
    case 'mute': return muteCall(req, res, supabase, userId);
    case 'list': return listCalls(req, res, supabase, userId);
    case 'delete': return deleteCalls(req, res, supabase, userId);
    case 'get': return getCall(req, res, supabase, userId);
    case 'monitor-token': return monitorToken(req, res, supabase, userId);
    case 'app-call-start': return appCallStart(req, res, supabase, userId);
    case 'app-call-brief': return appCallBrief(req, res, supabase, userId);
    case 'summarize': return summarizeCall(req, res, supabase, userId);
    // Phone line (Twilio): bring your own number, or rent one.
    case 'line-get': case 'line-verify-start': case 'line-verify-status':
    case 'line-rent-search': case 'line-rent-buy': case 'line-remove':
      return lineAction(action, req, res, supabase, userId);
    default: return res.status(400).json({ error: 'Unknown or missing action' });
  }
}

// Live audio monitoring: mints a short-lived, per-call HMAC token the browser
// presents to the assistant service's /monitor websocket to hear BOTH sides
// of the call (the person's speech + Emysa's TTS) in real time. The token is
// bound to this call's bridge session and this user — a leaked token cannot
// listen to another call. The bridge secret itself never leaves the server.
//
// The same token shape is verified by pipecat-service/app/monitor.py:
// HMAC-SHA256(secret, "monitor:{sessionId}:{userId}:{exp}") as
// "{exp}.{userId}.{hexsig}".
// The in-app call is the user briefing their own assistant by voice, so they do
// not have to type a long brief. Emysa takes it down; when the call ends the app
// turns it into a call plan the user confirms (see appCallBrief).
function briefingInstructions(contactNames) {
  const contacts = contactNames.length ? ` Contacts you can call for them: ${contactNames.join(', ')}.` : '';
  return 'This is a live voice conversation directly with the person you work for, inside their app. You are Emysa, their assistant. '
    + 'They are briefing you so you can make a call on their behalf, because they cannot type it all or will not be available. '
    + 'Listen and take it down: who to call, what to say or achieve, the key facts, names and numbers, the tone to use, and whether the call should happen now or at a specific time. '
    + 'If something essential is missing (especially who to call), ask one short question. When it is clear, read back a short brief and ask them to confirm. '
    + 'Tell them you will prepare the call for them to confirm; never say a call has been placed. Keep every reply short and natural. '
    + 'There is nobody else on this call to speak to or to represent.' + contacts;
}

function matchContact(contacts, name) {
  const wanted = String(name || '').trim().toLowerCase();
  if (!wanted) return null;
  const exact = contacts.filter((c) => String(c.name || '').trim().toLowerCase() === wanted);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null;
  const partial = contacts.filter((c) => {
    const n = String(c.name || '').trim().toLowerCase();
    return n && (n.includes(wanted) || wanted.includes(n));
  });
  return partial.length === 1 ? partial[0] : null;
}

// Turns a finished briefing call into a PENDING call plan in the person's chat
// with that contact. Nothing is dialed: the user still taps Call Now, the same
// confirmation every call needs. Idempotent per briefing.
async function appCallBrief(req, res, supabase, userId) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const callId = req.body?.callId;
  if (typeof callId !== 'string' || !/^[0-9a-f-]{36}$/i.test(callId)) return res.status(400).json({ error: 'callId required' });
  const { data: call } = await supabase.from('calls').select('id, user_id, platform, transcript, summary_json').eq('id', callId).eq('user_id', userId).maybeSingle();
  if (!call || call.platform !== 'app') return res.status(404).json({ error: 'Call not found' });
  if (call.summary_json?.briefPlanId) return res.status(200).json({ status: 'already-prepared', sessionId: call.summary_json.briefSessionId || null });

  const turns = (Array.isArray(call.transcript) ? call.transcript : [])
    .map((t) => ({ who: (t?.speaker === 'user' || t?.role === 'user') ? 'User' : 'Emysa', text: String(t?.content || t?.text || '').trim() }))
    .filter((t) => t.text);
  if (!turns.some((t) => t.who === 'User')) return res.status(200).json({ status: 'nothing-to-do' });
  if (!hasConfiguredLlm(process.env)) return res.status(503).json({ error: 'The assistant is not configured yet. No call was prepared.' });

  const llm = await createChatCompletion({
    temperature: 0.1,
    max_tokens: 700,
    messages: [
      { role: 'system', content: 'You read a voice conversation in which a user briefs their assistant Emysa to make a phone call for them. Return ONLY JSON: {"ready": boolean, "contactName": string|null, "instructions": string, "summary": string, "when": string|null}. "ready" is true only if the user clearly wants a call made and named who to call. "contactName" is exactly who they said to call. "instructions" is everything Emysa must say or achieve on that call, written as direct instructions with every fact, name, number and the tone, nothing invented. "summary" is one or two short first-person sentences ("I will ...") describing the call. "when" is the time the user asked for, in their words, or null for now.' },
      { role: 'user', content: turns.map((t) => `${t.who}: ${t.text}`).join('\n').slice(0, 12000) },
    ],
  });
  if (!llm.ok) return res.status(502).json({ error: 'Could not read the briefing. No call was prepared.' });
  let brief = null;
  try {
    const raw = llm.data?.choices?.[0]?.message?.content || '';
    brief = JSON.parse(raw.replace(/^```(?:json)?|```$/gim, '').trim());
  } catch { brief = null; }
  if (!brief || brief.ready !== true || !String(brief.instructions || '').trim()) return res.status(200).json({ status: 'no-call-requested' });

  const { data: contacts } = await supabase.from('contacts').select('id, name, phone_number').eq('user_id', userId);
  const contact = matchContact(contacts || [], brief.contactName);
  if (!contact) return res.status(200).json({ status: 'needs-contact', contactName: brief.contactName || null });

  try {
    const label = contact.name;
    const person = await resolvePersonSession(supabase, userId, { sessionId: null, toNumber: normalizePhone(contact.phone_number), contactNumber: null, contactId: contact.id, label });
    const when = typeof brief.when === 'string' && brief.when.trim() ? brief.when.trim().slice(0, 120) : null;
    const instructions = String(brief.instructions).trim().slice(0, 3500);
    const objective = `You are speaking on the user's behalf, in the first person, following the brief below.\n${instructions}`;
    const summary = `${label}: ${String(brief.summary || instructions).trim().slice(0, 400)}${when ? ` (You asked for this ${when}. Scheduled calls are not available yet, so tap Call Now when you are ready.)` : ''}`;
    const reply = await saveCallPlan(supabase, userId, { sessionId: person.sessionId, toNumber: contact.phone_number, contactId: contact.id, objective, script: instructions, summary, label });
    await supabase.from('calls').update({ summary_json: { briefPlanId: reply.call_plan?.id || null, briefSessionId: person.sessionId } }).eq('id', callId).eq('user_id', userId);
    console.log(`appCallBrief: plan prepared call=${callId} plan=${reply.call_plan?.id}`);
    return res.status(200).json({ status: 'prepared', sessionId: person.sessionId, contactName: label, when });
  } catch (err) {
    console.error('appCallBrief: could not save the plan', err?.message);
    return res.status(500).json({ error: 'Could not prepare the call. Nothing was dialed.' });
  }
}

// The in-app Emysa call: a live GPT-Live session (mic open the whole call, the
// model's voice streamed back), the same conversation WhatsApp calls run. The
// service picks the engine and voice from the user's saved choice: GPT-Live
// always, except when the user chose their cloned voice. This only creates the
// call row (so persona, transcript, summary and push work like any call) and
// mints a short-lived token for the browser; the browser never sees the secret.
async function appCallStart(req, res, supabase, userId) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const secret = process.env.ASSISTANT_BRIDGE_SECRET;
  let wsBase = (process.env.PUBLIC_ASSISTANT_WS_URL || process.env.ASSISTANT_BRIDGE_URL || '').trim();
  if (!secret) return res.status(501).json({ error: 'Live calls are not set up: ASSISTANT_BRIDGE_SECRET is missing on Vercel', code: 'missing-secret' });
  if (!wsBase) return res.status(501).json({ error: 'Live calls are not set up: PUBLIC_ASSISTANT_WS_URL is missing on Vercel', code: 'missing-url' });
  wsBase = wsBase.replace(/^https:\/\//i, 'wss://').replace(/^http:\/\//i, 'ws://');
  if (!/^wss:\/\//i.test(wsBase) && !/^ws:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(wsBase)) {
    return res.status(501).json({ error: 'Live calls need a secure URL: set PUBLIC_ASSISTANT_WS_URL to a wss:// address', code: 'insecure-url' });
  }

  // Link the call to the chat it was started from, so the summary lands in that thread.
  let chatSessionId = null;
  const requested = req.body?.sessionId;
  if (typeof requested === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requested)) {
    const { data: chat } = await supabase.from('chat_sessions').select('id').eq('id', requested).eq('user_id', userId).maybeSingle();
    chatSessionId = chat?.id || null;
  }

  const { data: contactRows } = await supabase.from('contacts').select('name').eq('user_id', userId).limit(60);
  const contactNames = (contactRows || []).map((c) => String(c.name || '').trim()).filter(Boolean);

  const choice = await resolveVoiceChoice(supabase, userId);
  const platformCallId = randomUUID();
  const sessionId = `call-${platformCallId}`;
  const { data: row, error } = await supabase.from('calls').insert({
    user_id: userId,
    platform: 'app',
    platform_call_id: platformCallId,
    to_number: 'Emysa',
    objective: 'Have a live voice conversation with the user.',
    instructions: briefingInstructions(contactNames),
    status: 'in_progress',
    answered_at: new Date().toISOString(),
    session_id: chatSessionId,
    transcript: [],
  }).select('id').single();
  if (error || !row) {
    console.error(`appCallStart: could not create the call row user=${userId} error=${error?.message}`);
    return res.status(500).json({ error: 'Could not start the call' });
  }

  const exp = Math.floor(Date.now() / 1000) + 600;
  const sig = createHmac('sha256', secret).update(`appcall:${sessionId}:${userId}:${exp}`).digest('hex');
  const token = `${exp}.${userId}.${sig}`;
  const base = wsBase.replace(/\/stream\/?$/, '').replace(/\/+$/, '');
  console.log(`[voice] app call start call=${row.id} engine=${choice.mode === 'custom' ? 'classic' : 'gpt-live'} provider=${choice.provider} voice=${choice.mode === 'custom' ? 'clone' : choice.voiceId} source=${choice.source}`);
  return res.status(200).json({
    callId: row.id,
    sessionId,
    engine: choice.mode === 'custom' ? 'classic' : 'gpt-live',
    sampleRate: 16000,
    url: `${base}/app-call/${encodeURIComponent(sessionId)}?token=${encodeURIComponent(token)}`,
  });
}

async function monitorToken(req, res, supabase, userId) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const { callId } = req.body || {};
  if (!callId) return res.status(400).json({ error: 'callId required' });

  const { data: call } = await supabase
    .from('calls')
    .select('*')
    .eq('id', callId)
    .eq('user_id', userId)
    .maybeSingle();
  if (!call) return res.status(404).json({ error: 'Call not found' });
  if (!['queued', 'ringing', 'in_progress'].includes(call.status)) {
    return res.status(409).json({ error: `Call is not live (status: ${call.status})`, code: 'not-live' });
  }
  const sessionId = callSessionId(call);
  if (!sessionId) {
    console.warn(`monitorToken: no bridge session for call=${callId} platform=${call.platform} hasPlatformCallId=${Boolean(call.platform_call_id)}`);
    return res.status(409).json({ error: call.platform === 'phone' || call.platform === 'twilio' ? 'Listen-in is not enabled for phone calls yet' : 'This call has no live audio session yet (WhatsApp has not attached the assistant). Try again in a few seconds.', code: 'no-session' });
  }

  const secret = process.env.ASSISTANT_BRIDGE_SECRET;
  let wsBase = (process.env.PUBLIC_ASSISTANT_WS_URL || process.env.ASSISTANT_BRIDGE_URL || '').trim();
  if (!secret) {
    console.error(`monitorToken: ASSISTANT_BRIDGE_SECRET is not set on Vercel call=${callId}`);
    return res.status(501).json({ error: 'Listen-in is not set up: ASSISTANT_BRIDGE_SECRET is missing on Vercel', code: 'missing-secret' });
  }
  if (!wsBase) {
    console.error(`monitorToken: PUBLIC_ASSISTANT_WS_URL is not set call=${callId}`);
    return res.status(501).json({ error: 'Listen-in is not set up: PUBLIC_ASSISTANT_WS_URL is missing on Vercel', code: 'missing-url' });
  }
  // The app is served over HTTPS, so the browser refuses a plain ws:// socket
  // (mixed content) and the monitor would stay silent. Accept https:// as
  // shorthand, and refuse anything that cannot work with a clear reason.
  wsBase = wsBase.replace(/^https:\/\//i, 'wss://').replace(/^http:\/\//i, 'ws://');
  if (!/^wss:\/\//i.test(wsBase)) {
    const local = /^ws:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(wsBase);
    if (!local) {
      console.error(`monitorToken: assistant URL is not wss:// call=${callId}`);
      return res.status(501).json({ error: 'Listen-in needs a secure URL: set PUBLIC_ASSISTANT_WS_URL to a wss:// address', code: 'insecure-url' });
    }
  }

  const exp = Math.floor(Date.now() / 1000) + 6 * 3600;
  const sig = createHmac('sha256', secret)
    .update(`monitor:${sessionId}:${userId}:${exp}`)
    .digest('hex');
  const token = `${exp}.${userId}.${sig}`;
  console.log(`monitorToken: issued call=${callId} session=${sessionId}`);
  const base = wsBase.replace(/\/stream\/?$/, '').replace(/\/+$/, '');
  return res.status(200).json({
    token,
    sessionId,
    sampleRate: 16000,
    url: `${base}/monitor/${encodeURIComponent(sessionId)}?token=${encodeURIComponent(token)}`,
  });
}

// On-demand summary for a finished call that has a transcript but no summary
// (generation failed, or never ran). Same shared, idempotent generator as the
// automatic path; returns the real failure reason so it can be shown/fixed.
async function summarizeCall(req, res, supabase, userId) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const { callId } = req.body || {};
  if (!callId) return res.status(400).json({ error: 'callId required' });
  const { data: call } = await supabase
    .from('calls').select('id').eq('id', callId).eq('user_id', userId).maybeSingle();
  if (!call) return res.status(404).json({ error: 'Call not found' });

  let result = await maybeGenerateCallSummary(supabase, callId);
  if (result?.status === 'claimed-elsewhere') {
    result = await waitForCallSummary(supabase, callId, { timeoutMs: 15_000 });
  }
  const { data: fresh } = await supabase
    .from('calls').select('outcome_summary, summary_json, summary_status').eq('id', callId).maybeSingle();
  return res.status(200).json({
    status: result?.status || 'unknown',
    summary: fresh?.outcome_summary || null,
    summary_json: fresh?.summary_json || null,
    summary_status: fresh?.summary_status || null,
    error: result?.error || fresh?.summary_json?.error || null,
  });
}

async function getCall(req, res, supabase, userId) {
  const callId = req.query?.callId || req.body?.callId;
  if (!callId) return res.status(400).json({ error: 'callId required' });
  const { data: call, error } = await supabase
    .from('calls')
    .select('*')
    .eq('id', callId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!call) return res.status(404).json({ error: 'Call not found' });
  return res.status(200).json({ call });
}


async function hangupCall(req, res, supabase, userId) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const { callId } = req.body || {};
  if (!callId) return res.status(400).json({ error: 'callId required' });

  const { data: call } = await supabase.from('calls').select('*').eq('id', callId).eq('user_id', userId).maybeSingle();
  if (!call) return res.status(404).json({ error: 'Call not found' });

  const result = await endCallRow(supabase, userId, call);
  if (!result.ok) return res.status(result.httpStatus || 502).json({ error: result.error, detail: result.detail });
  return res.status(200).json(result.alreadyEnded ? { ok: true, alreadyEnded: true } : { ok: true });
}

async function muteCall(req, res, supabase, userId) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const { callId, muted } = req.body || {};
  if (!callId || typeof muted !== 'boolean') return res.status(400).json({ error: 'callId and muted required' });

  const { error } = await supabase.from('calls').update({ ai_muted: muted }).eq('id', callId).eq('user_id', userId);
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ ok: true });
}

// Removes calls (and their transcripts/summaries) from Recent. Scoped to the
// signed-in user; live calls are never deleted out from under the call screen.
async function deleteCalls(req, res, supabase, userId) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const ids = Array.isArray(req.body?.callIds) ? req.body.callIds.filter((x) => typeof x === 'string' && /^[0-9a-f-]{36}$/i.test(x)).slice(0, 500) : [];
  if (!ids.length) return res.status(400).json({ error: 'callIds required' });
  const { error } = await supabase.from('calls').delete()
    .eq('user_id', userId).in('id', ids).not('status', 'in', '(queued,ringing,in_progress)');
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ ok: true });
}

async function listCalls(req, res, supabase, userId) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
  const { data, error } = await supabase
    .from('calls')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) return res.status(500).json({ error: error.message });

  const contactIds = [...new Set((data || []).map((c) => c.contact_id).filter(Boolean))];
  let namesById = new Map();
  if (contactIds.length) {
    const { data: contacts } = await supabase.from('contacts').select('id,name').in('id', contactIds);
    namesById = new Map((contacts || []).map((c) => [c.id, c.name]));
  }
  const callIds = (data || []).map((c) => c.id);
  let planByCallId = new Map();
  if (callIds.length) {
    const { data: plans } = await supabase.from('call_plans').select('call_id, script, summary').in('call_id', callIds);
    planByCallId = new Map((plans || []).map((p) => [p.call_id, p]));
  }
  const calls = (data || []).map((c) => ({
    ...c,
    contact_name: c.call_kind === 'emysa' ? 'Emysa (callback to you)' : c.contact_id ? namesById.get(c.contact_id) || null : null,
    script: planByCallId.get(c.id)?.script || null,
    summary: planByCallId.get(c.id)?.summary || null,
  }));

  return res.status(200).json({ calls });
}

// Phone line actions. Approval is enforced HERE, server-side: the app only
// hides screens from unapproved users, which is not access control, and these
// actions can start real Twilio charges.
async function lineAction(action, req, res, supabase, userId) {
  if (!(await isApproved(supabase, userId))) return res.status(403).json({ error: 'Your account is not approved yet.' });
  const send = (result) => (result.error
    ? res.status(result.status || 400).json({ error: result.error })
    : res.status(200).json(result));
  const needPost = () => (req.method !== 'POST' ? res.status(405).json({ error: 'POST only' }) : null);

  switch (action) {
    case 'line-get': {
      const [line, channels] = await Promise.all([getPhoneLine(supabase, userId), availableChannels(supabase, userId)]);
      const rent = rentSettings();
      return res.status(200).json({ line: publicLine(line), channels, rent });
    }
    case 'line-verify-start':
      return needPost() || send(await startVerification(supabase, userId, req.body?.phone));
    case 'line-verify-status':
      return send(await checkVerification(supabase, userId));
    case 'line-rent-search':
      return send(await searchNumbers({ country: req.query?.country || 'US', areaCode: req.query?.areaCode }));
    case 'line-rent-buy':
      return needPost() || send(await rentNumber(supabase, userId, req.body?.phoneNumber));
    case 'line-remove':
      return needPost() || send(await removeLine(supabase, userId));
    default:
      return res.status(400).json({ error: 'Unknown action' });
  }
}
