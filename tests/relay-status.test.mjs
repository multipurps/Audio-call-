// Provider answer/status handling for social calls: the answer event must
// drive status + timer state, terminal states must always be terminal, the
// summary must come from the real transcript, and each outcome must reach
// the chat exactly once.
import test from 'node:test';
import assert from 'node:assert/strict';
import { database, loadApi } from './helpers.mjs';

const SECRET = 'relay-secret-test';
const ENV = { RELAY_CALLBACK_SECRET: SECRET, OPENAI_API_KEY: 'test-only' };

function response() {
  return {
    code: 200,
    data: null,
    status(code) { this.code = code; return this; },
    json(data) { this.data = data; return this; },
  };
}

async function relay(handler, body, { secret = SECRET, method = 'POST' } = {}) {
  const res = response();
  await handler({
    method,
    headers: { 'x-relay-secret': secret },
    query: { action: 'relay-call-status' },
    body,
  }, res);
  return res;
}

function fixture() {
  const now = Date.now();
  const iso = (msAgo) => new Date(now - msAgo).toISOString();
  const db = database({
    contacts: [{ id: 'contact-a', user_id: 'user-1', name: 'Alex', phone_number: '+15550001' }],
    chat_sessions: [{ id: '11111111-1111-1111-1111-111111111111', user_id: 'user-1', title: 'Alex chat', archived: false }],
    calls: [
      {
        id: 'call-a', user_id: 'user-1', session_id: '11111111-1111-1111-1111-111111111111',
        platform: 'whatsapp', to_number: '+15550001', contact_id: 'contact-a',
        platform_call_id: '42', status: 'ringing', objective: 'Confirm lunch',
        transcript: [
          { speaker: 'user', content: 'Hi, can we confirm lunch at noon?', ts: iso(40_000) },
          { speaker: 'assistant', content: 'Of course — noon works.', ts: iso(35_000) },
        ],
        created_at: iso(60_000), updated_at: iso(60_000),
      },
      {
        // A same-number call in ANOTHER conversation, created LATER — the
        // session-scoped matching must never let it absorb chat-a's reports.
        id: 'call-b', user_id: 'user-1', session_id: '22222222-2222-2222-2222-222222222222',
        platform: 'whatsapp', to_number: '+15550001', contact_id: 'contact-a',
        platform_call_id: '77', status: 'ringing', objective: 'Other chat',
        transcript: [], created_at: iso(10_000), updated_at: iso(10_000),
      },
    ],
    social_calls: [],
    assistant_messages: [],
    chat_messages: [],
  });
  const llmReplies = [];
  const fetcher = async (url, options = {}) => {
    if (url.includes('api.openai.com')) {
      const body = JSON.parse(options.body);
      const reply = llmReplies.length ? llmReplies.shift() : {
        summary: 'Confirmed lunch at noon with a window table.',
        topics: ['lunch booking'], decisions: ['noon, window table'],
        commitments: ['keep the reservation'], followups: [], incomplete: false, memories: [],
      };
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: body.response_format ? JSON.stringify(reply) : 'ok' } }],
          model: 'gpt-4o-mini',
        }),
      };
    }
    throw new Error(`Unexpected external call: ${url}`);
  };
  return { db, fetcher, llmReplies, iso };
}

async function setup() {
  const f = fixture();
  const { default: handler } = await loadApi('api/social-calling.js', f.db, f.fetcher, ENV);
  return { ...f, handler };
}

const row = (f, id) => f.db.tables.calls.find((c) => c.id === id);

test('the provider answer event is what marks a call answered and stamps answered_at', async () => {
  const f = await setup();
  const res = await relay(f.handler, {
    userId: 'user-1',
    sessionId: '11111111-1111-1111-1111-111111111111',
    platform: 'whatsapp',
    peerIdentifier: '+15550001',
    status: 'answered',
  });
  assert.equal(res.code, 200, JSON.stringify(res.data));
  const call = row(f, 'call-a');
  assert.equal(call.status, 'in_progress');
  assert.ok(call.answered_at, 'answered_at must be stamped by the answer event');
  // The other conversation's later call to the same number is untouched.
  assert.equal(row(f, 'call-b').status, 'ringing');
  assert.equal(row(f, 'call-b').answered_at, undefined);
});

test('session-scoped matching wins over the globally most recent call to the same person', async () => {
  const f = await setup();
  // Report targets chat-a's call explicitly via its session + peer; call-b is
  // newer and to the SAME number — the report must still land on call-a.
  await relay(f.handler, {
    userId: 'user-1',
    sessionId: '11111111-1111-1111-1111-111111111111',
    platform: 'whatsapp',
    peerIdentifier: '+15550001',
    status: 'answered',
  });
  assert.equal(row(f, 'call-a').status, 'in_progress');
  assert.equal(row(f, 'call-b').status, 'ringing');
});

test('bridge ids like "call-42" map to the exact provider call row', async () => {
  const f = await setup();
  const res = await relay(f.handler, {
    userId: 'user-1',
    sessionId: 'call-42',
    platform: 'whatsapp',
    peerIdentifier: '+15550001',
    status: 'completed',
    durationSeconds: 120,
    transcript: [
      { speaker: 'user', content: 'Hi', ts: '2026-09-30T10:00:00Z' },
      { speaker: 'assistant', content: 'Hello!', ts: '2026-09-30T10:00:02Z' },
    ],
  });
  assert.equal(res.code, 200, JSON.stringify(res.data));
  const call = row(f, 'call-a');
  assert.equal(call.status, 'completed');
  assert.equal(call.duration_seconds, 120);
  // call-b must not absorb the report even though it is newer.
  assert.equal(row(f, 'call-b').status, 'ringing');
});

test('terminal transitions summarise the persisted transcript and post the summary to the chat exactly once', async () => {
  const f = await setup();
  const payload = {
    userId: 'user-1',
    sessionId: '11111111-1111-1111-1111-111111111111',
    platform: 'whatsapp',
    peerIdentifier: '+15550001',
    contactName: 'Alex',
    status: 'completed',
    durationSeconds: 300,
  };
  const first = await relay(f.handler, payload);
  assert.equal(first.code, 200);
  const call = row(f, 'call-a');
  assert.equal(call.status, 'completed');
  assert.equal(call.duration_seconds, 300);
  assert.ok(call.outcome_summary, 'summary must be generated from the transcript');
  assert.match(call.outcome_summary, /Confirmed lunch at noon/, call.outcome_summary);
  assert.equal(call.summary_status, 'completed');
  const chatRows = f.db.tables.assistant_messages.filter((m) => m.call_id === 'call-a');
  assert.equal(chatRows.length, 1, 'exactly one chat follow-up per finished call');
  assert.match(chatRows[0].content, /Confirmed lunch at noon/, 'the chat message carries the real summary, not a generic label');
  assert.doesNotMatch(chatRows[0].content, /Call finished\.$/i);

  // A duplicate terminal callback (carrier retries) must not double-post or
  // regenerate the summary.
  const again = await relay(f.handler, payload);
  assert.equal(again.code, 200);
  assert.equal(f.db.tables.assistant_messages.filter((m) => m.call_id === 'call-a').length, 1);
});

test('a call with no captured conversation states that plainly instead of a generic summary', async () => {
  const f = await setup();
  row(f, 'call-a').transcript = [];
  await relay(f.handler, {
    userId: 'user-1',
    sessionId: '11111111-1111-1111-1111-111111111111',
    platform: 'whatsapp',
    peerIdentifier: '+15550001',
    contactName: 'Alex',
    status: 'completed',
    durationSeconds: 60,
  });
  const call = row(f, 'call-a');
  assert.match(String(call.outcome_summary), /not captured/i);
  const chatRows = f.db.tables.assistant_messages.filter((m) => m.call_id === 'call-a');
  assert.equal(chatRows.length, 1);
  assert.match(chatRows[0].content, /not captured/i);
});

test('rejected, busy, unanswered and disconnected all land in truthful terminal states', async () => {
  const f = await setup();
  const cases = [
    ['rejected', 'rejected', undefined],
    ['declined', 'rejected', undefined],
    ['busy', 'busy', undefined],
    ['no-answer', 'no_answer', undefined],
    ['unanswered', 'no_answer', undefined],
    // Disconnected WITH talk time = a completed call cut by the network;
    // without talk time it never connected at all.
    ['disconnected', 'completed', 45],
  ];
  for (const [reported, expected, duration] of cases) {
    row(f, 'call-a').status = 'ringing';
    row(f, 'call-a').outcome_summary = null;
    row(f, 'call-a').summary_status = null;
    row(f, 'call-a').summary_json = null;
    row(f, 'call-a').duration_seconds = undefined;
    await relay(f.handler, {
      userId: 'user-1',
      sessionId: '11111111-1111-1111-1111-111111111111',
      platform: 'whatsapp',
      peerIdentifier: '+15550001',
      status: reported,
      ...(duration ? { durationSeconds: duration } : {}),
    });
    assert.equal(row(f, 'call-a').status, expected, `${reported} should map to ${expected}`);
    assert.ok(['completed', 'rejected', 'no_answer', 'busy', 'canceled', 'failed'].includes(row(f, 'call-a').status));
    if (duration) assert.equal(row(f, 'call-a').duration_seconds, duration);
  }
  // Disconnected with no talk time at all → failed (never connected).
  row(f, 'call-a').status = 'ringing';
  await relay(f.handler, {
    userId: 'user-1', sessionId: '11111111-1111-1111-1111-111111111111',
    platform: 'whatsapp', peerIdentifier: '+15550001', status: 'disconnected',
  });
  assert.equal(row(f, 'call-a').status, 'failed');
});

test('talk duration is derived from answered_at, never from ring time', async () => {
  const f = await setup();
  // Answer 90 seconds ago…
  row(f, 'call-a').answered_at = new Date(Date.now() - 90_000).toISOString();
  await relay(f.handler, {
    userId: 'user-1',
    sessionId: '11111111-1111-1111-1111-111111111111',
    platform: 'whatsapp',
    peerIdentifier: '+15550001',
    status: 'ended', // no durationSeconds provided by the carrier
  });
  const call = row(f, 'call-a');
  assert.equal(call.status, 'completed');
  const dur = Number(call.duration_seconds || 0);
  assert.ok(dur >= 85 && dur <= 95, `duration should derive from answered_at (~90s), got ${dur}`);
});

test('unauthenticated or malformed reports are rejected outright', async () => {
  const f = await setup();
  assert.equal((await relay(f.handler, { userId: 'user-1', status: 'answered' }, { secret: 'wrong' })).code, 401);
  assert.equal((await relay(f.handler, { platform: 'whatsapp', status: 'answered' })).code, 400);
  assert.equal((await relay(f.handler, {
    userId: 'user-1', peerIdentifier: '+15550001', status: 'answered', platform: 'skype',
  })).code, 400);
  // No call mutation happened on any rejected report.
  assert.equal(row(f, 'call-a').status, 'ringing');
});

test('an in-app (platform app) call end records its status but never a summary or chat report', async () => {
  const f = await setup();
  f.db.tables.calls.push({
    id: 'call-app', user_id: 'user-1', session_id: '11111111-1111-1111-1111-111111111111',
    platform: 'app', to_number: 'Emysa', contact_id: null, platform_call_id: 'pc-app-1',
    status: 'in_progress', objective: 'Have a live voice conversation with the user.',
    answered_at: f.iso(90_000),
    transcript: [
      { speaker: 'user', content: 'Remind me to confirm the venue on Friday.', ts: f.iso(80_000) },
      { speaker: 'assistant', content: 'Will do. Friday, venue confirmation.', ts: f.iso(70_000) },
    ],
    created_at: f.iso(95_000), updated_at: f.iso(95_000),
  });
  const res = await relay(f.handler, {
    callId: 'call-app', userId: 'user-1', sessionId: 'call-pc-app-1', platform: 'app', status: 'completed', durationSeconds: 60,
  });
  assert.equal(res.code, 200, JSON.stringify(res.data));
  const stored = row(f, 'call-app');
  assert.equal(stored.status, 'completed');
  assert.ok(stored.ended_at);
  assert.ok(!stored.summary_status && !stored.outcome_summary, 'no summary for an in-app call');
  assert.equal(f.db.tables.assistant_messages.filter((m) => m.call_id === 'call-app').length, 0, 'no chat report for an in-app call');
});

// ---- live-call status: what the provider reports is what the row says ----------------

test('a provider ringing report moves a dialing call to ringing, with no answer time', async () => {
  const f = await setup();
  row(f, 'call-a').status = 'queued';
  await relay(f.handler, { userId: 'user-1', sessionId: '11111111-1111-1111-1111-111111111111', platform: 'whatsapp', peerIdentifier: '+15550001', status: 'ringing' });
  assert.equal(row(f, 'call-a').status, 'ringing');
  assert.ok(!row(f, 'call-a').answered_at, 'ringing must not stamp an answer time (the timer starts only on answer)');
});

test('a late ringing report can never pull an answered or finished call back', async () => {
  const f = await setup();
  for (const status of ['in_progress', 'completed', 'rejected']) {
    row(f, 'call-a').status = status;
    await relay(f.handler, { userId: 'user-1', sessionId: '11111111-1111-1111-1111-111111111111', platform: 'whatsapp', peerIdentifier: '+15550001', status: 'ringing' });
    assert.equal(row(f, 'call-a').status, status, `ringing must not overwrite ${status}`);
  }
});

test('a rejected call is its own outcome: "rejected", never a failure, with the right chat line', async () => {
  const f = await setup();
  row(f, 'call-a').transcript = [];
  await relay(f.handler, { userId: 'user-1', sessionId: '11111111-1111-1111-1111-111111111111', platform: 'whatsapp', peerIdentifier: '+15550001', status: 'rejected' });
  assert.equal(row(f, 'call-a').status, 'rejected');
  assert.ok(!row(f, 'call-a').answered_at, 'a rejected call was never answered');
  assert.match(row(f, 'call-a').outcome_summary || '', /declined the call/);
});

test('silence/DND is not a rejection and not an answer: a rang-out call ends as no_answer, never connected', async () => {
  const f = await setup();
  row(f, 'call-a').transcript = [];
  row(f, 'call-a').status = 'ringing';
  await relay(f.handler, { userId: 'user-1', sessionId: '11111111-1111-1111-1111-111111111111', platform: 'whatsapp', peerIdentifier: '+15550001', status: 'no_answer' });
  assert.equal(row(f, 'call-a').status, 'no_answer');
  assert.ok(!row(f, 'call-a').answered_at, 'no answer time may ever be stamped without a provider answer');
});
