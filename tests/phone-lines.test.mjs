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
    if (url.includes('signalwire.com')) return { ok: true, json: async () => ({ sid: 'CA-test' }) };
    throw new Error(`Unexpected external call: ${url}`);
  };
  return { db, network, fetcher };
}
const rows = (f, t) => f.db.tables[t] || [];
const twilioCalls = (f) => f.network.filter((r) => r.url.includes('signalwire.com'));
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
  const { placeCall } = await loadApi('lib/phoneCalls.js', f.db, f.fetcher, {});
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
    if (url.includes('/verified_caller_ids') && method === 'POST') {
      if (String(options.body).includes('already')) return { ok: false, status: 422, json: async () => ({ errors: ['rate limited'] }) };
      return { ok: true, status: 201, json: async () => ({ id: 'vc-1', number: '+2348011112222', verified: false, status: 'Awaiting Verification' }) };
    }
    if (url.includes('/verified_caller_ids/vc-1/verification') && method === 'PUT') {
      if (JSON.parse(options.body).verification_code !== '123456') return { ok: false, status: 422, json: async () => ({ errors: ['bad code'] }) };
      db.__verified = true;
      return { ok: true, status: 200, json: async () => ({ id: 'vc-1', verified: true, status: 'Verified' }) };
    }
    if (url.includes('/verified_caller_ids') && method === 'GET') return { ok: true, status: 200, json: async () => ({ data: [{ id: 'vc-1', number: '+2348011112222', verified: !!db.__verified, status: db.__verified ? 'Verified' : 'Awaiting Verification' }] }) };
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

test('new accounts need no approval to set up a line, but renting a number still needs the owner', async () => {
  const f = lineFixture({ approved: false });
  const get = await api(f, 'line-get', {}, { method: 'GET' });
  assert.equal(get.code, 200, 'an unapproved account can see its line setup');
  const verify = await api(f, 'line-verify-start', { phone: '+2348011112222' });
  assert.notEqual(verify.code, 403, 'an unapproved account can add its own number');
  const callsBefore = f.calls.length;
  const rent = await api(f, 'line-rent-buy', { phoneNumber: '+14155550101' }, { method: 'POST' });
  assert.equal(rent.code, 403, 'buying a real phone number still needs approval');
  assert.equal(f.calls.length, callsBefore, 'nothing reached Twilio for the refused rental');
});

test('bring your own number: SignalWire calls the user, the typed code verifies it', async () => {
  const f = lineFixture();
  const start = await api(f, 'line-verify-start', { phone: '0803 not a number' });
  assert.equal(start.code, 400);
  const ok = await api(f, 'line-verify-start', { phone: '+234 801 111 2222' });
  assert.equal(ok.code, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.line.status, 'pending');
  assert.equal(ok.data.line.validationCode, null, 'SignalWire reads the code out on the call; the app never shows one');
  const created = f.calls.find((c) => c.method === 'POST' && c.url.endsWith('/api/relay/rest/verified_caller_ids'));
  assert.ok(created, 'the caller ID is created on SignalWire\'s relay REST API');
  assert.equal(JSON.parse(created.body).number, '+2348011112222');
  const bad = await api(f, 'line-verify-code', { code: '000000' });
  assert.equal(bad.code, 400);
  assert.match(bad.data.error, /did not match/);
  const short = await api(f, 'line-verify-code', { code: '12' });
  assert.equal(short.code, 400);
  let status = await api(f, 'line-verify-status', {}, { method: 'GET' });
  assert.equal(status.data.line.status, 'pending');
  const good = await api(f, 'line-verify-code', { code: '123 456' });
  assert.equal(good.code, 200, JSON.stringify(good.data));
  assert.equal(good.data.line.status, 'verified');
  assert.ok(!JSON.stringify(good.data).includes('vc-1'), 'the carrier id must never reach the client');
  const get = await api(f, 'line-get', {}, { method: 'GET' });
  assert.equal(get.data.channels.phone, true);
});

test('entering a code before starting verification is refused', async () => {
  const f = lineFixture();
  const r = await api(f, 'line-verify-code', { code: '123456' });
  assert.equal(r.code, 409);
});

test('a rate-limited or uncallable number gets a plain message', async () => {
  const f = lineFixture();
  const r = await api(f, 'line-verify-start', { phone: '+2348011112222already' });
  assert.ok([400, 429].includes(r.code));
});

test('a caller ID already on the account is dropped first, so ownership is proven again', async () => {
  const f = lineFixture();
  f.db.__verified = true;
  const r = await api(f, 'line-verify-start', { phone: '+234 801 111 2222' });
  assert.equal(r.code, 200, JSON.stringify(r.data));
  assert.equal(r.data.line.status, 'pending');
  const del = f.calls.findIndex((c) => c.method === 'DELETE' && c.url.endsWith('/verified_caller_ids/vc-1'));
  const post = f.calls.findIndex((c) => c.method === 'POST' && c.url.endsWith('/verified_caller_ids'));
  assert.ok(del >= 0 && post > del, 'old record deleted before the new verification call');
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
