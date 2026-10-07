// Calling-command flow:
//   * the model's natural reply is delivered BEFORE any call is placed;
//   * a repeat ("call him again") stays on the line the conversation already used;
//   * a line named in the message overrides that;
//   * a call with no named line and no history uses the normal resolver.
import test from 'node:test';
import assert from 'node:assert/strict';
import { database, loadApi, request } from './helpers.mjs';
import { resolveCallPlatform, conversationPlatform } from '../lib/callPlatform.js';
import { signPendingCall, verifyPendingCall } from '../lib/pendingCall.js';

const ENV = { WACALLS_RELAY_URL: 'https://relay.test', WACALLS_INTERNAL_SECRET: 'secret-test-value', OPENAI_API_KEY: 'test-only' };
const REPLY = "Sure, I'll ask him.";

function fixture({ calls = [], plans = [], phoneLine = false } = {}) {
  const db = database({
    contacts: [{ id: 'contact-john', user_id: 'user-1', name: 'John', phone_number: '+15550001111' }],
    chat_sessions: [{ id: 'chat-john', user_id: 'user-1', title: 'John', archived: false }],
    whatsapp_accounts: [{ user_id: 'user-1', wacalls_session_id: 'wa-1', status: 'connected' }],
    phone_lines: phoneLine ? [{ user_id: 'user-1', mode: 'own', phone_number: '+2348011112222', status: 'verified', twilio_sid: 'PN-test' }] : [],
    calls, call_plans: plans, assistant_messages: [], social_calls: [],
  });
  const log = []; // ordered events: 'reply-stored', 'dial'
  let intent = {};
  const fetcher = async (url, options = {}) => {
    if (url.includes('api.openai.com')) {
      const body = JSON.parse(options.body);
      return { ok: true, json: async () => ({ choices: [{ message: { content: body.response_format ? JSON.stringify(intent) : 'ok' } }] }) };
    }
    if (url.includes('relay.test')) {
      const path = url.replace('https://relay.test', '');
      if (path.endsWith('/calls') && options.method === 'POST') {
        log.push({ event: 'dial', replyAlreadyStored: db.tables.assistant_messages.some((m) => m.role === 'assistant' && m.content === REPLY) });
        return { ok: true, status: 200, json: async () => ({ call: { callId: `prov-${log.length}` } }) };
      }
      if (path.endsWith('/ai')) return { ok: true, status: 200, json: async () => ({ status: 'attached' }) };
      return { ok: true, status: 200, json: async () => ({}) };
    }
    throw new Error(`Unexpected external call: ${url}`);
  };
  return { db, log, fetcher, setIntent(v) { intent = v; } };
}

async function setup(opts) {
  const f = fixture(opts);
  const { default: handler } = await loadApi('api/assistant.js', f.db, f.fetcher, ENV);
  return { ...f, handler };
}

const dials = (f) => f.log.filter((e) => e.event === 'dial');
const ended = (id, platform, minutesAgo = 5) => ({
  id, user_id: 'user-1', session_id: 'chat-john', platform, to_number: '+15550001111', contact_id: 'contact-john',
  status: 'completed', objective: 'Ask if he is coming', created_at: new Date(Date.now() - minutesAgo * 60000).toISOString(),
});

// ---------------------------------------------------------------- reply -> call ordering

test('the natural reply is delivered first and nothing is dialed until the follow-up request', async () => {
  const f = await setup();
  f.setIntent({ action: 'call', contactName: 'John', objective: 'Ask if he is coming', channel: 'whatsapp', reply: REPLY });
  const first = await request(f.handler, 'send', { text: 'Call John and ask if he is coming', sessionId: 'chat-john', channel: 'whatsapp' }, { completePending: false });
  assert.equal(first.code, 200, JSON.stringify(first.data));

  // Phase one: the reply exists, the call does not.
  const replies = first.data.messages.filter((m) => m.role === 'assistant');
  assert.equal(JSON.stringify(replies.map((m) => m.content)), JSON.stringify([REPLY]), 'the model reply is the only assistant message so far');
  assert.ok(first.data.pendingCall?.token, 'the app is told a call is pending');
  assert.equal(first.data.pendingCall.channel, 'whatsapp');
  assert.equal(dials(f).length, 0, 'no call has been placed yet');
  assert.equal(f.db.tables.calls.length, 0, 'no call row exists yet');

  // Phase two: the app has shown the reply; now the call is placed.
  const second = await request(f.handler, 'send', { pendingCallToken: first.data.pendingCall.token, sessionId: first.data.sessionId }, { completePending: false });
  assert.equal(second.code, 200, JSON.stringify(second.data));
  assert.equal(dials(f).length, 1);
  assert.equal(dials(f)[0].replyAlreadyStored, true, 'the reply was stored before the dial happened');
  assert.ok(second.data.callId && second.data.toNumber);
  assert.match(second.data.messages.map((m) => m.content).join(' '), /Calling John on WhatsApp now/);
});

test('a missing model reply still gets a natural acknowledgement first, never a silent call', async () => {
  const f = await setup();
  f.setIntent({ action: 'call', contactName: 'John', objective: 'Ask', channel: 'whatsapp', reply: null });
  const first = await request(f.handler, 'send', { text: 'Call John', sessionId: 'chat-john', channel: 'whatsapp' }, { completePending: false });
  assert.match(first.data.messages.find((m) => m.role === 'assistant').content, /call John on WhatsApp/i);
  assert.equal(dials(f).length, 0);
});

test('the call request cannot be replayed, forged or used by someone else', async () => {
  const f = await setup();
  f.setIntent({ action: 'call', contactName: 'John', objective: 'Ask', channel: 'whatsapp', reply: REPLY });
  const first = await request(f.handler, 'send', { text: 'Call John', sessionId: 'chat-john', channel: 'whatsapp' }, { completePending: false });
  const token = first.data.pendingCall.token;
  await request(f.handler, 'send', { pendingCallToken: token, sessionId: 'chat-john' }, { completePending: false });
  // While the first call is still ringing, a second delivery is caught by the duplicate-call guard.
  const stillRinging = await request(f.handler, 'send', { pendingCallToken: token, sessionId: 'chat-john' }, { completePending: false });
  assert.match(JSON.stringify(stillRinging.data.messages), /already calling/);
  // Even after that call has ended, the same token cannot place another one.
  for (const row of f.db.tables.calls) row.status = 'completed';
  const again = await request(f.handler, 'send', { pendingCallToken: token, sessionId: 'chat-john' }, { completePending: false });
  assert.equal(dials(f).length, 1, 'a second delivery does not dial again');
  assert.equal(again.data.replayed, true);

  const forged = await request(f.handler, 'send', { pendingCallToken: `${token.split('.')[0]}.AAAA`, sessionId: 'chat-john' }, { completePending: false });
  assert.equal(forged.code, 400);
  assert.equal(dials(f).length, 1);
});

test('pending-call tokens are bound to the user and expire', () => {
  const env = { SUPABASE_SERVICE_ROLE_KEY: 'k' };
  const t = signPendingCall({ uid: 'user-1', intent: {} }, { env, now: 1_000_000 });
  assert.ok(verifyPendingCall(t, 'user-1', { env, now: 1_000_000 + 60_000 }));
  assert.equal(verifyPendingCall(t, 'user-2', { env, now: 1_000_000 }), null);
  assert.equal(verifyPendingCall(t, 'user-1', { env, now: 1_000_000 + 10 * 60_000 }), null);
  assert.equal(verifyPendingCall(t, 'user-1', { env: { SUPABASE_SERVICE_ROLE_KEY: 'other' }, now: 1_000_000 }), null);
});

// ---------------------------------------------------------------- repeat-call platform continuity

test('"call him again" reuses WhatsApp even though the app picker says phone', async () => {
  const f = await setup({ calls: [ended('c1', 'whatsapp')], phoneLine: true });
  f.setIntent({ action: 'retry', reply: "Sure, I'll try him again.", channel: null });
  const res = await request(f.handler, 'send', { text: 'Call him again', sessionId: 'chat-john', channel: 'phone' });
  assert.equal(res.code, 200, JSON.stringify(res.data));
  assert.equal(dials(f).length, 1, 'redialed on WhatsApp');
  assert.equal(f.db.tables.call_plans.length, 0, 'did not switch to the phone line');
  assert.equal(f.db.tables.calls.at(-1).platform, 'whatsapp');
});

test('"try her again" after a phone call stays on the phone line, not WhatsApp', async () => {
  const f = await setup({ calls: [ended('c1', 'phone')], phoneLine: true });
  f.setIntent({ action: 'retry', reply: "Sure, I'll try again.", channel: null });
  const res = await request(f.handler, 'send', { text: 'Try her again', sessionId: 'chat-john', channel: 'whatsapp' });
  assert.equal(res.code, 200, JSON.stringify(res.data));
  assert.equal(dials(f).length, 0, 'did not move to WhatsApp');
  assert.equal(f.db.tables.call_plans.length, 1, 'prepared a phone plan instead');
});

test('the most recent line in the conversation is the one repeated', async () => {
  const f = await setup({ calls: [ended('old', 'phone', 60), ended('new', 'whatsapp', 5)], phoneLine: true });
  f.setIntent({ action: 'retry', reply: 'On it.', channel: null });
  await request(f.handler, 'send', { text: 'Call him back', sessionId: 'chat-john', channel: 'phone' });
  assert.equal(dials(f).length, 1);
});

test('a failed or unanswered earlier attempt still counts as the line used', async () => {
  const f = await setup({ calls: [{ ...ended('c1', 'whatsapp'), status: 'failed' }], phoneLine: true });
  f.setIntent({ action: 'retry', reply: 'Trying again.', channel: null });
  await request(f.handler, 'send', { text: 'Call him again', sessionId: 'chat-john', channel: 'phone' });
  assert.equal(dials(f).length, 1);
  assert.equal(f.db.tables.call_plans.length, 0);
});

test('if the last line cannot be started from chat, it asks instead of switching', async () => {
  const f = await setup({ calls: [ended('c1', 'signal')], phoneLine: true });
  f.setIntent({ action: 'retry', reply: 'ok', channel: null });
  const res = await request(f.handler, 'send', { text: 'Call him again', sessionId: 'chat-john', channel: 'phone' });
  assert.match(res.data.messages.at(-1).content, /last call in this chat was on signal/i);
  assert.equal(dials(f).length, 0);
  assert.equal(f.db.tables.call_plans.length, 0);
});

// ---------------------------------------------------------------- explicit platform overrides

test('naming another line in the repeat request overrides the previous one', async () => {
  const f = await setup({ calls: [ended('c1', 'whatsapp')], phoneLine: true });
  f.setIntent({ action: 'retry', reply: "Sure, I'll ring his phone.", channel: 'phone' });
  const res = await request(f.handler, 'send', { text: 'Call him again on my phone line', sessionId: 'chat-john', channel: 'whatsapp' });
  assert.equal(res.code, 200, JSON.stringify(res.data));
  assert.equal(dials(f).length, 0, 'not WhatsApp any more');
  assert.equal(f.db.tables.call_plans.length, 1, 'phone plan prepared because the user asked for it');
});

// ---------------------------------------------------------------- no platform: normal resolver

test('a new call with no named line uses the app picker, ignoring older history', async () => {
  const f = await setup({ calls: [ended('c1', 'phone')], phoneLine: true });
  f.setIntent({ action: 'call', contactName: 'John', objective: 'Say hi', channel: null, reply: 'Sure.' });
  const res = await request(f.handler, 'send', { text: 'Call John and say hi', sessionId: 'chat-john', channel: 'whatsapp' });
  assert.equal(res.code, 200, JSON.stringify(res.data));
  assert.equal(dials(f).length, 1, 'picker said WhatsApp, so WhatsApp');
});

test('with two lines and no picker it asks, never guessing', async () => {
  const f = await setup({ phoneLine: true });
  f.setIntent({ action: 'call', contactName: 'John', objective: 'Say hi', channel: null, reply: 'Sure.' });
  const res = await request(f.handler, 'send', { text: 'Call John and say hi', sessionId: 'chat-john' });
  assert.match(res.data.messages.at(-1).content, /WhatsApp or your phone line/);
  assert.equal(dials(f).length, 0);
});

// ---------------------------------------------------------------- resolver unit tests

test('resolveCallPlatform precedence: named, then conversation (repeats only), then picker', () => {
  const calls = [{ platform: 'whatsapp', created_at: '2026-10-06T10:00:00Z' }];
  assert.deepEqual(resolveCallPlatform({ action: 'retry', intentChannel: 'telegram', uiChannel: 'phone', priorCalls: calls }), { channel: 'telegram', source: 'named', unsupported: null });
  assert.deepEqual(resolveCallPlatform({ action: 'retry', intentChannel: null, uiChannel: 'phone', priorCalls: calls }), { channel: 'whatsapp', source: 'conversation', unsupported: null });
  assert.deepEqual(resolveCallPlatform({ action: 'call', intentChannel: null, uiChannel: 'phone', priorCalls: calls }), { channel: 'phone', source: 'ui', unsupported: null });
  assert.deepEqual(resolveCallPlatform({ action: 'retry', intentChannel: null, uiChannel: 'phone', priorCalls: [] }), { channel: 'phone', source: 'ui', unsupported: null });
});

test('conversationPlatform reads calls and phone plans by recency, mapping old twilio rows to phone', () => {
  assert.equal(conversationPlatform([{ platform: 'twilio', created_at: '2026-10-06T09:00:00Z' }], []).platform, 'phone');
  const mixed = conversationPlatform(
    [{ platform: 'whatsapp', created_at: '2026-10-06T09:00:00Z' }],
    [{ created_at: '2026-10-06T11:00:00Z' }],
  );
  assert.equal(mixed.platform, 'phone');
  assert.deepEqual(conversationPlatform([], []), { platform: null, unsupported: null });
});
