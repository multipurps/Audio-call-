import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePhone } from '../lib/phoneNumbers.js';
import { database, loadApi, request } from './helpers.mjs';

function fixture() {
  const db = database({ phone_lines: [{ user_id: 'user-1', mode: 'own', phone_number: '+14155550000', status: 'verified' }],
    contacts: [{ id: 'contact-1', user_id: 'user-1', name: 'Alex', phone_number: '+1 (415) 555-2671' }],
    chat_sessions: [{ id: 'foreign-chat', user_id: 'user-2', title: 'Private', archived: false }],
  });
  const network = [];
  let intent = { action: 'call', contactName: 'Alex', objective: 'Confirm lunch at noon.', channel: 'phone' };
  const fetcher = async (url, options) => {
    network.push({ url, options });
    if (url.includes('api.openai.com')) {
      const body = JSON.parse(options.body);
      return { ok: true, json: async () => ({ choices: [{ message: { content: body.response_format ? JSON.stringify(intent) : "I'll confirm lunch at noon and keep it friendly." } }] }) };
    }
    if (url.includes('twilio.com')) return { ok: true, json: async () => ({ sid: 'CA-test' }) };
    throw new Error(`Unexpected external call: ${url}`);
  };
  return { db, network, fetcher, setIntent(value) { intent = value; } };
}

async function setup() {
  const f = fixture();
  const { default: handler } = await loadApi('api/assistant.js', f.db, f.fetcher);
  return { ...f, handler };
}
const twilioCount = (f) => f.network.filter((r) => r.url.includes('twilio.com')).length;
const script = 'Confirm lunch at noon. Please keep it friendly and mention the window table.';
async function prepare(f, target = { contactId: 'contact-1' }, sessionId) {
  const result = await request(f.handler, 'prepareCall', { text: script, target, sessionId });
  assert.equal(result.code, 200, JSON.stringify(result.data));
  return result.data;
}

test('phone normalization requires explicit country code and rejects service codes', () => {
  assert.equal(normalizePhone('+1 (415) 555-2671'), '+14155552671');
  assert.equal(normalizePhone('0044 20 7946 0958'), '+442079460958');
  for (const invalid of ['4155552671', '*123#', '+01234567', '+12', '+1abc2345678', null, 123]) assert.equal(normalizePhone(invalid), null);
});

test('prepare persists raw script and summary without dialing; confirm uses immutable plan', async () => {
  const f = await setup();
  const data = await prepare(f, { contactId: 'contact-1', toNumber: '+19999999999', name: 'Spoofed' });
  const plan = data.messages[1].call_plan;
  assert.equal(plan.to_number, '+14155552671');
  assert.equal(plan.label, 'Alex');
  assert.equal(plan.objective, script);
  assert.match(data.messages[1].content, /Nothing has been dialed/);
  assert.equal(twilioCount(f), 0);
  const result = await request(f.handler, 'confirmCall', { planId: plan.id, toNumber: '+19999999999', objective: 'Tampered' });
  assert.equal(result.code, 200);
  assert.equal(twilioCount(f), 1);
  assert.equal(f.db.tables.calls[0].objective, script);
  assert.equal(f.db.tables.calls[0].session_id, data.sessionId);
  assert.equal(f.network.find((r) => r.url.includes('twilio.com')).options.body.get('To'), '+14155552671');
});

test('two concurrent Call Now requests make exactly one Twilio request', async () => {
  const f = await setup();
  const data = await prepare(f);
  const body = { planId: data.messages[1].call_plan.id };
  const results = await Promise.all([request(f.handler, 'confirmCall', body), request(f.handler, 'confirmCall', body)]);
  assert.deepEqual(results.map((r) => r.code).sort(), [200, 409]);
  assert.equal(twilioCount(f), 1);
});

test('old scripts are invalidated on revision, and cancellation/expiry block calls', async () => {
  const f = await setup();
  const first = await prepare(f);
  const revised = await prepare(f, { contactId: 'contact-1' }, first.sessionId);
  assert.equal((await request(f.handler, 'confirmCall', { planId: first.messages[1].call_plan.id })).code, 409);
  await request(f.handler, 'cancelCall', { sessionId: first.sessionId });
  assert.equal((await request(f.handler, 'confirmCall', { planId: revised.messages[1].call_plan.id })).code, 409);
  const third = await prepare(f);
  const plan = f.db.tables.call_plans.find((p) => p.id === third.messages[1].call_plan.id);
  plan.expires_at = '2000-01-01T00:00:00Z';
  assert.equal((await request(f.handler, 'confirmCall', { planId: plan.id })).code, 409);
  assert.equal(twilioCount(f), 0);
});

test('authentication and ownership enforced for contacts, sessions and plans', async () => {
  const f = await setup();
  assert.equal((await request(f.handler, 'prepareCall', { text: script }, { auth: false })).code, 401);
  assert.equal((await request(f.handler, 'prepareCall', { text: script, target: { contactId: 'foreign-contact' } })).code, 404);
  assert.equal((await request(f.handler, 'prepareCall', { text: script, target: { contactId: 'contact-1' }, sessionId: 'foreign-chat' })).code, 404);
  const data = await prepare(f);
  f.db.tables.call_plans[0].user_id = 'user-2';
  assert.equal((await request(f.handler, 'confirmCall', { planId: data.messages[1].call_plan.id })).code, 409);
  assert.equal(twilioCount(f), 0);
});

test('direct Emysa calls are independent callbacks with script context', async () => {
  const f = await setup();
  const data = await prepare(f, { kind: 'emysa', toNumber: '+442079460958' });
  const plan = data.messages[1].call_plan;
  assert.equal(plan.contact_id, null);
  assert.equal(plan.kind, 'emysa');
  assert.match(plan.objective, /calling the app user directly/);
  assert.ok(plan.objective.includes(script));
  assert.equal(twilioCount(f), 0);
  await request(f.handler, 'confirmCall', { planId: plan.id });
  assert.equal(twilioCount(f), 1);
});

test('chat call intent and legacy create endpoint cannot bypass confirmation', async () => {
  const f = await setup();
  const result = await request(f.handler, 'send', { text: 'Call Alex and confirm lunch at noon.', channel: 'phone' });
  assert.equal(result.code, 200);
  assert.equal(result.data.messages[1].call_plan.status, 'pending');
  assert.equal(twilioCount(f), 0);
  const { default: calls } = await loadApi('api/calls.js', f.db, f.fetcher);
  const bypass = await request(calls, 'create', { toNumber: '+14155552671', objective: 'Bypass' });
  assert.equal(bypass.code, 400);
  assert.equal(twilioCount(f), 0);
  f.setIntent({ action: 'call', contactName: 'Alex', objective: null, channel: 'phone' });
  const missingScript = await request(f.handler, 'send', { text: 'Call Alex', channel: 'phone' });
  assert.match(missingScript.data.messages[1].content, /What would you like me to say/);
  assert.equal(f.db.tables.call_plans.length, 1);
});

test('resumed chat exposes persisted confirmation and Recent Chat filters unrelated sessions', async () => {
  const f = await setup();
  const data = await prepare(f);
  f.db.tables.chat_sessions.push({ id: 'unrelated', user_id: 'user-1', title: 'Small talk', archived: false });
  const messages = await request(f.handler, 'messages', {}, { method: 'GET', query: { sessionId: data.sessionId } });
  assert.equal(messages.data.messages[1].call_plan.id, data.messages[1].call_plan.id);
  const recent = await request(f.handler, 'sessions', {}, { method: 'GET', query: { callRelated: 'true' } });
  assert.equal(recent.data.sessions.length, 1);
  assert.equal(recent.data.sessions[0].call_label, 'Alex');
  assert.equal(recent.data.sessions[0].id, data.sessionId);
});

test('provider errors consume the plan instead of enabling accidental redial', async () => {
  const f = fixture();
  const failureFetch = async (url, options) => url.includes('twilio.com')
    ? { ok: false, status: 500, text: async () => 'Provider test failure' } : f.fetcher(url, options);
  const { default: handler } = await loadApi('api/assistant.js', f.db, failureFetch);
  f.handler = handler;
  const data = await prepare(f);
  const body = { planId: data.messages[1].call_plan.id };
  assert.equal((await request(handler, 'confirmCall', body)).code, 502);
  assert.equal((await request(handler, 'confirmCall', body)).code, 409);
  assert.equal(f.db.tables.call_plans[0].status, 'failed');
});

test('monthly allowance gate runs before contacting Twilio', async () => {
  const f = await setup();
  f.db.tables.user_usage = [{ user_id: 'user-1', call_minutes_used: 60, monthly_minute_limit: 60 }];
  const data = await prepare(f);
  const result = await request(f.handler, 'confirmCall', { planId: data.messages[1].call_plan.id });
  assert.equal(result.code, 502);
  assert.match(result.data.error, /minutes exhausted/);
  assert.equal(twilioCount(f), 0);
});

test('contact saving normalizes existing formatted numbers rather than creating duplicates', async () => {
  const f = fixture();
  const { default: contacts } = await loadApi('api/contacts.js', f.db, f.fetcher);
  const result = await request(contacts, null, { name: 'Alex Updated', phoneNumber: '+14155552671' });
  assert.equal(result.code, 200);
  assert.equal(f.db.tables.contacts.length, 1);
  assert.equal(f.db.tables.contacts[0].name, 'Alex Updated');
  assert.equal(f.db.tables.contacts[0].phone_number, '+14155552671');
  assert.equal((await request(contacts, null, { name: 'Bad', phoneNumber: '*123#' })).code, 400);
});

test('Telegram action stays bound to chosen contact even if the model redirects it', async () => {
  const f = fixture();
  f.setIntent({ action: 'call', contactName: 'Other', phoneNumber: '+19999999999', channel: 'phone', objective: 'Wrong target' });
  f.db.tables.telegram_accounts = [{ user_id: 'user-1', status: 'connected' }];
  const relayCalls = [];
  const { default: handler } = await loadApi('api/assistant.js', f.db, async (url, options) => {
    if (url.startsWith('https://relay.test')) { relayCalls.push(JSON.parse(options.body)); return { ok: true, json: async () => ({ callId: 'telegram-call' }) }; }
    return f.fetcher(url, options);
  }, { MP_RELAY_URL: 'https://relay.test', MP_RELAY_INTERNAL_SECRET: 'test-only' });
  const result = await request(handler, 'send', { text: script, channel: 'telegram', target: { contactId: 'contact-1' } });
  assert.equal(result.code, 200);
  assert.equal(relayCalls.length, 1);
  assert.equal(relayCalls[0].to, '+14155552671');
  assert.equal(result.data.channelUsed, 'telegram');
  assert.equal(f.db.tables.calls[0].session_id, result.data.sessionId);
  assert.equal(f.db.tables.calls[0].contact_id, 'contact-1');
  assert.equal(twilioCount(f), 0);
});

test('assistant summary outage cannot create or start a call', async () => {
  const f = fixture();
  const { default: handler } = await loadApi('api/assistant.js', f.db, async () => ({ ok: false }));
  const result = await request(handler, 'prepareCall', { text: script, target: { contactId: 'contact-1' } });
  assert.equal(result.code, 502);
  assert.equal(f.db.tables.call_plans?.length || 0, 0);
  assert.equal(f.db.tables.calls?.length || 0, 0);
});

test('profile language is retained without changing the editable original script', async () => {
  const f = await setup();
  f.db.tables.profiles = [{ user_id: 'user-1', language: 'es' }];
  const data = await prepare(f);
  const plan = data.messages[1].call_plan;
  assert.match(plan.objective, /^Speak only in Spanish/);
  assert.equal(plan.script, script);
});

test('both relay implementations can distinguish Emysa callbacks from contact calls', async () => {
  const { assistantCallIdentity } = await import('../server/callIdentity.js');
  assert.equal(assistantCallIdentity('contact'), null);
  assert.match(assistantCallIdentity('emysa').situation, /Do not impersonate the user/);
  assert.match(assistantCallIdentity('emysa').greeting, /Emysa/);
  const f = await setup();
  const data = await prepare(f, { kind: 'emysa', toNumber: '+14155550100' });
  await request(f.handler, 'confirmCall', { planId: data.messages[1].call_plan.id });
  assert.equal(f.db.tables.calls[0].call_kind, 'emysa');
});

test('lost provider response is marked uncertain and cannot be redialed with the same plan', async () => {
  const f = fixture();
  let attempts = 0;
  const { default: handler } = await loadApi('api/assistant.js', f.db, async (url, options) => {
    if (url.includes('twilio.com')) { attempts++; throw new Error('simulated connection reset'); }
    return f.fetcher(url, options);
  });
  f.handler = handler;
  const data = await prepare(f);
  const body = { planId: data.messages[1].call_plan.id };
  const result = await request(handler, 'confirmCall', body);
  assert.equal(result.code, 502);
  assert.match(result.data.error, /may still connect/);
  assert.equal(f.db.tables.call_plans[0].status, 'uncertain');
  assert.equal(f.db.tables.calls[0].status, 'queued');
  assert.equal((await request(handler, 'confirmCall', body)).code, 409);
  assert.equal(attempts, 1);
});
