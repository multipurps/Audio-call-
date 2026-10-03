import { confirmCallPlan } from '../lib/callPlans.js';
import { getServiceClient, getAuthedUserId } from '../lib/supabaseAdmin.js';
import { endCallRow } from '../lib/callHangup.js';
import { createHmac } from 'node:crypto';
import { callSessionId } from '../lib/callNote.js';
import { maybeGenerateCallSummary, waitForCallSummary } from '../lib/callSession.js';

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
    case 'summarize': return summarizeCall(req, res, supabase, userId);
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
    return res.status(409).json({ error: 'Call is not live' });
  }
  const sessionId = callSessionId(call);
  if (!sessionId) {
    return res.status(409).json({ error: 'Listening in is not enabled for this call type yet' });
  }

  const secret = process.env.ASSISTANT_BRIDGE_SECRET;
  const wsBase = (process.env.PUBLIC_ASSISTANT_WS_URL || process.env.ASSISTANT_BRIDGE_URL || '').trim();
  if (!secret || !wsBase) {
    return res.status(501).json({ error: 'Live monitoring is not configured (set PUBLIC_ASSISTANT_WS_URL and ASSISTANT_BRIDGE_SECRET)' });
  }

  const exp = Math.floor(Date.now() / 1000) + 6 * 3600;
  const sig = createHmac('sha256', secret)
    .update(`monitor:${sessionId}:${userId}:${exp}`)
    .digest('hex');
  const token = `${exp}.${userId}.${sig}`;
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
