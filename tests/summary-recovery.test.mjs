import test from 'node:test';
import assert from 'node:assert/strict';
import { database, loadApi } from './helpers.mjs';

const ENV = { OPENAI_API_KEY: 'test-only', VAPID_PUBLIC_KEY: '', VAPID_PRIVATE_KEY: '', VAPID_SUBJECT: '' };
const SUMMARY = {
  summary: 'I confirmed the venue for Friday at six with Ayo, and he agreed to bring the printed menus.',
  topics: ['venue'], learned: [], decisions: ['Venue confirmed for Friday at six'], commitments: ['Ayo will bring printed menus'],
  details: ['Friday, 6pm'], followups: ['Send Ayo the guest count'], unresolved: [], memories: [], incomplete: false,
};

async function load(db) {
  const fetcher = async (url) => {
    if (url.includes('api.openai.com')) return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(SUMMARY) } }] }) };
    throw new Error(`Unexpected external call: ${url}`);
  };
  return loadApi('lib/callSession.js', db, fetcher, ENV);
}

const turns = [{ speaker: 'user', content: 'Is the venue confirmed?' }, { speaker: 'assistant', content: 'Yes, Friday at six.' }];
const ago = (ms) => new Date(Date.now() - ms).toISOString();

test('a finished call that never got a summary is summarised and the generic chat line is replaced with the details', async () => {
  const db = database({
    calls: [{ id: 'call-old', user_id: 'user-1', session_id: 'chat-1', platform: 'whatsapp', status: 'completed', transcript: turns, summary_status: null, outcome_summary: null, ended_at: ago(5 * 3600_000), created_at: ago(5 * 3600_000) }],
    assistant_messages: [{ id: 'm1', user_id: 'user-1', session_id: 'chat-1', role: 'assistant', call_id: 'call-old', content: 'Finished the call with Ayo on WhatsApp (about 1 min).' }],
    push_subscriptions: [],
  });
  const mod = await load(db);
  const out = await mod.recoverMissingSummaries(db, 'user-1', { env: ENV });
  assert.equal(out.recovered, 1);
  const call = db.tables.calls[0];
  assert.equal(call.summary_status, 'completed');
  const msg = db.tables.assistant_messages.find((m) => m.id === 'm1').content;
  assert.match(msg, /confirmed the venue for Friday at six/);
  assert.match(msg, /Decisions:/);
  assert.match(msg, /- Ayo will bring printed menus/);
  assert.match(msg, /Follow-ups:/);
  assert.doesNotMatch(msg, /^Finished the call/);
});

test('in-app calls, empty transcripts and already-summarised calls are left alone', async () => {
  const db = database({
    calls: [
      { id: 'a', user_id: 'user-1', platform: 'app', status: 'completed', transcript: turns, summary_status: null, created_at: ago(3600_000) },
      { id: 'b', user_id: 'user-1', platform: 'whatsapp', status: 'completed', transcript: [], summary_status: null, created_at: ago(3600_000) },
      { id: 'c', user_id: 'user-1', platform: 'whatsapp', status: 'completed', transcript: turns, summary_status: 'completed', outcome_summary: 'Done.', created_at: ago(3600_000) },
    ],
    assistant_messages: [], push_subscriptions: [],
  });
  const mod = await load(db);
  assert.equal((await mod.recoverMissingSummaries(db, 'user-1', { env: ENV })).recovered, 0);
});

test('a previously failed summary is retried', async () => {
  const db = database({
    calls: [{ id: 'f', user_id: 'user-1', session_id: null, platform: 'whatsapp', status: 'completed', transcript: turns, summary_status: 'failed', outcome_summary: null, summary_json: { error: 'x' }, created_at: ago(2 * 3600_000), ended_at: ago(2 * 3600_000) }],
    assistant_messages: [], push_subscriptions: [],
  });
  const mod = await load(db);
  assert.equal((await mod.recoverMissingSummaries(db, 'user-1', { env: ENV })).recovered, 1);
  assert.equal(db.tables.calls[0].summary_status, 'completed');
});

test('formatSummaryForChat adds specifics under the summary and nothing else when there are none', async () => {
  const mod = await load(database({ calls: [] }));
  assert.equal(mod.formatSummaryForChat('All good.', {}), 'All good.');
  assert.match(mod.formatSummaryForChat('All good.', { decisions: ['A'], followups: ['B'] }), /Decisions:\n- A\n\nFollow-ups:\n- B/);
});
