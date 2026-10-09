import { createHash, timingSafeEqual } from 'node:crypto';
import { getAuthedUserId } from './supabaseAdmin.js';
import { parseExport, parseChat, identifyContactParticipant, ExportError, MAX_EXPORT_BYTES } from './whatsappParser.js';
import {
  CONTACT_MEMORY_TYPES, REVIEW_STATUSES, buildWindows, analyzeWindows, buildChunks, embeddingsEnabled, embedTexts, toVectorLiteral,
  buildContactContext, hashText, sanitizeContactMemory,
} from './contactMemory.js';
import { resolveContactByCaller } from './contactMatch.js';

// Routed from api/memories.js with ?scope=contact&action=... (the repo is at
// Vercel Hobby's 12-function cap, so no new function file).
//
// Every query below is filtered by the signed-in user's id, and every import,
// memory and chunk row is also bound to that user's contact by composite
// foreign keys in sql/026_contact_memory.sql.

const BUCKET = 'whatsapp-imports';
const MAX_IMPORTS_PER_USER = 60;
const MEMORY_COLUMNS = 'id, contact_id, import_id, memory_type, memory_text, confidence, is_inferred, source_message, source_date, status, original_text, created_at, updated_at';
const IMPORT_COLUMNS = 'id, contact_id, original_filename, source_kind, size_bytes, status, error, participants, contact_participant, self_participant, identified_by, is_group, date_order, date_order_ambiguous, message_count, media_count, has_media, first_message_at, last_message_at, ai_consent_at, analysis_cursor, analysis_total, chunk_count, indexed_at, created_at';

const fail = (res, code, error) => res.status(code).json({ error });

// A failed query used to come back as a bare 500 with nothing logged, so the
// real cause (a missing table, a bad column) was invisible. Log it, and say so
// plainly when the memory tables are not in the database.
function dbFail(res, action, error, message) {
  console.error('contact memory db error:', action, error?.code || '', error?.message || '');
  const missing = error?.code === '42P01' || error?.code === 'PGRST205' || /does not exist|schema cache/i.test(error?.message || '');
  if (missing) return fail(res, 503, "The memory tables aren't in the database yet.");
  return fail(res, 500, message);
}
const bytesOf = async (blob) => (blob instanceof Uint8Array ? blob : new Uint8Array(await blob.arrayBuffer()));

function secretsMatch(given, env) {
  if (!given) return false;
  const valid = [env.WACALLS_INTERNAL_SECRET, env.ASSISTANT_BRIDGE_SECRET, env.RELAY_CALLBACK_SECRET].filter(Boolean);
  const a = Buffer.from(String(given));
  return valid.some((s) => { const b = Buffer.from(s); return a.length === b.length && timingSafeEqual(a, b); });
}

async function ownedImport(supabase, userId, importId) {
  if (!importId || typeof importId !== 'string') return null;
  const { data } = await supabase.from('whatsapp_imports').select('*').eq('id', importId).eq('user_id', userId).maybeSingle();
  return data || null;
}
async function ownedContact(supabase, userId, contactId) {
  if (!contactId || typeof contactId !== 'string') return null;
  const { data } = await supabase.from('contacts').select('id,name,phone_number').eq('id', contactId).eq('user_id', userId).maybeSingle();
  return data || null;
}
async function readChatMessages(supabase, row) {
  const { data, error } = await supabase.storage.from(BUCKET).download(row.chat_text_path);
  if (error || !data) throw new ExportError('The saved chat could not be read. Import it again.', 'missing');
  const text = new TextDecoder().decode(await bytesOf(data));
  return parseChat(text, { dateOrder: row.date_order });
}

export default async function handleContactMemory(req, res, { supabase, deps = {} } = {}) {
  const env = deps.env || process.env;
  const action = String(req.query?.action || '');

  // Server-to-server (the WhatsApp relay / call assistant): shared secret + explicit user id.
  let userId;
  if (action === 'contact-context' && req.headers?.['x-internal-secret']) {
    if (!secretsMatch(req.headers['x-internal-secret'], env)) return fail(res, 401, 'Not authorised');
    userId = String(req.query?.userId || '');
    if (!userId) return fail(res, 400, 'userId required');
  } else {
    try { userId = deps.userId !== undefined ? deps.userId : await getAuthedUserId(req, supabase); } catch (err) { console.error('contact memory auth error:', err.message); return fail(res, 503, 'Could not check your sign-in. Try again.'); }
    if (!userId) return fail(res, 401, 'Not signed in');
  }
  const body = req.body && typeof req.body === 'object' ? req.body : {};

  try {
    switch (action) {
      case 'import-init': return await importInit(req, res, supabase, userId, body, env);
      case 'import-process': return await importProcess(req, res, supabase, userId, body);
      case 'import-set-participants': return await importSetParticipants(req, res, supabase, userId, body);
      case 'import-analyze': return await importAnalyze(req, res, supabase, userId, body, deps, env);
      case 'import-index': return await importIndex(req, res, supabase, userId, body, deps, env);
      case 'import-list': return await importList(req, res, supabase, userId);
      case 'import-delete': return await importDelete(req, res, supabase, userId, body);
      case 'cm-list': return await memoryList(req, res, supabase, userId);
      case 'cm-update': return await memoryUpdate(req, res, supabase, userId, body);
      case 'cm-delete': return await memoryDelete(req, res, supabase, userId, body);
      case 'contact-context': return await contactContext(req, res, supabase, userId, deps, env);
      default: return fail(res, 404, 'Unknown action');
    }
  } catch (err) {
    if (err instanceof ExportError) return fail(res, 422, err.message);
    console.error('contact memory error:', action, err.message);
    return fail(res, 500, 'Something went wrong. Try again.');
  }
}

// ---------- imports ----------

async function importInit(req, res, supabase, userId, body, env) {
  if (req.method !== 'POST') return fail(res, 405, 'POST only');
  const contact = await ownedContact(supabase, userId, body.contactId);
  if (!contact) return fail(res, 404, 'Contact not found');
  const filename = String(body.filename || '').replace(/[^\w .()\-\u00C0-\uFFFF]/g, '_').slice(0, 150) || 'chat';
  const kind = /\.zip$/i.test(filename) ? 'zip' : /\.txt$/i.test(filename) ? 'txt' : null;
  if (!kind) return fail(res, 400, 'Choose the .txt or .zip file from WhatsApp "Export chat".');
  const size = Number(body.size);
  if (!Number.isFinite(size) || size <= 0) return fail(res, 400, 'File size is missing.');
  if (size > MAX_EXPORT_BYTES) return fail(res, 413, 'That file is larger than 50 MB. Export the chat again "Without media".');
  const { data: existing } = await supabase.from('whatsapp_imports').select('id').eq('user_id', userId).limit(MAX_IMPORTS_PER_USER + 1);
  if ((existing || []).length > MAX_IMPORTS_PER_USER) return fail(res, 429, 'Too many imports. Delete some old ones first.');

  const { data: row, error } = await supabase.from('whatsapp_imports').insert({
    user_id: userId, contact_id: contact.id, original_filename: filename, source_kind: kind, size_bytes: size, status: 'uploading',
  }).select().single();
  if (error || !row) return fail(res, 500, 'Could not start the import.');
  const path = `${userId}/${row.id}/original.${kind}`;
  const signed = await supabase.storage.from(BUCKET).createSignedUploadUrl(path);
  if (signed.error || !signed.data) {
    await supabase.from('whatsapp_imports').delete().eq('id', row.id).eq('user_id', userId);
    return fail(res, 500, 'Could not prepare the upload.');
  }
  await supabase.from('whatsapp_imports').update({ storage_path: path }).eq('id', row.id).eq('user_id', userId);
  return res.status(200).json({ importId: row.id, bucket: BUCKET, path, token: signed.data.token, signedUrl: signed.data.signedUrl });
}

async function importProcess(req, res, supabase, userId, body) {
  if (req.method !== 'POST') return fail(res, 405, 'POST only');
  const row = await ownedImport(supabase, userId, body.importId);
  if (!row) return fail(res, 404, 'Import not found');
  if (!row.storage_path) return fail(res, 400, 'Nothing was uploaded for this import.');
  const contact = await ownedContact(supabase, userId, row.contact_id);
  if (!contact) return fail(res, 404, 'Contact not found');

  const { data: blob, error: dlError } = await supabase.storage.from(BUCKET).download(row.storage_path);
  if (dlError || !blob) return fail(res, 400, 'The upload did not arrive. Try again.');
  const bytes = await bytesOf(blob);
  const sha256 = createHash('sha256').update(bytes).digest('hex');

  const { data: dup } = await supabase.from('whatsapp_imports').select('id').eq('user_id', userId).eq('contact_id', row.contact_id).eq('sha256', sha256).limit(2);
  if ((dup || []).some((d) => d.id !== row.id)) {
    await removeImportFiles(supabase, row);
    await supabase.from('whatsapp_imports').delete().eq('id', row.id).eq('user_id', userId);
    return fail(res, 409, 'This exact export was already imported for this contact.');
  }

  let parsed;
  try {
    parsed = parseExport(bytes, { filename: row.original_filename, dateOrder: ['dmy', 'mdy', 'ymd'].includes(body.dateOrder) ? body.dateOrder : null });
  } catch (err) {
    if (err instanceof ExportError) {
      await supabase.from('whatsapp_imports').update({ status: 'failed', error: err.message, sha256 }).eq('id', row.id).eq('user_id', userId);
      return fail(res, 422, err.message);
    }
    throw err;
  }

  const chatPath = `${userId}/${row.id}/chat.txt`;
  const up = await supabase.storage.from(BUCKET).upload(chatPath, new TextEncoder().encode(parsed.chatText), { contentType: 'text/plain', upsert: true });
  if (up.error) return fail(res, 500, 'Could not save the chat text.');

  const { data: profile } = await supabase.from('profiles').select('name').eq('user_id', userId).maybeSingle();
  const found = identifyContactParticipant(parsed.participants, contact, { selfName: profile?.name || '' });
  const participants = parsed.participants.map((p) => ({ name: p.name, messages: p.messages, phone: p.phone, firstAt: p.firstAt, lastAt: p.lastAt }));
  const update = {
    sha256, chat_text_path: chatPath, status: 'parsed', error: null, participants,
    contact_participant: found?.contactParticipant || null, self_participant: found?.selfParticipant || null, identified_by: found?.method || null,
    is_group: parsed.isGroup, date_order: parsed.dateOrder, date_order_ambiguous: parsed.dateOrderAmbiguous,
    message_count: parsed.messages.length, media_count: parsed.source.mediaCount || parsed.stats.media, has_media: parsed.source.hasMedia,
    first_message_at: parsed.firstMessageAt, last_message_at: parsed.lastMessageAt,
    analysis_cursor: 0, analysis_total: 0,
  };
  await supabase.from('whatsapp_imports').update(update).eq('id', row.id).eq('user_id', userId);

  return res.status(200).json({
    importId: row.id, status: 'parsed', kind: parsed.source.kind, messageCount: parsed.messages.length, mediaCount: update.media_count, hasMedia: update.has_media,
    participants, isGroup: parsed.isGroup, dateOrder: parsed.dateOrder, dateOrderAmbiguous: parsed.dateOrderAmbiguous,
    identified: found ? { contactParticipant: found.contactParticipant, selfParticipant: found.selfParticipant, method: found.method } : null,
    firstMessageAt: parsed.firstMessageAt, lastMessageAt: parsed.lastMessageAt,
    preview: parsed.messages.filter((m) => m.kind === 'text').slice(0, 3).map((m) => ({ sentAt: m.sentAt, sender: m.sender, text: m.text.slice(0, 80) })),
  });
}

async function importSetParticipants(req, res, supabase, userId, body) {
  if (req.method !== 'POST') return fail(res, 405, 'POST only');
  const row = await ownedImport(supabase, userId, body.importId);
  if (!row) return fail(res, 404, 'Import not found');
  const names = (row.participants || []).map((p) => p.name);
  if (!names.includes(body.contactParticipant)) return fail(res, 400, 'Choose one of the people in this chat.');
  const self = body.selfParticipant || null;
  if (self && (!names.includes(self) || self === body.contactParticipant)) return fail(res, 400, 'Choose yourself from the other people in this chat.');
  await supabase.from('whatsapp_imports').update({ contact_participant: body.contactParticipant, self_participant: self, identified_by: 'user' }).eq('id', row.id).eq('user_id', userId);
  return res.status(200).json({ ok: true });
}

async function importAnalyze(req, res, supabase, userId, body, deps, env) {
  if (req.method !== 'POST') return fail(res, 405, 'POST only');
  const row = await ownedImport(supabase, userId, body.importId);
  if (!row) return fail(res, 404, 'Import not found');
  if (!['parsed', 'analyzing', 'analyzed'].includes(row.status) || !row.chat_text_path) return fail(res, 400, 'Process the import first.');
  if (!row.contact_participant) return fail(res, 400, 'Choose which person in the chat is this contact first.');
  if (body.consent !== true && !row.ai_consent_at) return fail(res, 400, 'Confirm that the chat text may be analysed by the AI provider.');
  const contact = await ownedContact(supabase, userId, row.contact_id);
  if (!contact) return fail(res, 404, 'Contact not found');
  if (body.consent === true && !row.ai_consent_at) {
    await supabase.from('whatsapp_imports').update({ ai_consent_at: new Date().toISOString() }).eq('id', row.id).eq('user_id', userId);
  }

  const chat = await readChatMessages(supabase, row);
  const who = { contactParticipant: row.contact_participant, selfParticipant: row.self_participant };
  const windows = buildWindows(chat.messages, who);
  // Starting over (or the first run) resets the cursor; "analyze more" continues it.
  const cursor = body.restart ? 0 : row.analysis_cursor || 0;
  const maxWindows = Math.min(Number(deps.maxWindows) || Number(env.CONTACT_MEMORY_MAX_WINDOWS) || 12, 30);
  const result = await analyzeWindows(windows, who, { cursor, maxWindows, contactName: contact.name, extract: deps.extract, env });

  // Anything already proposed, approved, edited (including the extractor's original wording) or rejected is known and never proposed again.
  const { data: existing } = await supabase.from('contact_memories').select('memory_text, original_text').eq('user_id', userId).eq('contact_id', row.contact_id).limit(5000);
  const known = new Set((existing || []).flatMap((m) => [m.memory_text, m.original_text].filter(Boolean).map(hashText)));
  const fresh = result.candidates.filter((c) => !known.has(hashText(c.memory_text)));
  const rows = fresh.map((c) => ({
    user_id: userId, contact_id: row.contact_id, import_id: row.id, memory_type: c.memory_type, memory_text: c.memory_text, confidence: c.confidence,
    is_inferred: c.is_inferred, source_message: c.source_message, source_message_index: c.source_message_index, source_date: c.source_date,
    status: 'candidate', original_text: c.original_text,
  }));
  let inserted = 0;
  for (let i = 0; i < rows.length; i += 50) {
    const batch = rows.slice(i, i + 50);
    const { error } = await supabase.from('contact_memories').insert(batch);
    if (!error) { inserted += batch.length; continue; }
    for (const single of batch) { // a unique-text race: keep what can be kept
      const one = await supabase.from('contact_memories').insert(single);
      if (!one.error) inserted += 1;
    }
  }
  await supabase.from('whatsapp_imports').update({
    analysis_cursor: result.nextCursor, analysis_total: result.total, status: result.done ? 'analyzed' : 'analyzing',
  }).eq('id', row.id).eq('user_id', userId);
  return res.status(200).json({
    inserted, duplicates: result.candidates.length - fresh.length, processedWindows: result.processed, failedWindows: result.failed,
    totalWindows: result.total, remainingWindows: Math.max(0, result.total - result.nextCursor), done: result.done, method: result.method,
  });
}

async function importIndex(req, res, supabase, userId, body, deps, env) {
  if (req.method !== 'POST') return fail(res, 405, 'POST only');
  const row = await ownedImport(supabase, userId, body.importId);
  if (!row || !row.chat_text_path) return fail(res, 404, 'Import not found');
  const chat = await readChatMessages(supabase, row);
  const chunks = buildChunks(chat.messages);
  await supabase.from('whatsapp_import_chunks').delete().eq('import_id', row.id).eq('user_id', userId);

  // Embeddings send text to a second provider, so they need the same consent as analysis.
  const wantEmbeddings = embeddingsEnabled(env) && (body.consent === true || Boolean(row.ai_consent_at));
  let vectors = null;
  let embedded = false;
  if (wantEmbeddings) {
    try { vectors = await (deps.embed || embedTexts)(chunks.map((c) => c.content), { env, fetchImpl: deps.fetchImpl }); embedded = true; }
    catch (err) { console.error('embedding failed, keyword index only:', err.message); }
  }
  const rows = chunks.map((c, i) => ({
    user_id: userId, contact_id: row.contact_id, import_id: row.id, ...c,
    ...(vectors ? { embedding: toVectorLiteral(vectors[i]) } : {}),
  }));
  for (let i = 0; i < rows.length; i += 100) {
    const { error } = await supabase.from('whatsapp_import_chunks').insert(rows.slice(i, i + 100));
    if (error) return fail(res, 500, 'Could not save the conversation index.');
  }
  await supabase.from('whatsapp_imports').update({ chunk_count: rows.length, indexed_at: new Date().toISOString() }).eq('id', row.id).eq('user_id', userId);
  return res.status(200).json({ chunks: rows.length, embedded, embeddingsAvailable: embeddingsEnabled(env) });
}

async function importList(req, res, supabase, userId) {
  const contactId = String(req.query?.contactId || '');
  if (!contactId) return fail(res, 400, 'contactId required');
  const { data, error } = await supabase.from('whatsapp_imports').select(IMPORT_COLUMNS).eq('user_id', userId).eq('contact_id', contactId).order('created_at', { ascending: false }).limit(60);
  if (error) return dbFail(res, 'import-list', error, 'Could not load imports.');
  return res.status(200).json({ imports: data || [] });
}

async function removeImportFiles(supabase, row) {
  const paths = [row.storage_path, row.chat_text_path].filter(Boolean);
  if (paths.length) await supabase.storage.from(BUCKET).remove(paths);
}

async function importDelete(req, res, supabase, userId, body) {
  if (req.method !== 'DELETE' && req.method !== 'POST') return fail(res, 405, 'DELETE only');
  const row = await ownedImport(supabase, userId, body.importId);
  if (!row) return fail(res, 404, 'Import not found');
  await removeImportFiles(supabase, row);
  if (body.deleteMemories === true) await supabase.from('contact_memories').delete().eq('user_id', userId).eq('import_id', row.id);
  await supabase.from('whatsapp_imports').delete().eq('id', row.id).eq('user_id', userId);
  return res.status(200).json({ ok: true });
}

// ---------- review ----------

async function memoryList(req, res, supabase, userId) {
  const contactId = String(req.query?.contactId || '');
  if (!contactId) return fail(res, 400, 'contactId required');
  const status = req.query?.status ? String(req.query.status) : null;
  if (status && !REVIEW_STATUSES.includes(status)) return fail(res, 400, 'Unknown status');
  let q = supabase.from('contact_memories').select(MEMORY_COLUMNS).eq('user_id', userId).eq('contact_id', contactId);
  if (status) q = q.eq('status', status);
  const { data, error } = await q.order('created_at', { ascending: false }).limit(500);
  if (error) return dbFail(res, 'cm-list', error, 'Could not load memories.');
  return res.status(200).json({ memories: data || [] });
}

async function memoryUpdate(req, res, supabase, userId, body) {
  if (req.method !== 'PATCH' && req.method !== 'POST') return fail(res, 405, 'PATCH only');
  const { data: row } = await supabase.from('contact_memories').select('*').eq('id', String(body.id || '')).eq('user_id', userId).maybeSingle();
  if (!row) return fail(res, 404, 'Memory not found');
  const patch = { reviewed_at: new Date().toISOString() };
  if (body.memoryType !== undefined) {
    if (!CONTACT_MEMORY_TYPES.includes(body.memoryType)) return fail(res, 400, 'Unknown memory type');
    patch.memory_type = body.memoryType;
  }
  if (body.status !== undefined && !REVIEW_STATUSES.includes(body.status)) return fail(res, 400, 'Unknown status');
  if (body.memoryText !== undefined) {
    const text = sanitizeContactMemory(body.memoryText);
    if (!text || text.length < 3 || text.length > 300) return fail(res, 400, 'Memory text must be 3-300 characters and must not contain passwords, codes or card numbers.');
    patch.memory_text = text;
    patch.is_inferred = false; // the user's own wording
    // Editing approves it ("edited"), unless the same request sends it back to candidate/rejected.
    patch.status = body.status === 'rejected' || body.status === 'candidate' ? body.status : 'edited';
  } else if (body.status !== undefined) {
    patch.status = body.status;
  }
  const { data, error } = await supabase.from('contact_memories').update(patch).eq('id', row.id).eq('user_id', userId).select(MEMORY_COLUMNS).single();
  if (error) return fail(res, error.code === '23505' ? 409 : 500, error.code === '23505' ? 'You already have a memory with that text.' : 'Could not update the memory.');
  return res.status(200).json({ memory: data });
}

async function memoryDelete(req, res, supabase, userId, body) {
  if (req.method !== 'DELETE' && req.method !== 'POST') return fail(res, 405, 'DELETE only');
  const { data: row } = await supabase.from('contact_memories').select('id').eq('id', String(body.id || '')).eq('user_id', userId).maybeSingle();
  if (!row) return fail(res, 404, 'Memory not found');
  await supabase.from('contact_memories').delete().eq('id', row.id).eq('user_id', userId);
  return res.status(200).json({ ok: true });
}

// ---------- call-time lookup ----------

// ?contactId=...  (the app previewing a contact)  or  ?caller=<jid or number>
// (a WhatsApp call arriving). Returns only approved/edited memories and a few
// short retrieved snippets, never the conversation.
async function contactContext(req, res, supabase, userId, deps, env) {
  let contact = null;
  let match = null;
  if (req.query?.contactId) {
    contact = await ownedContact(supabase, userId, String(req.query.contactId));
    if (!contact) return fail(res, 404, 'Contact not found');
    match = { status: 'matched' };
  } else if (req.query?.caller) {
    match = await resolveContactByCaller(supabase, userId, String(req.query.caller));
    contact = match.contact;
  } else return fail(res, 400, 'contactId or caller required');

  if (!contact) return res.status(200).json({ match: { status: match.status }, promptBlock: '', memories: [], snippets: [] });
  const ctx = await buildContactContext(supabase, { userId, contactId: contact.id, contactName: contact.name, query: String(req.query?.query || ''), env, fetchImpl: deps.fetchImpl });
  return res.status(200).json({
    match: { status: 'matched', contactId: contact.id, contactName: contact.name },
    promptBlock: ctx.promptBlock,
    memories: ctx.memories.map((m) => ({ id: m.id, type: m.memory_type, text: m.memory_text })),
    snippets: ctx.snippets.map((s) => ({ date: s.date, content: s.content })),
  });
}
