// Regression tests for the wrong-person "call again" bug.
//
// The bug: open A's chat, call A; call B from B's chat; return to A's chat
// and say "call him again" — Emysa dialled B, because the WhatsApp/Telegram
// retry path looked up the user's GLOBAL most recent social call. Retries
// must resolve from the CURRENT conversation's own call history, period.
import test from 'node:test';
import assert from 'node:assert/strict';
import { database, loadApi, request } from './helpers.mjs';

const ENV = {
  WACALLS_RELAY_URL: 'https://relay.test',
  WACALLS_INTERNAL_SECRET: 'secret-test-value',
  OPENAI_API_KEY: 'test-only',
};

function fixture() {
  const db = database({
    contacts: [
      { id: 'contact-a', user_id: 'user-1', name: 'Alex', phone_number: '+15550001' },
      { id: 'contact-b', user_id: 'user-1', name: 'Blake', phone_number: '+15550002' },
    ],
    chat_sessions: [
      { id: 'chat-a', user_id: 'user-1', title: 'Alex chat', archived: false },
      { id: 'chat-b', user_id: 'user-1', title: 'Blake chat', archived: false },
    ],
    whatsapp_accounts: [{ user_id: 'user-1', wacalls_session_id: 'wa-1', status: 'connected' }],
    calls: [],
    call_plans: [],
    chat_messages: [],
  });
  const dialed = []; // phone numbers passed to the WaCalls relay, in order
  let intent = { action: 'reply', reply: 'ok' };
  const fetcher = async (url, options = {}) => {
    if (url.includes('api.openai.com')) {
      const body = JSON.parse(options.body);
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: body.response_format ? JSON.stringify(intent) : 'ok' } }],
        }),
      };
    }
    if (url.includes('relay.test')) {
      const path = url.replace('https://relay.test', '');
      const reqBody = options.body ? JSON.parse(options.body) : null;
      if (path.endsWith('/calls') && options.method === 'POST') {
        dialed.push(reqBody.phone);
        return { ok: true, status: 200, json: async () => ({ call: { callId: `prov-${dialed.length}` } }) };
      }
      if (path.endsWith('/ai')) return { ok: true, status: 200, json: async () => ({ status: 'attached' }) };
      return { ok: true, status: 200, json: async () => ({}) };
    }
    throw new Error(`Unexpected external call: ${url}`);
  };
  return { db, dialed, fetcher, setIntent(value) { intent = value; } };
}

async function setup() {
  const f = fixture();
  const { default: handler } = await loadApi('api/assistant.js', f.db, f.fetcher, ENV);
  return { ...f, handler };
}

async function callFrom(f, sessionId, contactId) {
  f.setIntent({ action: 'call', contactName: 'x', objective: 'Say hi', channel: 'whatsapp' });
  const res = await request(f.handler, 'send', {
    text: 'Call them and say hi',
    sessionId,
    channel: 'whatsapp',
    target: { contactId },
  });
  assert.equal(res.code, 200, JSON.stringify(res.data));
  return res;
}

// A retry is what you say after the previous call ended — mark every call
// row finished so the duplicate-call guard doesn't (correctly) refuse.
function endCalls(f) {
  for (const row of f.db.tables.calls) row.status = 'completed';
}

async function retryFrom(f, sessionId) {
  f.setIntent({ action: 'retry', reply: null, channel: null });
  return request(f.handler, 'send', { text: 'Call him again', sessionId, channel: 'whatsapp' });
}

test('REGRESSION: a retry in A\'s conversation can never dial B, no matter who was called last', async () => {
  const f = await setup();

  // 1. Call Alex from Alex's chat.
  await callFrom(f, 'chat-a', 'contact-a');
  // 2. Call Blake from Blake's chat — Blake is now the globally most recent call.
  await callFrom(f, 'chat-b', 'contact-b');
  assert.deepEqual(f.dialed, ['+15550001', '+15550002']);

  // 3. Back in ALEX's chat: "call him again" must redial Alex.
  endCalls(f);
  const retry = await retryFrom(f, 'chat-a');
  assert.equal(retry.code, 200, JSON.stringify(retry.data));
  assert.equal(f.dialed.length, 3, 'one more call should have been placed');
  assert.equal(f.dialed[2], '+15550001', `retry in Alex's chat must target Alex, not the globally last-called person (dialed: ${f.dialed})`);

  // 4. And the same holds the other way round.
  endCalls(f);
  const retryB = await retryFrom(f, 'chat-b');
  assert.equal(retryB.code, 200);
  assert.equal(f.dialed[3], '+15550002');
});

test('a retry on one line cannot be redirected by another line\'s call in the same conversation', async () => {
  const f = await setup();
  await callFrom(f, 'chat-a', 'contact-a');
  // A phone (Twilio) call from the same chat to Blake — the globally most
  // recent `calls` row now belongs to Blake.
  f.setIntent({ action: 'call', contactName: 'Blake', objective: 'Phone hi', channel: 'phone' });
  await request(f.handler, 'send', {
    text: 'Call Blake on the phone',
    sessionId: 'chat-a',
    channel: 'phone',
    target: { contactId: 'contact-b' },
  });

  // WhatsApp retry in this conversation repeats THIS conversation's WhatsApp
  // call (Alex) — the later Twilio call to Blake does not hijack it.
  endCalls(f);
  const retry = await retryFrom(f, 'chat-a');
  assert.equal(retry.code, 200, JSON.stringify(retry.data));
  assert.equal(f.dialed.at(-1), '+15550001');
});

test('a conversation with no identifiable recipient asks instead of guessing globally', async () => {
  const f = await setup();
  // Somebody else's calls exist globally — the retry must NOT reach for them.
  f.db.tables.calls.push({
    id: 'foreign-call', user_id: 'user-1', session_id: 'chat-b', platform: 'whatsapp',
    to_number: '+15550002', contact_id: 'contact-b', status: 'completed',
    created_at: new Date().toISOString(), objective: 'hi', transcript: [],
  });

  f.setIntent({ action: 'retry', reply: null, channel: null });
  const retry = await request(f.handler, 'send', {
    text: 'Call him again',
    sessionId: 'chat-a',
    channel: 'whatsapp',
  });
  assert.equal(retry.code, 200, JSON.stringify(retry.data));
  assert.equal(f.dialed.length, 0, 'nothing may be dialled when the conversation names nobody');
  const reply = retry.data.messages.at(-1).content;
  assert.match(reply, /who/i, `expected a "who do you mean" question, got: ${reply}`);
});

test('retry reuses the conversation\'s own contact, platform and instructions', async () => {
  const f = await setup();
  await callFrom(f, 'chat-a', 'contact-a');
  endCalls(f);
  const retry = await retryFrom(f, 'chat-a');
  assert.equal(retry.data.toNumber, '+15550001');
  assert.equal(retry.data.contactName, 'Alex');
  assert.equal(retry.data.channelUsed, 'whatsapp');
  // The new call row is created in the SAME conversation and inherits the
  // prior objective, keeping person-centred history together.
  const rows = f.db.tables.calls.filter((c) => c.session_id === 'chat-a');
  assert.ok(rows.length >= 2);
  assert.equal(rows.at(-1).contact_id, 'contact-a');
  assert.equal(rows.at(-1).to_number, '+15550001');
});
