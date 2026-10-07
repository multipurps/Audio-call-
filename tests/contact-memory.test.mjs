import test from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';
import { database } from './helpers.mjs';
import handler from '../lib/contactMemoryApi.js';
import {
  buildWindows, validateExtraction, extractWithRules, analyzeWindows, buildChunks, buildPromptBlock, loadApprovedMemories, embedTexts,
} from '../lib/contactMemory.js';
import { parseChat } from '../lib/whatsappParser.js';
import { containsImportSecret, sanitizeContactMemory } from '../lib/contactMemory.js';

const A = 'user-a';
const B = 'user-b';
const NUMBER = '+2348012345678';

const CHAT = [
  '12/03/2024, 14:05 - Marilyn: Hi Zee, it is Lyn. Please call me Lyn from now on',
  '12/03/2024, 14:06 - Zee: Sure Lyn',
  '13/03/2024, 09:00 - Marilyn: my birthday is on 5 May',
  '13/03/2024, 09:01 - Marilyn: I really love pottery and I prefer voice notes',
  '14/03/2024, 18:00 - Marilyn: please don\'t call me before 10am',
  '14/03/2024, 18:02 - Marilyn: your code is 482913, do not share',
  '15/03/2024, 12:00 - Zee: I will bring the deposit on Friday',
  '16/03/2024, 12:00 - Marilyn: I\'ll send the form tomorrow',
  '16/03/2024, 12:05 - Marilyn: lol ok',
].join('\n');

// ---- test doubles ----------------------------------------------------------

function world(seed = {}) {
  const db = database({
    contacts: [
      { id: 'ca', user_id: A, name: 'Marilyn', phone_number: NUMBER },
      { id: 'cb', user_id: B, name: 'Somebody', phone_number: NUMBER },
    ],
    profiles: [{ user_id: A, name: 'Zee' }, { user_id: B, name: 'Bee' }],
    whatsapp_imports: [], contact_memories: [], whatsapp_import_chunks: [],
    ...seed,
  });
  const files = new Map();
  const supabase = {
    from: (t) => db.from(t),
    rpc: async (name, args) => {
      if (name !== 'search_contact_history') return { data: [] };
      const rows = db.tables.whatsapp_import_chunks.filter((c) => c.user_id === args.p_user_id && c.contact_id === args.p_contact_id && c.content.toLowerCase().includes(args.p_query.toLowerCase()));
      return { data: rows.map((c) => ({ chunk_id: c.id, started_at: c.started_at, content: c.content, rank: 0.5 })) };
    },
    storage: { from: () => ({
      createSignedUploadUrl: async (path) => ({ data: { token: 't', signedUrl: `https://storage.test/${path}`, path } }),
      download: async (path) => (files.has(path) ? { data: new Blob([files.get(path)]) } : { data: null, error: { message: 'nope' } }),
      upload: async (path, bytes) => { files.set(path, bytes); return {}; },
      remove: async (paths) => { for (const p of paths) files.delete(p); return {}; },
    }) },
  };
  return { db, files, supabase };
}

function call(w, userId, { action, method = 'POST', body = {}, query = {}, headers = {}, deps = {} }) {
  const res = { code: 200, data: null, status(c) { this.code = c; return this; }, json(d) { this.data = d; return this; } };
  const req = { method, query: { scope: 'contact', action, ...query }, body, headers };
  return handler(req, res, { supabase: w.supabase, deps: { userId, env: { ...deps.env }, ...deps } }).then(() => res);
}

const fakeExtract = async (window) => window
  .filter((m) => /birthday|voice notes|call me before/.test(m.text))
  .map((m) => {
    const text = /birthday/.test(m.text) ? 'Birthday is on 5 May' : /voice/.test(m.text) ? 'Prefers voice notes' : 'Does not want calls before 10am';
    return {
      memory_type: /birthday/.test(m.text) ? 'important_dates' : /voice/.test(m.text) ? 'preferences' : 'caller_preferences',
      memory_text: text, confidence: 0.8, is_inferred: false, source_message: m.text, source_message_index: m.index, source_date: m.sentAt, status: 'candidate', original_text: text,
    };
  });

// Uploads a zip export the way the app does, then processes it.
async function importChat(w, userId = A, contactId = 'ca', text = CHAT, { withMedia = true } = {}) {
  const init = await call(w, userId, { action: 'import-init', body: { contactId, filename: 'WhatsApp Chat - Marilyn.zip', size: 1234 } });
  assert.equal(init.code, 200, JSON.stringify(init.data));
  const entries = { '_chat.txt': strToU8(text) };
  if (withMedia) entries['00000001-PHOTO.jpg'] = new Uint8Array(500).fill(3);
  w.files.set(init.data.path, zipSync(entries));
  const processed = await call(w, userId, { action: 'import-process', body: { importId: init.data.importId } });
  return { init, processed };
}

// ---- extraction safety -----------------------------------------------------

const who = { contactParticipant: 'Marilyn', selfParticipant: 'Zee' };
const chat = parseChat(CHAT);

test('windows: newest first, contact and user only, no media or other members', () => {
  const group = parseChat('12/03/2024, 14:05 - Marilyn: one is here\n12/03/2024, 14:06 - Stranger: not analysed\n12/03/2024, 14:07 - Zee: two is here\n12/03/2024, 14:08 - Marilyn: <Media omitted>');
  const windows = buildWindows(group.messages, who);
  assert.equal(windows.length, 1);
  assert.deepEqual(windows[0].map((m) => m.sender), ['Marilyn', 'Zee']);
  const many = parseChat(Array.from({ length: 300 }, (_, i) => `12/03/2024, 14:00 - ${i % 2 ? 'Zee' : 'Marilyn'}: message number ${i} padded padded padded`).join('\n'));
  const w = buildWindows(many.messages, who, { maxMessages: 50 });
  assert.equal(w.length, 6);
  assert.ok(w[0][0].index > w[5][0].index, 'newest window first');
});

test('LLM output is never trusted: uncited, fabricated, secret, unknown-type and low-confidence items are dropped', () => {
  const window = chat.messages;
  const idx = (needle) => window.find((m) => m.text.includes(needle)).index;
  const out = validateExtraction(JSON.stringify({ memories: [
    { type: 'important_dates', text: 'Birthday is on 5 May', source_index: idx('birthday'), confidence: 0.9, inferred: false },
    { type: 'identity', text: 'Is a millionaire', source_index: 9999, confidence: 0.9 },                    // cites nothing real
    { type: 'identity', text: 'Has a secret code 482913', source_index: idx('your code'), confidence: 0.9 }, // secret source
    { type: 'astrology', text: 'Is a Taurus person', source_index: idx('birthday'), confidence: 0.9 },       // unknown type
    { type: 'preferences', text: 'Likes something', source_index: idx('birthday'), confidence: 0.1 },         // too unsure
    { type: 'preferences', text: 'Birthday is on 5 May', source_index: idx('birthday'), confidence: 0.9 },   // duplicate
    { type: 'identity', text: 'password is hunter2', source_index: idx('birthday'), confidence: 0.9 },        // secret text
    { text: 'no type', source_index: idx('birthday') },
    null, 'garbage',
  ] }), window, who);
  assert.equal(out.length, 1);
  assert.equal(out[0].memory_text, 'Birthday is on 5 May');
  assert.equal(out[0].status, 'candidate');
  assert.equal(out[0].source_message, 'my birthday is on 5 May', 'the quote is copied from the export, not from the model');
  assert.equal(out[0].source_date, '2024-03-13T09:00:00.000Z');
});

test('inference is marked: things the contact did not say themselves, or that lack support, are flagged and capped', () => {
  const idx = (needle) => chat.messages.find((m) => m.text.includes(needle)).index;
  const out = validateExtraction({ memories: [
    { type: 'commitments', text: 'Will bring the deposit on Friday', source_index: idx('deposit'), confidence: 0.95, inferred: false }, // said by the USER
    { type: 'identity', text: 'Works as a ceramics teacher', source_index: idx('pottery'), confidence: 0.9, inferred: false },          // not supported by the message
    { type: 'preferences', text: 'Loves pottery and prefers voice notes', source_index: idx('pottery'), confidence: 0.9, inferred: false },
  ] }, chat.messages, who);
  const byText = Object.fromEntries(out.map((m) => [m.memory_text, m]));
  assert.equal(byText['Will bring the deposit on Friday'].is_inferred, true);
  assert.ok(byText['Will bring the deposit on Friday'].confidence <= 0.6);
  assert.equal(byText['Works as a ceramics teacher'].is_inferred, true);
  assert.ok(byText['Works as a ceramics teacher'].confidence <= 0.5);
  assert.equal(byText['Loves pottery and prefers voice notes'].is_inferred, false);
});

test('model replies wrapped in code fences or prose still parse; broken JSON yields nothing', () => {
  const idx = chat.messages.find((m) => m.text.includes('birthday')).index;
  const good = '```json\n' + JSON.stringify({ memories: [{ type: 'important_dates', text: 'Birthday is on 5 May', source_index: idx, confidence: 0.9, inferred: false }] }) + '\n```';
  assert.equal(validateExtraction(good, chat.messages, who).length, 1);
  assert.equal(validateExtraction('Sure! here you go: not json', chat.messages, who).length, 0);
});

test('rule-based fallback: only the contact\'s own words, never secrets, always candidate', () => {
  const found = extractWithRules(chat.messages, who);
  const texts = found.map((m) => m.memory_text);
  assert.ok(texts.includes('Birthday: 5 May'));
  assert.ok(texts.includes('Prefers to be called Lyn'));
  assert.ok(texts.includes('Does not want calls before 10am'));
  assert.ok(!texts.some((t) => /deposit/.test(t)), 'the USER\'s own promise is not attributed to the contact');
  assert.ok(!texts.some((t) => /482913/.test(t)));
  assert.ok(found.every((m) => m.status === 'candidate'));
});

test('analysis is resumable and bounded, and one failing window does not stop the run', async () => {
  const many = parseChat(Array.from({ length: 400 }, (_, i) => `12/03/2024, 14:00 - ${i % 2 ? 'Zee' : 'Marilyn'}: message number ${i} with some padding words`).join('\n'));
  const windows = buildWindows(many.messages, who, { maxMessages: 50 });
  let calls = 0;
  const extract = async () => { calls += 1; if (calls === 2) throw new Error('model down'); return []; };
  const r1 = await analyzeWindows(windows, who, { cursor: 0, maxWindows: 3, extract });
  assert.deepEqual([r1.processed, r1.failed, r1.nextCursor, r1.done], [3, 1, 3, false]);
  const r2 = await analyzeWindows(windows, who, { cursor: r1.nextCursor, maxWindows: 30, extract });
  assert.equal(r2.done, true);
  assert.equal(r2.total, windows.length);
});

// ---- the import -> review -> call flow ------------------------------------

test('import a zip WITH media: stored, parsed, contact identified by phone number', async () => {
  const w = world({ contacts: [
    { id: 'ca', user_id: A, name: 'Aunt M', phone_number: NUMBER },
    { id: 'cb', user_id: B, name: 'Somebody', phone_number: NUMBER },
  ] });
  const text = CHAT.replaceAll('Marilyn:', '+234 801 234 5678:').replaceAll('- Marilyn', '- +234 801 234 5678');
  const { processed } = await importChat(w, A, 'ca', text);
  assert.equal(processed.code, 200, JSON.stringify(processed.data));
  assert.equal(processed.data.mediaCount, 1);
  assert.equal(processed.data.hasMedia, true);
  assert.deepEqual(processed.data.identified, { contactParticipant: '+234 801 234 5678', selfParticipant: 'Zee', method: 'phone' });
  assert.equal(w.db.tables.whatsapp_imports[0].status, 'parsed');
  // original export kept as the source reference, plus the extracted chat text
  assert.ok([...w.files.keys()].some((p) => p.endsWith('/original.zip')));
  assert.ok([...w.files.keys()].some((p) => p.endsWith('/chat.txt')));
});

test('import a plain txt WITHOUT media and a zip without media', async () => {
  const w = world();
  const init = await call(w, A, { action: 'import-init', body: { contactId: 'ca', filename: 'chat.txt', size: 10 } });
  w.files.set(init.data.path, strToU8(CHAT));
  const txt = await call(w, A, { action: 'import-process', body: { importId: init.data.importId } });
  assert.equal(txt.data.kind, 'txt');
  assert.equal(txt.data.mediaCount, 0);
  const { processed } = await importChat(world(), A, 'ca', CHAT, { withMedia: false });
  assert.equal(processed.data.kind, 'zip');
  assert.equal(processed.data.mediaCount, 0);
});

test('bad uploads: wrong file type, huge file, not-a-chat, duplicate export', async () => {
  const w = world();
  assert.equal((await call(w, A, { action: 'import-init', body: { contactId: 'ca', filename: 'photo.jpg', size: 10 } })).code, 400);
  assert.equal((await call(w, A, { action: 'import-init', body: { contactId: 'ca', filename: 'chat.zip', size: 51 * 1024 * 1024 } })).code, 413);
  const init = await call(w, A, { action: 'import-init', body: { contactId: 'ca', filename: 'chat.txt', size: 10 } });
  w.files.set(init.data.path, strToU8('just a shopping list'));
  const bad = await call(w, A, { action: 'import-process', body: { importId: init.data.importId } });
  assert.equal(bad.code, 422);
  assert.equal(w.db.tables.whatsapp_imports.find((r) => r.id === init.data.importId).status, 'failed');
  const first = await importChat(w);
  assert.equal(first.processed.code, 200);
  const second = await importChat(w);
  assert.equal(second.processed.code, 409);
});

test('analysis needs consent and a chosen contact; unidentified chats ask the user', async () => {
  const w = world({ contacts: [{ id: 'ca', user_id: A, name: 'Aunt M', phone_number: '+15550001111' }], profiles: [{ user_id: A, name: 'Someone Else' }] });
  const { processed } = await importChat(w);
  assert.equal(processed.data.identified, null); // names and numbers do not match: no guessing
  const id = processed.data.importId;
  assert.equal((await call(w, A, { action: 'import-analyze', body: { importId: id, consent: true }, deps: { extract: fakeExtract } })).code, 400);
  assert.equal((await call(w, A, { action: 'import-set-participants', body: { importId: id, contactParticipant: 'Nobody' } })).code, 400);
  assert.equal((await call(w, A, { action: 'import-set-participants', body: { importId: id, contactParticipant: 'Marilyn', selfParticipant: 'Marilyn' } })).code, 400);
  assert.equal((await call(w, A, { action: 'import-set-participants', body: { importId: id, contactParticipant: 'Marilyn', selfParticipant: 'Zee' } })).code, 200);
  assert.equal((await call(w, A, { action: 'import-analyze', body: { importId: id }, deps: { extract: fakeExtract } })).code, 400, 'no consent');
  const ok = await call(w, A, { action: 'import-analyze', body: { importId: id, consent: true }, deps: { extract: fakeExtract } });
  assert.equal(ok.code, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.inserted, 3);
  assert.ok(w.db.tables.whatsapp_imports[0].ai_consent_at);
});

async function analyzed(w) {
  const { processed } = await importChat(w);
  const id = processed.data.importId;
  await call(w, A, { action: 'import-set-participants', body: { importId: id, contactParticipant: 'Marilyn', selfParticipant: 'Zee' } });
  await call(w, A, { action: 'import-analyze', body: { importId: id, consent: true }, deps: { extract: fakeExtract } });
  return id;
}

test('extracted memories are candidates only, carry source and are never used on a call until approved', async () => {
  const w = world();
  await analyzed(w);
  const rows = w.db.tables.contact_memories;
  assert.equal(rows.length, 3);
  assert.ok(rows.every((r) => r.status === 'candidate' && r.contact_id === 'ca' && r.user_id === A && r.source_message && r.source_date));
  const ctx = await call(w, A, { action: 'contact-context', method: 'GET', query: { contactId: 'ca' } });
  assert.equal(ctx.data.promptBlock, '');
  assert.deepEqual(ctx.data.memories, []);
});

test('review: approve, edit, reject, delete; edits are sanitised; a re-run never resurfaces rejected items', async () => {
  const w = world();
  const importId = await analyzed(w);
  const [m1, m2, m3] = w.db.tables.contact_memories;
  assert.equal((await call(w, A, { action: 'cm-update', method: 'PATCH', body: { id: m1.id, status: 'approved' } })).data.memory.status, 'approved');
  const edited = await call(w, A, { action: 'cm-update', method: 'PATCH', body: { id: m2.id, memoryText: 'Likes voice notes and pottery' } });
  assert.equal(edited.data.memory.status, 'edited');
  assert.equal(edited.data.memory.is_inferred, false);
  assert.equal(edited.data.memory.original_text, 'Prefers voice notes', 'what the extractor wrote is kept');
  assert.equal((await call(w, A, { action: 'cm-update', method: 'PATCH', body: { id: m3.id, status: 'rejected' } })).data.memory.status, 'rejected');
  assert.equal((await call(w, A, { action: 'cm-update', method: 'PATCH', body: { id: m1.id, memoryText: 'the code is 482913 password hunter2' } })).code, 400);
  assert.equal((await call(w, A, { action: 'cm-update', method: 'PATCH', body: { id: m1.id, memoryType: 'astrology' } })).code, 400);
  assert.equal((await call(w, A, { action: 'cm-update', method: 'PATCH', body: { id: m1.id, status: 'maybe' } })).code, 400);
  // analysing again must not bring back the rejected one, nor duplicate the others
  const again = await call(w, A, { action: 'import-analyze', body: { importId, consent: true, restart: true }, deps: { extract: fakeExtract } });
  assert.equal(again.data.inserted, 0);
  assert.equal(w.db.tables.contact_memories.length, 3);
  assert.equal((await call(w, A, { action: 'cm-delete', method: 'DELETE', body: { id: m3.id } })).code, 200);
  assert.equal(w.db.tables.contact_memories.length, 2);
  const list = await call(w, A, { action: 'cm-list', method: 'GET', query: { contactId: 'ca', status: 'approved' } });
  assert.deepEqual(list.data.memories.map((m) => m.id), [m1.id]);
});

test('call context holds ONLY approved/edited memories and never the raw conversation', async () => {
  const w = world();
  await analyzed(w);
  const [m1, m2, m3] = w.db.tables.contact_memories;
  await call(w, A, { action: 'cm-update', method: 'PATCH', body: { id: m1.id, status: 'approved' } });
  await call(w, A, { action: 'cm-update', method: 'PATCH', body: { id: m2.id, memoryText: 'Likes voice notes and pottery' } });
  // m3 stays a candidate
  const ctx = await call(w, A, { action: 'contact-context', method: 'GET', query: { contactId: 'ca' } });
  assert.equal(ctx.data.memories.length, 2);
  assert.match(ctx.data.promptBlock, /Likes voice notes and pottery/);
  assert.doesNotMatch(ctx.data.promptBlock, /call me before|Does not want calls/, 'candidate is excluded');
  for (const raw of ['Please call me Lyn', 'your code is', 'lol ok', 'I will bring the deposit', 'my birthday is on 5 May']) {
    assert.ok(!ctx.data.promptBlock.includes(raw), `raw message leaked: ${raw}`);
  }
});

test('a huge conversation never grows the call prompt', async () => {
  const lines = Array.from({ length: 5000 }, (_, i) => `12/03/2024, 14:00 - ${i % 2 ? 'Zee' : 'Marilyn'}: chatter number ${i} about nothing in particular`);
  const w = world();
  const { processed } = await importChat(w, A, 'ca', lines.join('\n'));
  assert.equal(processed.data.messageCount, 5000);
  const memories = Array.from({ length: 60 }, (_, i) => ({ id: `m${i}`, memory_type: 'recurring_facts', memory_text: `Fact number ${i} about Marilyn that is fairly long and wordy`, status: 'approved', is_inferred: false, updated_at: `2024-01-${String((i % 28) + 1).padStart(2, '0')}` }));
  const block = buildPromptBlock({ contactName: 'Marilyn', memories });
  assert.ok(block.length <= 1700, `${block.length} chars`);
  assert.ok(!block.includes('chatter number'));
});

test('priority when trimming: call preferences and commitments survive over trivia', () => {
  const memories = [
    ...Array.from({ length: 40 }, (_, i) => ({ memory_type: 'previous_context', memory_text: `Trivia item ${i} with enough words to take space in the block`, is_inferred: false })),
    { memory_type: 'caller_preferences', memory_text: 'Does not want calls before 10am', is_inferred: false },
  ];
  const [first] = memories.slice(-1);
  const block = buildPromptBlock({ contactName: 'Marilyn', memories: [first, ...memories.slice(0, 40)] });
  assert.match(block, /Does not want calls before 10am/);
});

test('history snippets come back short, scoped and only when asked', async () => {
  const w = world();
  const importId = await analyzed(w);
  const idx = await call(w, A, { action: 'import-index', body: { importId } });
  assert.equal(idx.code, 200);
  assert.ok(idx.data.chunks >= 1);
  assert.equal(idx.data.embedded, false);
  const none = await call(w, A, { action: 'contact-context', method: 'GET', query: { contactId: 'ca' } });
  assert.deepEqual(none.data.snippets, []);
  const hit = await call(w, A, { action: 'contact-context', method: 'GET', query: { contactId: 'ca', query: 'birthday' } });
  assert.equal(hit.data.snippets.length, 1);
  assert.ok(hit.data.snippets[0].content.length <= 450);
  const miss = await call(w, A, { action: 'contact-context', method: 'GET', query: { contactId: 'ca', query: 'zebra' } });
  assert.deepEqual(miss.data.snippets, []);
});

test('embeddings are optional and only used with consent', async () => {
  const w = world();
  const importId = await analyzed(w); // consent given during analysis
  let embedded = 0;
  const embed = async (texts) => { embedded += texts.length; return texts.map(() => Array(1536).fill(0.01)); };
  const withKey = await call(w, A, { action: 'import-index', body: { importId }, deps: { embed, env: { OPENAI_API_KEY: 'k' } } });
  assert.equal(withKey.data.embedded, true);
  assert.ok(embedded >= 1);
  assert.match(w.db.tables.whatsapp_import_chunks[0].embedding, /^\[0\.01,/);
  const w2 = world();
  const { processed } = await importChat(w2);
  const noConsent = await call(w2, A, { action: 'import-index', body: { importId: processed.data.importId }, deps: { embed, env: { OPENAI_API_KEY: 'k' } } });
  assert.equal(noConsent.data.embedded, false);
  assert.equal(w2.db.tables.whatsapp_import_chunks[0].embedding, undefined);
});

test('embedTexts talks to the embeddings API in batches and fails closed', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => { const body = JSON.parse(init.body); seen.push(body.input.length); return { ok: true, json: async () => ({ data: body.input.map(() => ({ embedding: [1, 2] })) }) }; };
  const out = await embedTexts(Array.from({ length: 130 }, (_, i) => `t${i}`), { env: { OPENAI_API_KEY: 'k' }, fetchImpl });
  assert.equal(out.length, 130);
  assert.deepEqual(seen, [64, 64, 2]);
  await assert.rejects(embedTexts(['x'], { env: { OPENAI_API_KEY: 'k' }, fetchImpl: async () => ({ ok: false, status: 500 }) }));
  await assert.rejects(embedTexts(['x'], { env: {} }));
});

test('buildChunks: small, ordered, text only', () => {
  const chunks = buildChunks(chat.messages, { maxChars: 200 });
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((c) => c.content.length <= 260));
  assert.ok(!chunks.some((c) => /omitted/.test(c.content)));
  assert.deepEqual(chunks.map((c) => c.chunk_index), chunks.map((_, i) => i));
});

// ---- caller matching on a call --------------------------------------------

test('incoming WhatsApp caller -> that user\'s contact -> that contact\'s approved memories', async () => {
  const w = world();
  await analyzed(w);
  const [m1] = w.db.tables.contact_memories;
  await call(w, A, { action: 'cm-update', method: 'PATCH', body: { id: m1.id, status: 'approved' } });
  const viaJid = await call(w, A, { action: 'contact-context', method: 'GET', query: { caller: '2348012345678:7@s.whatsapp.net' } });
  assert.deepEqual([viaJid.data.match.status, viaJid.data.match.contactId], ['matched', 'ca']);
  assert.equal(viaJid.data.memories.length, 1);
  const unknown = await call(w, A, { action: 'contact-context', method: 'GET', query: { caller: '14155552671@s.whatsapp.net' } });
  assert.deepEqual([unknown.data.match.status, unknown.data.promptBlock], ['none', '']);
  const lid = await call(w, A, { action: 'contact-context', method: 'GET', query: { caller: '99999@lid' } });
  assert.equal(lid.data.match.status, 'invalid');
});

test('two contacts with one number: ambiguous, nothing is loaded', async () => {
  const w = world();
  await analyzed(w);
  await call(w, A, { action: 'cm-update', method: 'PATCH', body: { id: w.db.tables.contact_memories[0].id, status: 'approved' } });
  w.db.tables.contacts.push({ id: 'ca2', user_id: A, name: 'Marilyn (work)', phone_number: NUMBER });
  const r = await call(w, A, { action: 'contact-context', method: 'GET', query: { caller: '2348012345678@s.whatsapp.net' } });
  assert.equal(r.data.match.status, 'ambiguous');
  assert.equal(r.data.promptBlock, '');
});

test('relay path: shared secret + userId works, a wrong or missing secret does not', async () => {
  const w = world();
  await analyzed(w);
  await call(w, A, { action: 'cm-update', method: 'PATCH', body: { id: w.db.tables.contact_memories[0].id, status: 'approved' } });
  const env = { WACALLS_INTERNAL_SECRET: 'relay-secret' };
  const ok = await call(w, undefined, { action: 'contact-context', method: 'GET', query: { caller: '2348012345678@s.whatsapp.net', userId: A }, headers: { 'x-internal-secret': 'relay-secret' }, deps: { env, userId: undefined } });
  assert.equal(ok.code, 200);
  assert.equal(ok.data.memories.length, 1);
  const bad = await call(w, undefined, { action: 'contact-context', method: 'GET', query: { caller: '2348012345678@s.whatsapp.net', userId: A }, headers: { 'x-internal-secret': 'wrong' }, deps: { env, userId: undefined } });
  assert.equal(bad.code, 401);
  const noUser = await call(w, undefined, { action: 'contact-context', method: 'GET', query: { caller: '2348012345678@s.whatsapp.net' }, headers: { 'x-internal-secret': 'relay-secret' }, deps: { env, userId: undefined } });
  assert.equal(noUser.code, 400);
  // the shared secret does not open the user-facing actions
  const notUser = await call(w, undefined, { action: 'cm-list', method: 'GET', query: { contactId: 'ca', userId: A }, headers: { 'x-internal-secret': 'relay-secret' }, deps: { env, userId: null } });
  assert.equal(notUser.code, 401);
});

// ---- cross-user isolation at the API layer ---------------------------------

test('USER B cannot reach USER A\'s contact, imports, memories, chunks or call context', async () => {
  const w = world();
  const importId = await analyzed(w);
  await call(w, A, { action: 'import-index', body: { importId } });
  const memory = w.db.tables.contact_memories[0];
  await call(w, A, { action: 'cm-update', method: 'PATCH', body: { id: memory.id, status: 'approved' } });
  const before = JSON.stringify(w.db.tables);

  const attempts = [
    call(w, B, { action: 'import-init', body: { contactId: 'ca', filename: 'chat.txt', size: 10 } }),
    call(w, B, { action: 'import-process', body: { importId } }),
    call(w, B, { action: 'import-set-participants', body: { importId, contactParticipant: 'Marilyn' } }),
    call(w, B, { action: 'import-analyze', body: { importId, consent: true }, deps: { extract: fakeExtract } }),
    call(w, B, { action: 'import-index', body: { importId } }),
    call(w, B, { action: 'import-delete', method: 'DELETE', body: { importId, deleteMemories: true } }),
    call(w, B, { action: 'cm-update', method: 'PATCH', body: { id: memory.id, status: 'rejected' } }),
    call(w, B, { action: 'cm-delete', method: 'DELETE', body: { id: memory.id } }),
    call(w, B, { action: 'contact-context', method: 'GET', query: { contactId: 'ca' } }),
  ];
  for (const r of await Promise.all(attempts)) assert.equal(r.code, 404);
  assert.equal(JSON.stringify(w.db.tables), before, 'nothing of A\'s changed');

  const list = await call(w, B, { action: 'cm-list', method: 'GET', query: { contactId: 'ca' } });
  assert.deepEqual(list.data.memories, []);
  const imports = await call(w, B, { action: 'import-list', method: 'GET', query: { contactId: 'ca' } });
  assert.deepEqual(imports.data.imports, []);

  // Same phone number saved by both users: each only ever resolves to their own contact.
  const asB = await call(w, B, { action: 'contact-context', method: 'GET', query: { caller: '2348012345678@s.whatsapp.net', query: 'birthday' } });
  assert.equal(asB.data.match.contactId, 'cb');
  assert.equal(asB.data.promptBlock, '');
  assert.deepEqual(asB.data.snippets, []);
});

test('loadApprovedMemories filters by user and contact even if asked wrongly', async () => {
  const w = world({ contact_memories: [
    { id: '1', user_id: A, contact_id: 'ca', memory_type: 'identity', memory_text: 'A about ca', status: 'approved', updated_at: 'x' },
    { id: '2', user_id: B, contact_id: 'ca', memory_type: 'identity', memory_text: 'B forged row', status: 'approved', updated_at: 'x' },
    { id: '3', user_id: A, contact_id: 'cz', memory_type: 'identity', memory_text: 'A about another contact', status: 'approved', updated_at: 'x' },
    { id: '4', user_id: A, contact_id: 'ca', memory_type: 'identity', memory_text: 'rejected', status: 'rejected', updated_at: 'x' },
    { id: '5', user_id: A, contact_id: 'ca', memory_type: 'identity', memory_text: 'candidate', status: 'candidate', updated_at: 'x' },
  ] });
  const got = await loadApprovedMemories(w.supabase, { userId: A, contactId: 'ca' });
  assert.deepEqual(got.map((m) => m.memory_text), ['A about ca']);
});

test('deleting an import removes its files, and optionally its memories', async () => {
  const w = world();
  const importId = await analyzed(w);
  assert.ok(w.files.size >= 2);
  const del = await call(w, A, { action: 'import-delete', method: 'DELETE', body: { importId, deleteMemories: true } });
  assert.equal(del.code, 200);
  assert.equal(w.files.size, 0);
  assert.equal(w.db.tables.whatsapp_imports.length, 0);
  assert.equal(w.db.tables.contact_memories.length, 0);
});

test('import secret guard: codes, PINs, bank and ID numbers are blocked; ordinary facts pass', () => {
  for (const bad of ['your code is 482913, do not share', 'verification code 884213', 'pin 4821', 'the OTP is 123456', 'password is hunter2',
    'IBAN GB82WEST12345698765432', 'account number 0123456789', 'bvn 22212345678', 'card 4111 1111 1111 1111', 'NIN: 12345678901', 'ssn 123-45-6789']) {
    assert.equal(containsImportSecret(bad), true, bad);
    assert.equal(sanitizeContactMemory(bad), null, bad);
  }
  for (const ok of ['Birthday is on 5 May', 'Does not want calls before 10am', 'Lives on floor 12', 'Prefers voice notes', 'Moved to Lagos in 2019', 'Daughter Ada turns 7 in June']) {
    assert.equal(containsImportSecret(ok), false, ok);
    assert.equal(sanitizeContactMemory(ok), ok, ok);
  }
});
