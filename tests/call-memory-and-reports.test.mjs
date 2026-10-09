// Call-derived memory (stored, corrected, isolated, evidence-checked, failure-reported) and
// first-person call reports.
import test from 'node:test';
import assert from 'node:assert/strict';
import { database, loadApi } from './helpers.mjs';
import { consolidateAndStoreMemories } from '../lib/memoryManager.js';
import {
  dropCompletedFollowups, fallbackReport, formatSummaryForChat, isFirstPersonReport, validateMemoryCandidates,
} from '../lib/callSession.js';

const ENV = { OPENAI_API_KEY: 'test-only', VAPID_PUBLIC_KEY: '', VAPID_PRIVATE_KEY: '', VAPID_SUBJECT: '' };

const turns = (them) => [
  { speaker: 'ai', content: 'Hi Sam, calling about Friday.' },
  { speaker: 'caller', content: them },
];

async function summarise(db, reply) {
  const fetcher = async (url) => {
    if (url.includes('api.openai.com')) return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(reply) } }] }) };
    throw new Error(`Unexpected external call: ${url}`);
  };
  const mod = await loadApi('lib/callSession.js', db, fetcher, ENV);
  return mod;
}

const REPLY = (over = {}) => ({
  summary: 'I spoke with Sam about Friday. He said he lives in Lagos.',
  outcome: 'I confirmed Friday works.', followup: 'None', followups: [], decisions: ['Friday confirmed'],
  memories: [{ text: 'Lives in Lagos', evidence: 'I live in Lagos these days', certainty: 'confirmed' }],
  incomplete: false, ...over,
});

function callRow(id, transcript, extra = {}) {
  return { id, user_id: 'u1', contact_id: 'k1', to_number: '+2348000000001', platform: 'whatsapp', status: 'completed',
    transcript, outcome_summary: null, summary_status: null, created_at: new Date().toISOString(), answered_at: new Date().toISOString(), ...extra };
}

test('a useful fact from call one is stored against the right contact and owner, with provenance', async () => {
  const db = database({ calls: [callRow('c1', turns('I live in Lagos these days'))], memories: [], contacts: [{ id: 'k1', user_id: 'u1', phone_number: '+2348000000001' }], push_subscriptions: [] });
  const mod = await summarise(db, REPLY());
  const out = await mod.maybeGenerateCallSummary(db, 'c1', { env: ENV, notify: false });
  assert.equal(out.status, 'completed');
  assert.equal(db.tables.memories.length, 1);
  const m = db.tables.memories[0];
  assert.equal(m.user_id, 'u1');
  assert.equal(m.contact_id, 'k1');
  assert.equal(m.status, 'confirmed');
  assert.equal(m.source_call_id, 'c1');
  assert.ok(m.observed_at);
  assert.equal(out.summaryJson.memory.saved, 1);
});

test('call two corrects the fact in place instead of keeping a contradiction, and keeps what it replaced', async () => {
  const db = database({ memories: [] });
  await consolidateAndStoreMemories({ supabase: db, userId: 'u1', contactId: 'k1', sourceCallId: 'c1', candidates: [{ content: 'Lives in Lagos', status: 'confirmed' }] });
  const res = await consolidateAndStoreMemories({ supabase: db, userId: 'u1', contactId: 'k1', sourceCallId: 'c2', candidates: [{ content: 'Moved to Abuja', status: 'confirmed' }] });
  assert.equal(res.updated, 1);
  assert.equal(db.tables.memories.length, 1);
  assert.equal(db.tables.memories[0].content, 'Moved to Abuja');
  assert.equal(db.tables.memories[0].previous_content, 'Lives in Lagos');
  assert.equal(db.tables.memories[0].source_call_id, 'c2');
});

test('an uncertain interpretation never overwrites a confirmed fact', async () => {
  const db = database({ memories: [] });
  await consolidateAndStoreMemories({ supabase: db, userId: 'u1', contactId: 'k1', candidates: [{ content: 'Lives in Lagos' }] });
  await consolidateAndStoreMemories({ supabase: db, userId: 'u1', contactId: 'k1', candidates: [{ content: 'Moved to Abuja', status: 'uncertain' }] });
  assert.equal(db.tables.memories[0].content, 'Lives in Lagos');
});

test('contact isolation: the same kind of fact about two contacts never overwrites or de-duplicates across them', async () => {
  const db = database({ memories: [] });
  await consolidateAndStoreMemories({ supabase: db, userId: 'u1', contactId: 'k1', candidates: [{ content: 'Lives in Lagos' }] });
  await consolidateAndStoreMemories({ supabase: db, userId: 'u1', contactId: 'k2', candidates: [{ content: 'Lives in Lagos' }] });
  await consolidateAndStoreMemories({ supabase: db, userId: 'u1', contactId: 'k2', candidates: [{ content: 'Moved to Abuja' }] });
  const k1 = db.tables.memories.filter((m) => m.contact_id === 'k1');
  const k2 = db.tables.memories.filter((m) => m.contact_id === 'k2');
  assert.equal(k1.length, 1);
  assert.equal(k1[0].content, 'Lives in Lagos', 'contact 1 untouched by contact 2 correction');
  assert.equal(k2.length, 1);
  assert.equal(k2[0].content, 'Moved to Abuja');
});

test('another owner\'s memories are never read or changed', async () => {
  const db = database({ memories: [{ id: 'x', user_id: 'other', contact_id: 'k1', content: 'Lives in Lagos', status: 'confirmed' }] });
  await consolidateAndStoreMemories({ supabase: db, userId: 'u1', contactId: 'k1', candidates: [{ content: 'Moved to Abuja' }] });
  assert.equal(db.tables.memories.find((m) => m.id === 'x').content, 'Lives in Lagos');
  assert.equal(db.tables.memories.filter((m) => m.user_id === 'u1').length, 1);
});

test('uncertain transcription: unclear speech, invented evidence, and fragments are never stored', () => {
  const transcript = turns('I live in Lagos these days');
  const cases = [
    [{ text: 'Likes jazz', evidence: 'I love jazz music', certainty: 'confirmed' }, 'noEvidence'],
    [{ text: 'Lives in Lagos', evidence: 'Lagos', certainty: 'confirmed' }, 'tooShort'],
    [{ text: 'Owns a boat', evidence: '[unintelligible] boat', certainty: 'confirmed' }, 'unclear'],
    ['Lives in Lagos', 'noEvidence'],
    [{ text: 'Account is 12345678901', evidence: 'I live in Lagos these days', certainty: 'confirmed' }, 'secret'],
  ];
  for (const [item, reason] of cases) {
    const { kept, dropped } = validateMemoryCandidates([item], transcript);
    assert.equal(kept.length, 0, reason);
    assert.equal(dropped[reason], 1, reason);
  }
  const ok = validateMemoryCandidates([{ text: 'Lives in Lagos', evidence: 'I live in Lagos these days', certainty: 'uncertain' }], transcript);
  assert.equal(ok.kept[0].status, 'uncertain');
});

test('evidence must come from what THEY said, not from what Emysa said', () => {
  const transcript = [{ speaker: 'ai', content: 'You live in Lagos, right?' }, { speaker: 'caller', content: 'Hmm, not sure' }];
  assert.equal(validateMemoryCandidates([{ text: 'Lives in Lagos', evidence: 'You live in Lagos, right', certainty: 'confirmed' }], transcript).kept.length, 0);
});

test('failed writes are logged and reported; nothing is claimed as saved', async () => {
  const db = database({ memories: [] });
  const real = db.from.bind(db);
  db.from = (t) => {
    const q = real(t);
    if (t !== 'memories') return q;
    q.insert = () => { const s = { select: () => s, single: () => s, then: (ok) => Promise.resolve({ data: null, error: { message: 'permission denied' } }).then(ok) }; return s; };
    return q;
  };
  const res = await consolidateAndStoreMemories({ supabase: db, userId: 'u1', contactId: 'k1', candidates: [{ content: 'Prefers morning calls' }] });
  assert.equal(res.inserted, 0);
  assert.equal(res.failed, 1);
  assert.equal(db.tables.memories.length, 0);
});

test('a call with no matching contact stores nothing and says so in its summary record', async () => {
  const db = database({ calls: [callRow('c9', turns('I live in Lagos these days'), { contact_id: null, to_number: '+2340000000000' })], memories: [], contacts: [], push_subscriptions: [] });
  const mod = await summarise(db, REPLY());
  const out = await mod.maybeGenerateCallSummary(db, 'c9', { env: ENV, notify: false });
  assert.equal(db.tables.memories.length, 0);
  assert.equal(out.summaryJson.memory.skipped, 'no-contact');
});

// ------------------------------------------------------------------ reports

test('reports are first person; outside-observer narration is rejected', () => {
  assert.ok(isFirstPersonReport('I spoke with him, but we did not settle anything.'));
  assert.ok(!isFirstPersonReport('Emysa introduced herself as Emysa and said she was trying to reach him on WhatsApp.'));
  assert.ok(!isFirstPersonReport('The assistant asked about Friday.'));
  assert.ok(!isFirstPersonReport('Agreed to move lunch to 1pm.'));
});

test('a model that narrates from outside gets one retry, then a deterministic first-person fallback', async () => {
  const db = database({ calls: [callRow('c3', turns('I just wanted to talk'))], memories: [], contacts: [], push_subscriptions: [] });
  const mod = await summarise(db, REPLY({ summary: 'Emysa introduced herself and said she was trying to reach him.', outcome: 'No clear next step was agreed.', decisions: [], memories: [] }));
  const out = await mod.maybeGenerateCallSummary(db, 'c3', { env: ENV, notify: false });
  assert.equal(out.status, 'completed');
  assert.match(out.summary, /^I spoke with/);
  assert.doesNotMatch(out.summary, /Emysa/);
  assert.equal(out.summaryJson.voiceFallback, true);
});

test('the report ends with Outcome and Follow-up in Emysa\'s own voice', () => {
  const text = formatSummaryForChat('I spoke with him, but we did not settle anything.', { outcome: 'No clear next step was agreed.', followup: 'None unless you want me to call him again.', followups: [] });
  assert.match(text, /\n\nOutcome: No clear next step was agreed\./);
  assert.match(text, /\n\nFollow-up: None unless you want me to call him again\./);
});

test('partial-transcript wording appears only when the transcript really is partial', async () => {
  const db = database({ calls: [callRow('p1', turns('I live in Lagos these days')), callRow('p2', turns('[unintelligible] ... Lagos'))], memories: [], contacts: [], push_subscriptions: [] });
  const mod = await summarise(db, REPLY({ incomplete: false, memories: [] }));
  const full = await mod.maybeGenerateCallSummary(db, 'p1', { env: ENV, notify: false });
  assert.doesNotMatch(full.summary, /partial transcript/i);
  const mod2 = await summarise(db, REPLY({ incomplete: true, unclear: ['Part of what he said was unclear'], memories: [] }));
  const partial = await mod2.maybeGenerateCallSummary(db, 'p2', { env: ENV, notify: false });
  assert.match(partial.summary, /partial transcript/i);
  assert.equal(JSON.stringify(partial.summaryJson.unclear), JSON.stringify(['Part of what he said was unclear']));
});

test('a retry that got through does not leave "try again" as an unresolved follow-up', () => {
  assert.equal(JSON.stringify(dropCompletedFollowups(['Try again later', 'Send the guest count'], { attemptNumber: 2, answered: true })), JSON.stringify(['Send the guest count']));
  assert.equal(JSON.stringify(dropCompletedFollowups(['Try again later'], { attemptNumber: 1, answered: false })), JSON.stringify(['Try again later']));
});

test('no outcome is invented: the fallback says no clear outcome when none was established', () => {
  const t = fallbackReport({ decisions: [], outcome: '' }, { who: 'Sam' });
  assert.equal(t, "I spoke with Sam. We didn't establish a clear outcome.");
});
