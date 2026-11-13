// Telnyx as the phone provider (TELEPHONY_PROVIDER=telnyx). SignalWire is the default; see lib/telephony.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { database, loadApi, response } from './helpers.mjs';
import {
  telephonyProvider, isTelnyxSid, telnyxConfigured, webhookToken, checkWebhookToken, guardTelnyxWebhook, telnyxDial, telnyxHangup,
} from '../lib/telephony.js';
import { streamStart, inboundAudio, mediaMessage, clearMessage, outboundFrameSize } from '../server/streamProtocol.js';

const ENV = { TELNYX_API_KEY: 'KEY-test', TELNYX_CONNECTION_ID: '1234567890', TELNYX_ACCOUNT_ID: 'acct-uuid' };
const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });

test('SignalWire is the default provider; Telnyx only when asked for', () => {
  assert.equal(telephonyProvider({}), 'signalwire');
  assert.equal(telephonyProvider({ TELEPHONY_PROVIDER: 'signalwire' }), 'signalwire');
  assert.equal(telephonyProvider({ TELEPHONY_PROVIDER: 'TELNYX' }), 'telnyx');
  assert.equal(telephonyProvider({ TELEPHONY_PROVIDER: 'something-else' }), 'signalwire');
});

test('Telnyx call ids are told apart from Twilio ones', () => {
  assert.equal(isTelnyxSid('v3:KBnLO0ZK3DhKM5s7bE9VluaSmKsOchKht_fUYvxcp8ysbmzCCtpkmA'), true);
  assert.equal(isTelnyxSid('v2:T02llQxIyaRkhfRKxgAP8nY511'), true);
  assert.equal(isTelnyxSid('CA0123456789abcdef0123456789abcdef'), false);
  assert.equal(isTelnyxSid(''), false);
  assert.equal(isTelnyxSid(null), false);
});

test('telnyxConfigured needs both the API key and the TeXML connection id', () => {
  assert.equal(telnyxConfigured(ENV), true);
  assert.equal(telnyxConfigured({ TELNYX_API_KEY: 'k' }), false);
  assert.equal(telnyxConfigured({ TELNYX_CONNECTION_ID: '1' }), false);
});

test('webhook tokens are stable, per call, and checked', () => {
  const t1 = webhookToken('call:abc', ENV);
  assert.match(t1, /^[0-9a-f]{32}$/);
  assert.equal(webhookToken('call:abc', ENV), t1);
  assert.notEqual(webhookToken('call:other', ENV), t1);
  assert.notEqual(webhookToken('call:abc', { ...ENV, TELNYX_WEBHOOK_SECRET: 'x' }), t1);
  assert.equal(checkWebhookToken('call:abc', t1, ENV).ok, true);
  assert.equal(checkWebhookToken('call:abc', 'nope', ENV).ok, false);
  assert.equal(checkWebhookToken('call:other', t1, ENV).ok, false, 'a token for one call must not work for another');
  assert.equal(checkWebhookToken('call:abc', '', ENV).reason, 'missing token');
});

test('the webhook guard warns by default and rejects only in enforce mode', () => {
  const log = { warn() {} };
  const bad = { url: '/api/calls-status?callId=abc&t=bad', query: { callId: 'abc', t: 'bad' } };
  const good = { url: '/x', query: { callId: 'abc', t: webhookToken('call:abc', ENV) } };
  const res = () => { const r = { code: 200, status(c) { r.code = c; return r; }, send() { return r; } }; return r; };
  let r = res();
  assert.equal(guardTelnyxWebhook(bad, r, 'call:abc', ENV, log), true, 'warn mode lets it through');
  r = res();
  assert.equal(guardTelnyxWebhook(bad, r, 'call:abc', { ...ENV, TELNYX_WEBHOOK_VALIDATION: 'enforce' }, log), false);
  assert.equal(r.code, 403);
  assert.equal(guardTelnyxWebhook(good, res(), 'call:abc', { ...ENV, TELNYX_WEBHOOK_VALIDATION: 'enforce' }, log), true);
  assert.equal(guardTelnyxWebhook(bad, res(), 'call:abc', { ...ENV, TELNYX_WEBHOOK_VALIDATION: 'off' }, log), true);
});

test('telnyxDial posts to the TeXML connection with the key, the number, and both callbacks carrying a token', async () => {
  const seen = [];
  const fetchImpl = async (url, opts) => { seen.push({ url, opts }); return json(200, { call_sid: 'v3:abc', from: '+2348011112222', to: '+14155552671', status: 'queued' }); };
  const r = await telnyxDial({ to: '+14155552671', from: '+2348011112222', callId: 'call-1', appUrl: 'https://app.test', record: true, ringSeconds: 30 }, ENV, fetchImpl);
  assert.deepEqual(r, { ok: true, sid: 'v3:abc', status: 'queued' });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, 'https://api.telnyx.com/v2/texml/calls/1234567890');
  assert.equal(seen[0].opts.headers.Authorization, 'Bearer KEY-test');
  const body = JSON.parse(seen[0].opts.body);
  assert.equal(body.To, '+14155552671');
  assert.equal(body.From, '+2348011112222');
  const token = webhookToken('call:call-1', ENV);
  assert.equal(body.Url, `https://app.test/api/calls-twiml?callId=call-1&t=${token}`);
  assert.equal(body.StatusCallback, `https://app.test/api/calls-status?callId=call-1&t=${token}`);
  assert.equal(body.Timeout, 30);
  assert.equal(body.MachineDetection, 'Enable');
  assert.equal(body.Record, true);
});

test('telnyxDial accepts the older wrapped response and retries a rejected optional field with a smaller body', async () => {
  const bodies = [];
  const fetchImpl = async (url, opts) => {
    bodies.push(JSON.parse(opts.body));
    if (bodies.length === 1) return json(422, { errors: [{ code: '10015', title: 'Bad request', detail: 'Unknown parameter: MachineDetection' }] });
    return json(200, { data: { call_sid: 'v3:second', status: 'queued' } });
  };
  const r = await telnyxDial({ to: '+1', from: '+2', callId: 'c', appUrl: 'https://app.test' }, ENV, fetchImpl);
  assert.equal(r.ok, true);
  assert.equal(r.sid, 'v3:second');
  assert.equal(bodies.length, 2);
  assert.ok('MachineDetection' in bodies[0]);
  assert.ok(!('MachineDetection' in bodies[1]));
  assert.ok(bodies[1].Url && bodies[1].StatusCallback, 'the smaller body still carries both callbacks');
});

test('telnyxDial does not retry an auth failure and reports Telnyx\'s own reason', async () => {
  let n = 0;
  const fetchImpl = async () => { n++; return json(401, { errors: [{ code: '10009', title: 'Authentication failed', detail: 'Could not understand the provided credentials.' }] }); };
  const r = await telnyxDial({ to: '+1', from: '+2', callId: 'c', appUrl: 'https://app.test' }, ENV, fetchImpl);
  assert.equal(n, 1);
  assert.equal(r.ok, false);
  assert.equal(r.status, 401);
  assert.equal(r.code, '10009');
  assert.match(r.detail, /credentials/);
});

test('telnyxHangup ends the call with Status=completed against the account', async () => {
  const seen = [];
  const fetchImpl = async (url, opts) => { seen.push({ url, opts }); return json(200, { status: 'completed' }); };
  const r = await telnyxHangup('v3:abc', { env: ENV, fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(seen[0].url, 'https://api.telnyx.com/v2/texml/Accounts/acct-uuid/Calls/v3%3Aabc');
  assert.equal(seen[0].opts.headers.Authorization, 'Bearer KEY-test');
  assert.equal(String(seen[0].opts.body), 'Status=completed');
});

test('telnyxHangup falls back to the account id from the stream, and says what is missing otherwise', async () => {
  const seen = [];
  const fetchImpl = async (url) => { seen.push(url); return json(200, {}); };
  const noAccountEnv = { TELNYX_API_KEY: 'KEY-test' };
  assert.equal((await telnyxHangup('v3:abc', { env: noAccountEnv, accountId: 'from-stream', fetchImpl })).ok, true);
  assert.match(seen[0], /Accounts\/from-stream\//);
  const missing = await telnyxHangup('v3:abc', { env: noAccountEnv, fetchImpl });
  assert.equal(missing.ok, false);
  assert.match(missing.detail, /TELNYX_ACCOUNT_ID/);
});

// ---- the relay's view of the media stream ----------------------------------

test('Telnyx and Twilio start frames are both understood', () => {
  const telnyx = streamStart({ event: 'start', sequence_number: '1', stream_id: 'sid-1',
    start: { user_id: 'user-uuid', call_control_id: 'v3:abc', custom_parameters: { a: '1' }, media_format: { encoding: 'PCMU', sample_rate: 8000, channels: 1 } } });
  assert.deepEqual(telnyx, { provider: 'telnyx', streamId: 'sid-1', callSid: 'v3:abc', accountId: 'user-uuid', customParameters: { a: '1' } });
  const twilio = streamStart({ event: 'start', start: { streamSid: 'MZ1', callSid: 'CA1', customParameters: { b: '2' } } });
  assert.deepEqual(twilio, { provider: 'twilio', streamId: 'MZ1', callSid: 'CA1', accountId: null, customParameters: { b: '2' } });
  assert.equal(streamStart({ event: 'media' }), null);
  assert.equal(streamStart({ event: 'connected', version: '1.0.0' }), null, 'Telnyx sends a connected frame first; it is not a start');
});

test('only the callee\'s audio is passed on: the outbound track is ignored', () => {
  const payload = Buffer.from([1, 2, 3, 4]).toString('base64');
  assert.deepEqual([...inboundAudio({ event: 'media', media: { track: 'inbound', payload } })], [1, 2, 3, 4]);
  assert.deepEqual([...inboundAudio({ event: 'media', streamSid: 'MZ1', media: { payload } })], [1, 2, 3, 4], 'Twilio frames carry no track');
  assert.equal(inboundAudio({ event: 'media', media: { track: 'outbound', payload } }), null);
  assert.equal(inboundAudio({ event: 'media', media: {} }), null);
  assert.equal(inboundAudio({ event: 'stop' }), null);
});

test('frames sent back match each provider\'s format', () => {
  assert.deepEqual(mediaMessage('twilio', 'MZ1', 'QUJD'), { event: 'media', streamSid: 'MZ1', media: { payload: 'QUJD' } });
  assert.deepEqual(mediaMessage('telnyx', 'sid-1', 'QUJD'), { event: 'media', media: { payload: 'QUJD' } });
  assert.deepEqual(clearMessage('twilio', 'MZ1'), { event: 'clear', streamSid: 'MZ1' });
  assert.deepEqual(clearMessage('telnyx', 'sid-1'), { event: 'clear' });
  assert.equal(outboundFrameSize('twilio'), 160);
  assert.ok(outboundFrameSize('telnyx') > 160);
});

// ---- the TeXML answer and placeCall -----------------------------------------

async function twiml(env) {
  const { default: handler } = await loadApi('api/calls-twiml.js', database(), async () => { throw new Error('no network expected'); },
    { RELAY_WS_URL: 'wss://relay.test/stream', ...env });
  let body = '';
  const headers = {};
  const res = { code: 200, setHeader(k, v) { headers[k] = v; }, status(c) { res.code = c; return res; }, send(b) { body = b; return res; } };
  await handler({ method: 'POST', url: '/api/calls-twiml?callId=call-1', headers: {}, query: { callId: 'call-1' }, body: {} }, res);
  return { code: res.code, body, headers };
}

test('Telnyx gets <Connect><Stream> with two-way PCMU audio, SignalWire gets the call id as a <Parameter>', async () => {
  const t = await twiml({ TELEPHONY_PROVIDER: 'telnyx', TELNYX_API_KEY: 'KEY-test', TELNYX_WEBHOOK_VALIDATION: 'off' });
  assert.equal(t.code, 200);
  assert.equal(t.headers['Content-Type'], 'text/xml');
  assert.match(t.body, /<Connect>\s*<Stream url="wss:\/\/relay\.test\/stream\?callId=call-1" track="inbound_track" bidirectionalMode="rtp" bidirectionalCodec="PCMU" bidirectionalSamplingRate="8000" \/>\s*<\/Connect>/);
  const w = await twiml({ WEBHOOK_VALIDATION: 'off' });
  assert.match(w.body, /<Stream url="wss:\/\/relay\.test\/stream"><Parameter name="callId" value="call-1" \/><\/Stream>/);
  assert.doesNotMatch(w.body, /stream\?/, 'SignalWire rejects a query string on the stream URL');
  assert.doesNotMatch(w.body, /bidirectionalMode/);
});

test('a voicemail answer is hung up on, for Telnyx too, and a bad token is rejected when enforced', async () => {
  const db = database({ calls: [{ id: 'call-1', contact_id: null }] });
  const { default: handler } = await loadApi('api/calls-twiml.js', db, async () => { throw new Error('no network'); },
    { RELAY_WS_URL: 'wss://relay.test/stream', TELEPHONY_PROVIDER: 'telnyx', TELNYX_API_KEY: 'KEY-test', TELNYX_WEBHOOK_VALIDATION: 'enforce' });
  const send = async (query, body = {}) => {
    let out = '';
    const res = { code: 200, setHeader() {}, status(c) { res.code = c; return res; }, send(b) { out = b; return res; } };
    await handler({ method: 'POST', url: '/api/calls-twiml', headers: {}, query, body }, res);
    return { code: res.code, out };
  };
  const rejected = await send({ callId: 'call-1', t: 'wrong' });
  assert.equal(rejected.code, 403);
  const t = webhookToken('call:call-1', { TELNYX_API_KEY: 'KEY-test' });
  const machine = await send({ callId: 'call-1', t }, { AnsweredBy: 'machine_start' });
  assert.match(machine.out, /<Hangup\/>/);
});

test('placeCall through Telnyx: dials from the user\'s own line, stores the Telnyx call id, never touches Twilio', async () => {
  const db = database({ phone_lines: [{ user_id: 'user-1', mode: 'rent', phone_number: '+2348011112222', status: 'rented' }] });
  const network = [];
  const fetcher = async (url, opts = {}) => {
    network.push({ url, opts });
    if (url.startsWith('https://api.telnyx.com/v2/texml/calls/')) return json(200, { call_sid: 'v3:live-1', status: 'queued' });
    throw new Error(`Unexpected external call: ${url}`);
  };
  const { placeCall } = await loadApi('lib/phoneCalls.js', db, fetcher, { ...ENV, TELEPHONY_PROVIDER: 'telnyx', SIGNALWIRE_SPACE: '', SIGNALWIRE_PROJECT_ID: '', SIGNALWIRE_API_TOKEN: '' });
  const result = await placeCall(db, 'user-1', { toNumber: '+14155552671', objective: 'Confirm lunch.', contactId: null });
  assert.ok(result.call, JSON.stringify(result));
  assert.equal(network.length, 1);
  assert.equal(JSON.parse(network[0].opts.body).From, '+2348011112222');
  assert.equal(network.filter((n) => n.url.includes('signalwire.com')).length, 0);
  const row = db.tables.calls[0];
  assert.equal(row.twilio_call_sid, 'v3:live-1');
  assert.equal(row.status, 'ringing');
});

test('placeCall through Telnyx: a rejected call is marked failed and nothing is left ringing', async () => {
  const db = database({ phone_lines: [{ user_id: 'user-1', mode: 'rent', phone_number: '+2348011112222', status: 'rented' }] });
  const fetcher = async () => json(401, { errors: [{ code: '10009', title: 'Authentication failed', detail: 'bad key' }] });
  const { placeCall } = await loadApi('lib/phoneCalls.js', db, fetcher, { ...ENV, TELEPHONY_PROVIDER: 'telnyx' });
  const result = await placeCall(db, 'user-1', { toNumber: '+14155552671', objective: 'x', contactId: null });
  assert.ok(result.error);
  assert.equal(db.tables.calls[0].status, 'failed');
});

test('placeCall with Telnyx selected but not configured says so instead of falling back to Twilio', async () => {
  const db = database({ phone_lines: [{ user_id: 'user-1', mode: 'rent', phone_number: '+2348011112222', status: 'rented' }] });
  const network = [];
  const { placeCall } = await loadApi('lib/phoneCalls.js', db, async (u) => { network.push(u); throw new Error('no network'); }, { TELEPHONY_PROVIDER: 'telnyx' });
  const result = await placeCall(db, 'user-1', { toNumber: '+14155552671', objective: 'x', contactId: null });
  assert.match(result.error, /not configured/);
  assert.equal(network.length, 0);
});

// ---- the phone bridge end to end, with a Telnyx stream -------------------------

import { EventEmitter } from 'node:events';
import { handleTwilioViaPipecat, packFrame, parseFrame } from '../server/twilio-bridge.js';

function fakeSocket() {
  const s = new EventEmitter();
  s.readyState = 1; s.sent = [];
  s.send = (d) => { s.sent.push(d); };
  s.close = () => { s.readyState = 3; s.emit('close'); };
  return s;
}

function startBridge(extraEnv = {}) {
  const phone = fakeSocket();
  const upstreams = [];
  class FakeWS extends EventEmitter {
    constructor(url) { super(); this.url = url; this.readyState = 1; this.sent = []; upstreams.push(this); }
    send(d) { this.sent.push(d); }
    close() { this.readyState = 3; this.emit('close'); }
  }
  const hangups = [];
  const env = { ASSISTANT_BRIDGE_URL: 'wss://assistant.test', ASSISTANT_BRIDGE_SECRET: 'sec', ...extraEnv };
  handleTwilioViaPipecat(phone, { url: '/stream?callId=call-9' }, { WS: FakeWS, env, log: { log() {}, error() {} } });
  return { phone, upstreams, hangups, env };
}

test('bridge: a Telnyx call talks to the assistant and the audio comes back in Telnyx\'s format', () => {
  const { phone, upstreams } = startBridge();
  phone.emit('message', JSON.stringify({ event: 'connected', version: '1.0.0' }));
  assert.equal(upstreams.length, 0, 'the connected frame does not start anything');
  phone.emit('message', JSON.stringify({ event: 'start', sequence_number: '1', stream_id: 'stream-1',
    start: { user_id: 'acct', call_control_id: 'v3:abc', media_format: { encoding: 'PCMU', sample_rate: 8000, channels: 1 } } }));
  assert.equal(upstreams.length, 1);
  const up = upstreams[0];
  assert.equal(up.url, 'wss://assistant.test/stream');
  up.emit('open');
  assert.equal(JSON.parse(up.sent[0]).sessionId, 'call-call-9');
  up.emit('message', Buffer.from(JSON.stringify({ type: 'ready' })), false);
  assert.equal(JSON.parse(up.sent[1]).type, 'call_active');

  // callee audio goes up; our own (outbound track) audio does not
  const payload = Buffer.alloc(160, 0x7f).toString('base64');
  phone.emit('message', JSON.stringify({ event: 'media', stream_id: 'stream-1', media: { track: 'inbound', payload } }));
  phone.emit('message', JSON.stringify({ event: 'media', stream_id: 'stream-1', media: { track: 'outbound', payload } }));
  const audioUp = up.sent.slice(2);
  assert.equal(audioUp.length, 1, 'only the inbound frame is forwarded');
  assert.equal(parseFrame(Buffer.from(audioUp[0])).payload.length, 160);

  // assistant speech goes down as a Telnyx media frame: no streamSid
  const pcm = Buffer.alloc(320);
  up.emit('message', packFrame({ type: 2, encoding: 1, sampleRate: 8000, sequence: 0, payload: pcm }), true);
  const down = JSON.parse(phone.sent.at(-1));
  assert.equal(down.event, 'media');
  assert.equal('streamSid' in down, false);
  assert.equal(Buffer.from(down.media.payload, 'base64').length, 160, '320 bytes of PCM16 = 160 mu-law bytes');

  // barge-in clears the Telnyx queue
  up.emit('message', packFrame({ type: 4, encoding: 1, sampleRate: 8000, sequence: 1, payload: Buffer.alloc(0) }), true);
  assert.deepEqual(JSON.parse(phone.sent.at(-1)), { event: 'clear' });
});

test('bridge: a Twilio call is unchanged (streamSid on every frame)', () => {
  const { phone, upstreams } = startBridge();
  phone.emit('message', JSON.stringify({ event: 'start', start: { streamSid: 'MZ1', callSid: 'CA1' } }));
  const up = upstreams[0];
  up.emit('open');
  up.emit('message', Buffer.from(JSON.stringify({ type: 'ready' })), false);
  up.emit('message', packFrame({ type: 2, encoding: 1, sampleRate: 8000, sequence: 0, payload: Buffer.alloc(320) }), true);
  const down = JSON.parse(phone.sent.at(-1));
  assert.equal(down.streamSid, 'MZ1');
  up.emit('message', packFrame({ type: 4, encoding: 1, sampleRate: 8000, sequence: 1, payload: Buffer.alloc(0) }), true);
  assert.deepEqual(JSON.parse(phone.sent.at(-1)), { event: 'clear', streamSid: 'MZ1' });
});

test('bridge: when the assistant ends a Telnyx call, Telnyx is told to hang up (not Twilio)', async () => {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => { calls.push({ url, opts }); return json(200, {}); };
  try {
    const { phone, upstreams } = startBridge({ TELNYX_API_KEY: 'KEY-test', TELNYX_ACCOUNT_ID: 'acct-uuid', SIGNALWIRE_SPACE: 'x.signalwire.com', SIGNALWIRE_PROJECT_ID: 'p1', SIGNALWIRE_API_TOKEN: 'tok' });
    phone.emit('message', JSON.stringify({ event: 'start', stream_id: 's', start: { user_id: 'u', call_control_id: 'v3:end-me', media_format: { encoding: 'PCMU', sample_rate: 8000, channels: 1 } } }));
    const up = upstreams[0];
    up.emit('open');
    up.emit('message', Buffer.from(JSON.stringify({ type: 'hangup' })), false);
    await new Promise((r) => setTimeout(r, 20));
    // The bridge asks for the hangup when the assistant says so and again when the socket closes (same as for
    // Twilio); the second is harmless. What matters: every request goes to Telnyx, none to Twilio.
    assert.ok(calls.length >= 1);
    for (const c of calls) assert.match(c.url, /^https:\/\/api\.telnyx\.com\/v2\/texml\/Accounts\/acct-uuid\/Calls\/v3%3Aend-me$/);
    assert.equal(calls.filter((c) => c.url.includes('signalwire.com')).length, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});
