// Per-user phone lines: Twilio is reachable only through a user's OWN
// verified/rented number, and Emysa never picks a line the user lacks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { database, loadApi, request } from './helpers.mjs';

const ENV = { WACALLS_RELAY_URL: 'https://wacalls.test', WACALLS_INTERNAL_SECRET: 's3cret' };
const LINE = { user_id: 'user-1', mode: 'own', phone_number: '+2348011112222', status: 'verified', twilio_sid: 'PN-secret-sid' };
const WA = { user_id: 'user-1', wacalls_session_id: 'wa-1', status: 'connected' };
const APPROVED = { user_id: 'user-1', approved: true };

function chatFixture({ lines = [], whatsapp = [], intentChannel = null } = {}) {
  const db = database({
    phone_lines: lines, whatsapp_accounts: whatsapp,
    contacts: [{ id: 'c1', user_id: 'user-1', name: 'Alex', phone_number: '+14155552671' }],
  });
  const network = [];
  const fetcher = async (url, options = {}) => {
    network.push({ url, options });
    if (url.includes('api.openai.com')) {
      const body = JSON.parse(options.body);
      const intent = { action: 'call', contactName: 'Alex', objective: 'Confirm lunch.', channel: intentChannel };
      return { ok: true, json: async () => ({ choices: [{ message: { content: body.response_format ? JSON.stringify(intent) : 'Sure, I will confirm lunch.' } }] }) };
    }
    if (url.includes('wacalls.test')) return { ok: false, status: 500, json: async () => ({ error: 'relay down in test' }) };
    if (url.includes('twilio.com')) return { ok: true, json: async () => ({ sid: 'CA-test' }) };
    throw new Error(`Unexpected external call: ${url}`);
  };
  return { db, network, fetcher };
}
const rows = (f, t) => f.db.tables[t] || [];
const twilioCalls = (f) => f.network.filter((r) => r.url.includes('twilio.com'));
const waCalls = (f) => f.network.filter((r) => r.url.includes('wacalls.test'));
async function say(f, extra = {}) {
  const { default: handler } = await loadApi('api/assistant.js', f.db, f.fetcher, ENV);
  return request(handler, 'send', { text: 'Call Alex and confirm lunch.', ...extra });
}
const reply = (res) => (res.data.messages || []).map((m) => m.content).join('\n');

// ---- placeCall: the line is the only door to Twilio -------------------------

test('a user with no phone line cannot place a Twilio call, and nothing reaches Twilio', async () => {
  const f = chatFixture();
  const { placeCall } = await loadApi('lib/phoneCalls.js', f.db, f.fetcher);
  const result = await placeCall(f.db, 'user-1', { toNumber: '+14155552671', objective: 'x', contactId: null });
  assert.match(result.error, /not set up/);
  assert.equal(twilioCalls(f).length, 0);
  assert.equal(rows(f, 'calls').length, 0);
});

test('a pending (unverified) line is not usable either', async () => {
  const f = chatFixture({ lines: [{ ...LINE, status: 'pending' }] });
  const { placeCall } = await loadApi('lib/phoneCalls.js', f.db, f.fetcher);
  const result = await placeCall(f.db, 'user-1', { toNumber: '+14155552671', objective: 'x', contactId: null });
  assert.match(result.error, /not set up/);
  assert.equal(twilioCalls(f).length, 0);
});

test('calls go out from the user\'s own number, never the shared env number', async () => {
  const f = chatFixture({ lines: [LINE] });
  const { placeCall } = await loadApi('lib/phoneCalls.js', f.db, f.fetcher, { TWILIO_FROM_NUMBER: '+19990000000' });
  const result = await placeCall(f.db, 'user-1', { toNumber: '+14155552671', objective: 'x', contactId: null });
  assert.ok(result.call, JSON.stringify(result));
  assert.equal(twilioCalls(f)[0].options.body.get('From'), '+2348011112222');
});

// ---- which line Emysa uses ----------------------------------------------------

test('WhatsApp only: Emysa uses WhatsApp without asking and never touches Twilio', async () => {
  const f = chatFixture({ whatsapp: [WA] });
  const res = await say(f);
  assert.ok(waCalls(f).length > 0, 'should have tried the WhatsApp relay');
  assert.equal(twilioCalls(f).length, 0);
  assert.equal(rows(f, 'call_plans').length, 0);
  assert.doesNotMatch(reply(res), /Should I call on/);
});

test('both lines and none named: Emysa asks, and places nothing', async () => {
  const f = chatFixture({ lines: [LINE], whatsapp: [WA] });
  const res = await say(f);
  assert.match(reply(res), /WhatsApp or your phone line/);
  assert.equal(waCalls(f).length + twilioCalls(f).length, 0);
  assert.equal(rows(f, 'call_plans').length, 0);
});

test('both lines and the user named one in the message: no question', async () => {
  const f = chatFixture({ lines: [LINE], whatsapp: [WA], intentChannel: 'phone' });
  const res = await say(f);
  assert.doesNotMatch(reply(res), /Should I call on/);
  assert.equal(rows(f, 'call_plans').length, 1);
});

test('phone line only and none named: uses the phone line', async () => {
  const f = chatFixture({ lines: [LINE] });
  await say(f);
  assert.equal(rows(f, 'call_plans').length, 1);
  assert.equal(waCalls(f).length, 0);
});

test('no lines at all: tells the user how to set one up', async () => {
  const f = chatFixture();
  const res = await say(f);
  assert.match(reply(res), /Calling lines/);
  assert.equal(rows(f, 'call_plans').length, 0);
  assert.equal(waCalls(f).length + twilioCalls(f).length, 0);
});

test('explicit phone without a phone line is refused even if WhatsApp is linked', async () => {
  const f = chatFixture({ whatsapp: [WA] });
  const res = await say(f, { channel: 'phone' });
  assert.match(reply(res), /Phone calling isn't set up/);
  assert.equal(rows(f, 'call_plans').length, 0);
  assert.equal(twilioCalls(f).length, 0);
});

// ---- line API -----------------------------------------------------------------

function lineFixture({ approved = true, lines = [], rentEnv = {} } = {}) {
  const db = database({ user_approvals: approved ? [APPROVED] : [], phone_lines: lines, whatsapp_accounts: [] });
  const calls = [];
  const fetcher = async (url, options = {}) => {
    const method = options.method || 'GET';
    calls.push({ url, method, body: options.body });
    if (url.includes('/OutgoingCallerIds.json') && method === 'POST') {
      if (String(options.body).includes('already')) return { ok: false, status: 400, json: async () => ({ code: 21450, message: 'already verified' }) };
      return { ok: true, status: 201, json: async () => ({ validation_code: '123456', phone_number: '+2348011112222' }) };
    }
    if (url.includes('/OutgoingCallerIds.json')) return { ok: true, status: 200, json: async () => ({ outgoing_caller_ids: db.__verified ? [{ sid: 'PN1', phone_number: '+2348011112222' }] : [] }) };
    if (url.includes('/AvailablePhoneNumbers/')) return { ok: true, status: 200, json: async () => ({ available_phone_numbers: [{ phone_number: '+14155550101', locality: 'San Francisco', region: 'CA' }] }) };
    if (url.includes('/IncomingPhoneNumbers.json') && method === 'POST') return { ok: true, status: 201, json: async () => ({ sid: 'PN2', phone_number: '+14155550101' }) };
    if (method === 'DELETE') return { ok: true, status: 204, json: async () => ({}) };
    throw new Error(`Unexpected: ${method} ${url}`);
  };
  return { db, calls, fetcher, env: { ...rentEnv } };
}
async function api(f, action, body, opts) {
  const { default: handler } = await loadApi('api/calls.js', f.db, f.fetcher, f.env);
  return request(handler, action, body, opts);
}

test('line actions refuse users the admin has not approved, before any Twilio call', async () => {
  const f = lineFixture({ approved: false });
  for (const action of ['line-get', 'line-verify-start', 'line-rent-buy']) {
    const res = await api(f, action, { phone: '+2348011112222', phoneNumber: '+14155550101' }, { method: action === 'line-get' ? 'GET' : 'POST' });
    assert.equal(res.code, 403, action);
  }
  assert.equal(f.calls.length, 0);
});

test('bring your own number: verify starts, code is shown, polling flips it to verified', async () => {
  const f = lineFixture();
  const start = await api(f, 'line-verify-start', { phone: '0803 not a number' });
  assert.equal(start.code, 400);
  const ok = await api(f, 'line-verify-start', { phone: '+234 801 111 2222' });
  assert.equal(ok.code, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.line.status, 'pending');
  assert.equal(ok.data.line.validationCode, '123456');
  let status = await api(f, 'line-verify-status', {}, { method: 'GET' });
  assert.equal(status.data.line.status, 'pending');
  f.db.__verified = true;
  status = await api(f, 'line-verify-status', {}, { method: 'GET' });
  assert.equal(status.data.line.status, 'verified');
  assert.equal(status.data.line.validationCode, null);
  assert.ok(!JSON.stringify(status.data).includes('PN1'), 'the Twilio sid must never reach the client');
  const get = await api(f, 'line-get', {}, { method: 'GET' });
  assert.equal(get.data.channels.phone, true);
});

test('a number already verified in Twilio is not handed out without proof', async () => {
  const f = lineFixture();
  const res = await api(f, 'line-verify-start', { phone: '+2348011112222 already' });
  assert.notEqual(res.code, 200);
  assert.equal(f.db.tables.phone_lines.length, 0);
});

test('a number linked to another account cannot be claimed', async () => {
  const f = lineFixture({ lines: [{ ...LINE, user_id: 'user-2' }] });
  const res = await api(f, 'line-verify-start', { phone: '+2348011112222' });
  assert.equal(res.code, 409);
  assert.ok(!f.calls.some((c) => c.method === 'POST'));
});

test('renting is off until enabled with a price, then search and buy work', async () => {
  let f = lineFixture();
  assert.equal((await api(f, 'line-rent-search', {}, { method: 'GET' })).code, 503);
  assert.equal((await api(f, 'line-rent-buy', { phoneNumber: '+14155550101' })).code, 503);
  assert.equal(f.calls.length, 0);

  f = lineFixture({ rentEnv: { PHONE_RENT_ENABLED: 'true', PHONE_RENT_PRICE_USD: '4.99' } });
  const info = await api(f, 'line-get', {}, { method: 'GET' });
  assert.deepEqual({ e: info.data.rent.enabled, p: info.data.rent.monthlyUsd }, { e: true, p: 4.99 });
  const found = await api(f, 'line-rent-search', {}, { method: 'GET', query: { country: 'US', areaCode: '415' } });
  assert.equal(found.data.numbers[0].phoneNumber, '+14155550101');
  assert.equal((await api(f, 'line-rent-search', {}, { method: 'GET', query: { country: 'NG' } })).code, 400);
  const bought = await api(f, 'line-rent-buy', { phoneNumber: '+14155550101' });
  assert.equal(bought.data.line.status, 'rented');
  assert.equal(f.db.tables.phone_lines[0].twilio_sid, 'PN2');
});

test('removing a rented number releases it in Twilio; a failed release keeps the record', async () => {
  const f = lineFixture({ lines: [{ ...LINE, mode: 'rent', status: 'rented', phone_number: '+14155550101', twilio_sid: 'PN2' }] });
  const res = await api(f, 'line-remove', {});
  assert.equal(res.code, 200);
  assert.ok(f.calls.some((c) => c.method === 'DELETE' && c.url.includes('IncomingPhoneNumbers/PN2')));
  assert.equal(f.db.tables.phone_lines.length, 0);

  const g = lineFixture({ lines: [{ ...LINE, mode: 'rent', status: 'rented', twilio_sid: 'PN3' }] });
  const base = g.fetcher;
  g.fetcher = async (url, o = {}) => (o.method === 'DELETE' ? { ok: false, status: 500, json: async () => ({ message: 'boom' }) } : base(url, o));
  const bad = await api(g, 'line-remove', {});
  assert.equal(bad.code, 502);
  assert.equal(g.db.tables.phone_lines.length, 1, 'still billed by Twilio, so the record must stay');
});
