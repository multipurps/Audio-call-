// Admin API for the global AI behavior + shared knowledge system (sql/041_ai_behavior.sql).
// Mounted from api/admin.js under ?action=ai-*. Every action is already behind getAdminAccess.
// This edits prompt configuration and retrieval content. It does not train or fine-tune any model.
import { createHmac, randomUUID } from 'crypto';
import { createChatCompletion } from './llmClient.js';

const KINDS = ['fact', 'rule', 'example', 'correction'];
const MODELS = ['live', 'luna'];
const MODES = ['phone', 'app', 'social'];
const STATUSES = ['draft', 'published', 'archived'];
const SECTIONS = ['style', 'language', 'disagree', 'interrupt', 'jokes', 'reacts'];
const HINT = 'AI behavior tables are not set up. Run sql/041_ai_behavior.sql in Supabase.';

const clean = (v, max) => String(v ?? '').replace(/\u0000/g, '').replace(/\r/g, '').trim().slice(0, max);
const cleanList = (v, maxItems, maxLen) =>
  (Array.isArray(v) ? v : String(v || '').split('\n')).map((x) => clean(x, maxLen)).filter(Boolean).slice(0, maxItems);
const pickEnum = (list, v, fallback) => (list.includes(v) ? v : fallback);
const pickSet = (list, v, fallback) => {
  const out = (Array.isArray(v) ? v : []).filter((x) => list.includes(x));
  return out.length ? [...new Set(out)] : fallback;
};

export function sanitizeConfig(input) {
  const src = input && typeof input === 'object' ? input : {};
  const global = {};
  for (const key of SECTIONS) global[key] = clean(src.global?.[key], 700);
  const models = {};
  for (const m of MODELS) models[m] = { extra: clean(src.models?.[m]?.extra, 1500) };
  return { global, must: cleanList(src.must, 40, 220), avoid: cleanList(src.avoid, 60, 120), models };
}

export function sanitizeKnowledge(input) {
  const src = input && typeof input === 'object' ? input : {};
  const title = clean(src.title, 160);
  if (!title) throw new Error('A title is required.');
  return {
    kind: pickEnum(KINDS, src.kind, 'fact'),
    title,
    body: clean(src.body, 2000),
    good_example: clean(src.good_example, 600) || null,
    bad_example: clean(src.bad_example, 600) || null,
    why: clean(src.why, 600) || null,
    tags: cleanList(src.tags, 12, 40).map((t) => t.toLowerCase()),
    models: pickSet(MODELS, src.models, MODELS),
    modes: pickSet(MODES, src.modes, MODES),
    always: Boolean(src.always),
  };
}

async function audit(supabase, access, action, entity, entityId, detail) {
  try {
    await supabase.from('ai_audit_log').insert({
      actor_email: access.email, action, entity, entity_id: entityId == null ? null : String(entityId), detail: detail || null,
    });
  } catch (err) { console.error('ai audit write failed:', err?.message); }
}

const fail = (res, error, status = 500) => {
  const msg = String(error?.message || error || '');
  if (/relation .* does not exist|function .* does not exist|schema cache/i.test(msg)) return res.status(503).json({ error: HINT });
  return res.status(status).json({ error: status >= 500 ? 'Something went wrong.' : msg });
};

async function overview(res, supabase) {
  const [{ data: versions, error: e1 }, { count: published }, { count: drafts }] = await Promise.all([
    supabase.from('ai_config_versions').select('*').order('version', { ascending: false }).limit(25),
    supabase.from('ai_knowledge').select('id', { count: 'exact', head: true }).eq('status', 'published'),
    supabase.from('ai_knowledge').select('id', { count: 'exact', head: true }).eq('status', 'draft'),
  ]);
  if (e1) throw e1;
  const live = (versions || []).find((v) => v.status === 'published') || null;
  const draft = (versions || []).find((v) => v.status === 'draft') || null;
  return res.status(200).json({ live, draft, versions: versions || [], knowledge: { published: published || 0, drafts: drafts || 0 } });
}

async function saveConfig(req, res, supabase, access) {
  const config = sanitizeConfig(req.body?.config);
  const note = clean(req.body?.note, 200) || null;
  const { data: rows, error } = await supabase.from('ai_config_versions').select('version, status').order('version', { ascending: false }).limit(50);
  if (error) throw error;
  const draft = (rows || []).find((r) => r.status === 'draft');
  const next = ((rows || [])[0]?.version || 0) + 1;
  let row;
  if (draft) {
    const { data, error: err2 } = await supabase.from('ai_config_versions').update({ config, note, created_by: access.email }).eq('version', draft.version).select().single();
    if (err2) throw err2;
    row = data;
  } else {
    const { data, error: err3 } = await supabase.from('ai_config_versions').insert({ version: next, status: 'draft', config, note, created_by: access.email }).select().single();
    if (err3) throw err3;
    row = data;
  }
  await audit(supabase, access, 'config.save_draft', 'config', row.version, { note });
  return res.status(200).json({ draft: row });
}

async function publishConfig(req, res, supabase, access, action) {
  const version = Number(req.body?.version);
  if (!Number.isInteger(version) || version < 1) return res.status(400).json({ error: 'version required' });
  const { error } = await supabase.rpc('ai_publish_config', { p_version: version, p_actor: access.email });
  if (error) throw error;
  await audit(supabase, access, action === 'ai-config-rollback' ? 'config.rollback' : 'config.publish', 'config', version, null);
  return res.status(200).json({ ok: true, version, appliesTo: 'new calls within about 30 seconds; calls already in progress keep what they started with' });
}

async function listKnowledge(req, res, supabase) {
  let q = supabase.from('ai_knowledge').select('*').order('updated_at', { ascending: false }).limit(300);
  const status = req.query?.status || req.body?.status;
  const kind = req.query?.kind || req.body?.kind;
  if (STATUSES.includes(status)) q = q.eq('status', status);
  if (KINDS.includes(kind)) q = q.eq('kind', kind);
  const search = clean(req.query?.q || req.body?.q, 80).replace(/[%,()]/g, ' ');
  if (search) q = q.or(`title.ilike.%${search}%,body.ilike.%${search}%`);
  const { data, error } = await q;
  if (error) throw error;
  return res.status(200).json({ items: data || [] });
}

async function snapshot(supabase, access, id) {
  const { data } = await supabase.from('ai_knowledge').select('*').eq('id', id).maybeSingle();
  if (data) await supabase.from('ai_knowledge_history').insert({ knowledge_id: id, snapshot: data, changed_by: access.email });
  return data;
}

async function saveKnowledge(req, res, supabase, access) {
  const fields = sanitizeKnowledge(req.body?.item);
  const id = req.body?.item?.id;
  if (id) {
    const before = await snapshot(supabase, access, id);
    if (!before) return res.status(404).json({ error: 'Entry not found.' });
    // Editing a live entry pulls it back to draft: changes need approval again before calls see them.
    const status = before.status === 'published' ? 'draft' : before.status;
    const { data, error } = await supabase.from('ai_knowledge')
      .update({ ...fields, status, updated_by: access.email, updated_at: new Date().toISOString() }).eq('id', id).select().single();
    if (error) throw error;
    await audit(supabase, access, 'knowledge.update', 'knowledge', id, { title: fields.title, wasPublished: before.status === 'published' });
    return res.status(200).json({ item: data });
  }
  const { data, error } = await supabase.from('ai_knowledge')
    .insert({ ...fields, status: 'draft', created_by: access.email, updated_by: access.email }).select().single();
  if (error) throw error;
  await audit(supabase, access, 'knowledge.create', 'knowledge', data.id, { title: fields.title });
  return res.status(200).json({ item: data });
}

async function setKnowledgeStatus(req, res, supabase, access) {
  const { id } = req.body || {};
  const status = req.body?.status;
  if (!id || !STATUSES.includes(status)) return res.status(400).json({ error: 'id and a valid status are required' });
  const before = await snapshot(supabase, access, id);
  if (!before) return res.status(404).json({ error: 'Entry not found.' });
  const patch = { status, updated_by: access.email, updated_at: new Date().toISOString() };
  if (status === 'published') patch.approved_by = access.email;
  const { data, error } = await supabase.from('ai_knowledge').update(patch).eq('id', id).select().single();
  if (error) throw error;
  await audit(supabase, access, `knowledge.${status}`, 'knowledge', id, { title: before.title, from: before.status });
  return res.status(200).json({ item: data });
}

async function deleteKnowledge(req, res, supabase, access) {
  const { id } = req.body || {};
  if (!id) return res.status(400).json({ error: 'id required' });
  const before = await snapshot(supabase, access, id);
  if (!before) return res.status(404).json({ error: 'Entry not found.' });
  const { error } = await supabase.from('ai_knowledge').delete().eq('id', id);
  if (error) throw error;
  await audit(supabase, access, 'knowledge.delete', 'knowledge', id, { title: before.title });
  return res.status(200).json({ ok: true });
}

async function knowledgeHistory(req, res, supabase) {
  const id = req.query?.id || req.body?.id;
  if (!id) return res.status(400).json({ error: 'id required' });
  const { data, error } = await supabase.from('ai_knowledge_history').select('id, changed_by, changed_at, snapshot').eq('knowledge_id', id).order('changed_at', { ascending: false }).limit(30);
  if (error) throw error;
  return res.status(200).json({ history: data || [] });
}

async function restoreKnowledge(req, res, supabase, access) {
  const { id, historyId } = req.body || {};
  if (!id || !historyId) return res.status(400).json({ error: 'id and historyId required' });
  const { data: h, error: e1 } = await supabase.from('ai_knowledge_history').select('snapshot').eq('id', historyId).eq('knowledge_id', id).maybeSingle();
  if (e1) throw e1;
  if (!h) return res.status(404).json({ error: 'Version not found.' });
  await snapshot(supabase, access, id);
  const fields = sanitizeKnowledge(h.snapshot);
  // Restored text comes back as a draft so it still goes through approval.
  const { data, error } = await supabase.from('ai_knowledge')
    .update({ ...fields, status: 'draft', updated_by: access.email, updated_at: new Date().toISOString() }).eq('id', id).select().single();
  if (error) throw error;
  await audit(supabase, access, 'knowledge.restore', 'knowledge', id, { historyId });
  return res.status(200).json({ item: data });
}

async function previewContext(supabase, { model, mode, query, config, includeDrafts }) {
  const { data, error } = await supabase.rpc('ai_global_context', {
    p_model: pickEnum(MODELS, model, 'luna'), p_mode: pickEnum(MODES, mode, 'phone'), p_query: clean(query, 600),
    p_config: config || null, p_include_drafts: Boolean(includeDrafts),
  });
  if (error) throw error;
  return { version: data?.version ?? 0, block: String(data?.block || '') };
}

async function preview(req, res, supabase) {
  const b = req.body || {};
  const config = b.useDraftConfig ? sanitizeConfig(b.config) : null;
  return res.status(200).json(await previewContext(supabase, { ...b, config, includeDrafts: b.includeDrafts }));
}

const TEST_BASE = 'You are Emysa speaking on a live phone call as the person who set the call up. Reply with only what you would say out loud: one or two short, natural sentences.';

async function runOne(block, userText) {
  const system = block ? `${TEST_BASE}\n\nHouse guidance from the Emysa team:\n${block}` : TEST_BASE;
  const t0 = Date.now();
  const r = await createChatCompletion({ messages: [{ role: 'system', content: system }, { role: 'user', content: userText }], temperature: 0.7, max_tokens: 160, timeoutMs: 20000 });
  return { ok: r.ok, ms: Date.now() - t0, text: String(r.data?.choices?.[0]?.message?.content || '').trim() };
}

async function judge(userText, reply, avoid, must) {
  const prompt = `Rate this phone-call reply from 1 to 5 on each: naturalness (sounds like a real person talking), relevance (answers what was said), compliance (follows the rules).\nRules: ${must.join(' | ') || 'none'}\nNever-say list: ${avoid.join(' | ') || 'none'}\nCaller said: ${userText}\nReply: ${reply}\nAnswer with only JSON: {"naturalness":n,"relevance":n,"compliance":n}`;
  const r = await createChatCompletion({ messages: [{ role: 'user', content: prompt }], temperature: 0, max_tokens: 60, timeoutMs: 15000 });
  try {
    const raw = String(r.data?.choices?.[0]?.message?.content || '').replace(/```json|```/g, '').trim();
    const j = JSON.parse(raw);
    const n = (x) => Math.min(5, Math.max(1, Number(x) || 0));
    return { naturalness: n(j.naturalness), relevance: n(j.relevance), compliance: n(j.compliance) };
  } catch { return null; }
}

// Compares the live config with a proposed one on sample caller lines. Both models are tested
// through Luna as text: GPT-Live cannot be driven as text, so this is a proxy for wording and
// rule-following, not for audio behavior, interruptions or voice latency.
async function testConfig(req, res, supabase, access) {
  const b = req.body || {};
  const scenarios = cleanList(b.scenarios, 6, 300);
  if (!scenarios.length) return res.status(400).json({ error: 'Add at least one sample line.' });
  const proposed = sanitizeConfig(b.config);
  const model = pickEnum(MODELS, b.model, 'luna');
  const mode = pickEnum(MODES, b.mode, 'phone');
  const results = [];
  for (const line of scenarios) {
    const [cur, next] = await Promise.all([
      previewContext(supabase, { model, mode, query: line }),
      previewContext(supabase, { model, mode, query: line, config: proposed, includeDrafts: true }),
    ]);
    const [a, p] = await Promise.all([runOne(cur.block, line), runOne(next.block, line)]);
    const hits = (text) => proposed.avoid.filter((w) => w && text.toLowerCase().includes(w.toLowerCase()));
    const [sa, sp] = await Promise.all([
      a.ok ? judge(line, a.text, proposed.avoid, proposed.must) : null,
      p.ok ? judge(line, p.text, proposed.avoid, proposed.must) : null,
    ]);
    const flags = [];
    if (hits(p.text).length) flags.push('proposed reply uses a never-say phrase');
    if (sa && sp && (sp.naturalness < sa.naturalness || sp.relevance < sa.relevance || sp.compliance < sa.compliance)) flags.push('lower judge score than current');
    if (p.ok && a.ok && p.ms > a.ms * 1.5 + 300) flags.push('noticeably slower than current');
    if (!p.ok || !a.ok) flags.push('model call failed');
    results.push({ line, current: { ...a, scores: sa }, proposed: { ...p, scores: sp, avoidHits: hits(p.text) }, flags });
  }
  const regressions = results.filter((r) => r.flags.length).length;
  await audit(supabase, access, 'config.test', 'config', null, { model, mode, lines: scenarios.length, regressions });
  return res.status(200).json({ model, mode, results, regressions, note: 'Text test through Luna. Judge scores are model-graded and approximate.' });
}

// "Call Emysa" in the admin: a live call with the raw Emysa that users will get, running on the
// DRAFT config. It gets no user memory, profile or voice settings, is never billed, and gets no
// summary or push (platform 'app' calls skip those). The signed token uses its own prefix, so the
// voice service knows it is a trainer call and a normal user token can never be passed off as one.
async function trainCallStart(req, res, supabase, access) {
  const secret = process.env.ASSISTANT_BRIDGE_SECRET;
  let wsBase = (process.env.PUBLIC_ASSISTANT_WS_URL || process.env.ASSISTANT_BRIDGE_URL || '').trim();
  if (!secret) return res.status(501).json({ error: 'Live calls are not set up: ASSISTANT_BRIDGE_SECRET is missing on Vercel' });
  if (!wsBase) return res.status(501).json({ error: 'Live calls are not set up: PUBLIC_ASSISTANT_WS_URL is missing on Vercel' });
  wsBase = wsBase.replace(/^https:\/\//i, 'wss://').replace(/^http:\/\//i, 'ws://');
  if (!/^wss:\/\//i.test(wsBase) && !/^ws:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(wsBase)) {
    return res.status(501).json({ error: 'Live calls need a secure URL: set PUBLIC_ASSISTANT_WS_URL to a wss:// address' });
  }
  const engine = req.body?.engine === 'luna' ? 'luna' : 'live';
  const userId = access.user.id;
  const platformCallId = randomUUID();
  const sessionId = `call-${platformCallId}`;
  const { data: row, error } = await supabase.from('calls').insert({
    user_id: userId, platform: 'app', platform_call_id: platformCallId, to_number: 'Emysa training',
    objective: 'Training call with the Emysa team. Talk naturally; there is no task.', instructions: '',
    status: 'in_progress', answered_at: new Date().toISOString(), session_id: null, transcript: [],
  }).select('id').single();
  if (error || !row) { console.error('trainCallStart: could not create the call row:', error?.message); return res.status(500).json({ error: 'Could not start the call' }); }
  const exp = Math.floor(Date.now() / 1000) + 600;
  const sig = createHmac('sha256', secret).update(`trainercall:${sessionId}:${userId}:${exp}`).digest('hex');
  const base = wsBase.replace(/\/stream\/?$/, '').replace(/\/+$/, '');
  await audit(supabase, access, 'train_call.start', 'call', row.id, { engine });
  return res.status(200).json({
    callId: row.id, sessionId, engine, sampleRate: 16000,
    url: `${base}/app-call/${encodeURIComponent(sessionId)}?token=${encodeURIComponent(`${exp}.${userId}.${sig}`)}&engine=${engine}`,
  });
}

async function auditLog(res, supabase) {
  const { data, error } = await supabase.from('ai_audit_log').select('*').order('at', { ascending: false }).limit(100);
  if (error) throw error;
  return res.status(200).json({ entries: data || [] });
}

export const AI_ACTIONS = new Set([
  'ai-overview', 'ai-config-save', 'ai-config-publish', 'ai-config-rollback', 'ai-knowledge-list', 'ai-knowledge-save',
  'ai-knowledge-status', 'ai-knowledge-delete', 'ai-knowledge-history', 'ai-knowledge-restore', 'ai-preview', 'ai-test', 'ai-audit',
  'ai-train-call-start',
]);

export async function handleAiAction(action, req, res, supabase, access) {
  const isRead = ['ai-overview', 'ai-knowledge-list', 'ai-knowledge-history', 'ai-audit'].includes(action);
  if (!isRead && req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  try {
    switch (action) {
      case 'ai-overview': return await overview(res, supabase);
      case 'ai-config-save': return await saveConfig(req, res, supabase, access);
      case 'ai-config-publish':
      case 'ai-config-rollback': return await publishConfig(req, res, supabase, access, action);
      case 'ai-knowledge-list': return await listKnowledge(req, res, supabase);
      case 'ai-knowledge-save': return await saveKnowledge(req, res, supabase, access);
      case 'ai-knowledge-status': return await setKnowledgeStatus(req, res, supabase, access);
      case 'ai-knowledge-delete': return await deleteKnowledge(req, res, supabase, access);
      case 'ai-knowledge-history': return await knowledgeHistory(req, res, supabase);
      case 'ai-knowledge-restore': return await restoreKnowledge(req, res, supabase, access);
      case 'ai-preview': return await preview(req, res, supabase);
      case 'ai-test': return await testConfig(req, res, supabase, access);
      case 'ai-audit': return await auditLog(res, supabase);
      case 'ai-train-call-start': return await trainCallStart(req, res, supabase, access);
      default: return res.status(400).json({ error: 'Unknown action' });
    }
  } catch (err) {
    if (err?.message && /sanit|required/i.test(err.message) && !/relation|function/i.test(err.message)) return res.status(400).json({ error: err.message });
    console.error(`${action} failed:`, err?.message);
    return fail(res, err);
  }
}
