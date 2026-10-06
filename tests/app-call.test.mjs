// In-app Emysa call: a live GPT-Live session started through a short-lived,
// per-session token. The token scheme must match pipecat-service/app/app_call.py:
//   token = `${exp}.${userId}.${hex(hmac_sha256(SECRET, `appcall:${sessionId}:${userId}:${exp}`))}`
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { database, loadApi, request } from './helpers.mjs';

const SECRET = 'app-call-secret-test';
const ENV = { ASSISTANT_BRIDGE_SECRET: SECRET, PUBLIC_ASSISTANT_WS_URL: 'wss://assistant.test/stream', OPENAI_API_KEY: 'test-only' };

async function setup(env = ENV, extra = {}) {
  const db = database({ calls: [], voice_preferences: [], voice_profiles: [], chat_sessions: [], ...extra });
  const { default: handler } = await loadApi('api/calls.js', db, async (u) => { throw new Error(`Unexpected external call: ${u}`); }, env);
  return { db, handler };
}

test('app-call-start creates the call row and mints a token matching the pipecat scheme', async () => {
  const f = await setup();
  const res = await request(f.handler, 'app-call-start', {});
  assert.equal(res.code, 200, JSON.stringify(res.data));
  const { callId, sessionId, url, engine, sampleRate } = res.data;
  assert.ok(callId);
  assert.match(sessionId, /^call-/);
  assert.equal(sampleRate, 16000);
  assert.equal(engine, 'gpt-live');
  assert.match(url, /^wss:\/\/assistant\.test\/app-call\/call-/);

  const token = new URL(url.replace('wss://', 'https://')).searchParams.get('token');
  const [exp, userId, sig] = token.split('.');
  assert.equal(userId, 'user-1');
  assert.equal(sig, createHmac('sha256', SECRET).update(`appcall:${sessionId}:user-1:${exp}`).digest('hex'));
  assert.ok(Number(exp) - Date.now() / 1000 <= 600 + 5, 'token is short-lived');

  const rows = f.db.tables?.calls || (await f.db.from('calls').select('*')).data;
  const row = rows.find((r) => r.id === callId);
  assert.equal(row.platform, 'app');
  assert.equal(row.status, 'in_progress');
  assert.equal(row.user_id, 'user-1');
});

test('GPT-Live always, except when the user chose their ready cloned voice', async () => {
  const clone = { user_id: 'user-1', status: 'ready', provider_voice_id: 'fish-abc1234' };
  const chosenClone = await setup(ENV, { voice_profiles: [clone], voice_preferences: [{ user_id: 'user-1', use_custom_voice: true }] });
  assert.equal((await request(chosenClone.handler, 'app-call-start', {})).data.engine, 'classic');

  const chosenStandard = await setup(ENV, { voice_profiles: [clone], voice_preferences: [{ user_id: 'user-1', use_custom_voice: false, live_voice_id: 'tempo' }] });
  assert.equal((await request(chosenStandard.handler, 'app-call-start', {})).data.engine, 'gpt-live');

  const noClone = await setup();
  assert.equal((await request(noClone.handler, 'app-call-start', {})).data.engine, 'gpt-live');
});

test('app-call-start needs auth, POST, and names missing configuration', async () => {
  const f = await setup();
  assert.equal((await request(f.handler, 'app-call-start', {}, { auth: false })).code, 401);
  assert.equal((await request(f.handler, 'app-call-start', {}, { method: 'GET' })).code, 405);
  const noSecret = await setup({ ...ENV, ASSISTANT_BRIDGE_SECRET: '' });
  assert.equal((await request(noSecret.handler, 'app-call-start', {})).data.code, 'missing-secret');
  const insecure = await setup({ ...ENV, PUBLIC_ASSISTANT_WS_URL: 'ws://assistant.test/stream' });
  assert.equal((await request(insecure.handler, 'app-call-start', {})).data.code, 'insecure-url');
});

// ---- Briefing: the in-app call turns into a pending call plan -----------------
function briefFixture({ brief, transcript, contacts }) {
  const db = database({
    calls: [{ id: '22222222-2222-2222-2222-222222222222', user_id: 'user-1', platform: 'app', status: 'completed', transcript }],
    contacts: contacts || [{ id: 'contact-1', user_id: 'user-1', name: 'Alex Morgan', phone_number: '+1 (415) 555-2671' }],
    chat_sessions: [], call_plans: [], assistant_messages: [], voice_preferences: [], voice_profiles: [],
  });
  const network = [];
  const fetcher = async (url, options) => {
    network.push(url);
    if (url.includes('api.openai.com')) return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(brief) } }] }) };
    throw new Error(`Unexpected external call: ${url}`);
  };
  return { db, network, fetcher };
}
const CALL_ID = '22222222-2222-2222-2222-222222222222';
const spoken = [
  { speaker: 'user', content: 'Call Alex and tell him the venue is confirmed for Friday at six.' },
  { speaker: 'assistant', content: 'Got it. Venue confirmed, Friday at six. Shall I prepare that call?' },
  { speaker: 'user', content: 'Yes.' },
];

test('a finished briefing becomes a PENDING plan for the matched contact and dials nothing', async () => {
  const f = briefFixture({ brief: { ready: true, contactName: 'Alex', instructions: 'Tell Alex the venue is confirmed for Friday at six.', summary: 'I will tell Alex the venue is confirmed for Friday at six.', when: null }, transcript: spoken });
  const { default: handler } = await loadApi('api/calls.js', f.db, f.fetcher, { ...ENV });
  const res = await request(handler, 'app-call-brief', { callId: CALL_ID });
  assert.equal(res.code, 200, JSON.stringify(res.data));
  assert.equal(res.data.status, 'prepared');
  assert.equal(res.data.contactName, 'Alex Morgan');
  const plans = f.db.tables.call_plans;
  assert.equal(plans.length, 1);
  assert.equal(plans[0].status, 'pending');
  assert.equal(plans[0].contact_id, 'contact-1');
  assert.match(plans[0].script, /venue is confirmed for Friday at six/);
  assert.equal(f.network.filter((u) => u.includes('twilio.com')).length, 0, 'no call is placed');

  const again = await request(handler, 'app-call-brief', { callId: CALL_ID });
  assert.equal(again.data.status, 'already-prepared');
  assert.equal(f.db.tables.call_plans.length, 1, 'idempotent');
});

test('an unknown or ambiguous contact asks instead of guessing', async () => {
  const f = briefFixture({ brief: { ready: true, contactName: 'Sam', instructions: 'Say hi.', summary: 'I will say hi.', when: null }, transcript: spoken });
  const { default: handler } = await loadApi('api/calls.js', f.db, f.fetcher, { ...ENV });
  const res = await request(handler, 'app-call-brief', { callId: CALL_ID });
  assert.equal(res.data.status, 'needs-contact');
  assert.equal(f.db.tables.call_plans.length, 0);
});

test('a conversation with no call requested prepares nothing, and a requested time is carried into the plan', async () => {
  const none = briefFixture({ brief: { ready: false, contactName: null, instructions: '', summary: '', when: null }, transcript: spoken });
  const a = await loadApi('api/calls.js', none.db, none.fetcher, { ...ENV });
  assert.equal((await request(a.default, 'app-call-brief', { callId: CALL_ID })).data.status, 'no-call-requested');

  const timed = briefFixture({ brief: { ready: true, contactName: 'Alex Morgan', instructions: 'Confirm the venue.', summary: 'I will confirm the venue.', when: 'tomorrow at 9am' }, transcript: spoken });
  const b = await loadApi('api/calls.js', timed.db, timed.fetcher, { ...ENV });
  const res = await request(b.default, 'app-call-brief', { callId: CALL_ID });
  assert.equal(res.data.when, 'tomorrow at 9am');
  assert.match(timed.db.tables.call_plans[0].summary, /tomorrow at 9am/);
});

test('the briefing only works for the owner and for in-app calls', async () => {
  const f = briefFixture({ brief: { ready: true }, transcript: spoken });
  f.db.tables.calls.push({ id: '33333333-3333-3333-3333-333333333333', user_id: 'user-1', platform: 'whatsapp', status: 'completed', transcript: spoken });
  const { default: handler } = await loadApi('api/calls.js', f.db, f.fetcher, { ...ENV });
  assert.equal((await request(handler, 'app-call-brief', { callId: '33333333-3333-3333-3333-333333333333' })).code, 404);
  assert.equal((await request(handler, 'app-call-brief', { callId: CALL_ID }, { auth: false })).code, 401);
});

test('app-call-start gives Emysa a briefing persona that knows the contact names, not numbers', async () => {
  const f = await setup(ENV, { contacts: [{ id: 'c1', user_id: 'user-1', name: 'Alex Morgan', phone_number: '+14155552671' }] });
  const res = await request(f.handler, 'app-call-start', {});
  const row = f.db.tables.calls.find((r) => r.id === res.data.callId);
  assert.match(row.instructions, /briefing you/);
  assert.match(row.instructions, /Alex Morgan/);
  assert.doesNotMatch(row.instructions, /4155552671/);
});
