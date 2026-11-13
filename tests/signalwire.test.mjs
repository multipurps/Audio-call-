// SignalWire as the phone provider (the default). Twilio-compatible REST API; see lib/telephony.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  telephonyProvider, signalwireConfigured, lamlBase, lamlAuthHeader, lamlRequest,
  signalwireDial, signalwireHangup, hangupCall, webhookToken, checkWebhookToken,
} from '../lib/telephony.js';
import { streamStart } from '../server/streamProtocol.js';

const ENV = { SIGNALWIRE_SPACE: 'demo.signalwire.com', SIGNALWIRE_PROJECT_ID: 'proj-1', SIGNALWIRE_API_TOKEN: 'PT-secret' };

test('SignalWire needs a space, a project id and a token', () => {
  assert.equal(signalwireConfigured(ENV), true);
  assert.equal(signalwireConfigured({ ...ENV, SIGNALWIRE_API_TOKEN: '' }), false);
  assert.equal(signalwireConfigured({}), false);
});

test('the account URL tolerates a pasted https:// prefix and trailing slash', () => {
  assert.equal(lamlBase(ENV), 'https://demo.signalwire.com/api/laml/2010-04-01/Accounts/proj-1');
  assert.equal(lamlBase({ ...ENV, SIGNALWIRE_SPACE: 'https://demo.signalwire.com/' }), 'https://demo.signalwire.com/api/laml/2010-04-01/Accounts/proj-1');
  assert.equal(lamlAuthHeader(ENV), 'Basic ' + Buffer.from('proj-1:PT-secret').toString('base64'));
});

test('signalwireDial posts the call with both callbacks carrying a per-call token', async () => {
  let seen;
  const fetchImpl = async (url, opts) => { seen = { url, opts }; return { ok: true, status: 201, json: async () => ({ sid: 'sw-call-1', status: 'queued' }) }; };
  const r = await signalwireDial({ to: '+15550001', from: '+15550002', callId: 'call-9', appUrl: 'https://app.test', record: false, ringSeconds: 30 }, ENV, fetchImpl);
  assert.deepEqual(r, { ok: true, sid: 'sw-call-1', status: 'queued' });
  assert.equal(seen.url, 'https://demo.signalwire.com/api/laml/2010-04-01/Accounts/proj-1/Calls.json');
  assert.equal(seen.opts.headers.Authorization, lamlAuthHeader(ENV));
  const body = seen.opts.body;
  const token = webhookToken('call:call-9', ENV);
  assert.equal(body.get('To'), '+15550001');
  assert.equal(body.get('From'), '+15550002');
  assert.equal(body.get('Url'), `https://app.test/api/calls-twiml?callId=call-9&t=${token}`);
  assert.equal(body.get('StatusCallback'), `https://app.test/api/calls-status?callId=call-9&t=${token}`);
  assert.equal(body.get('Record'), 'false');
  assert.equal(body.get('Timeout'), '30');
  assert.equal(body.get('MachineDetection'), 'Enable');
  assert.equal(checkWebhookToken('call:call-9', token, ENV).ok, true);
  assert.equal(checkWebhookToken('call:call-9', 'nope', ENV).ok, false);
});

test('a refused dial reports the carrier code and message', async () => {
  const fetchImpl = async () => ({ ok: false, status: 400, text: async () => JSON.stringify({ code: 21211, message: 'Invalid To number' }) });
  const r = await signalwireDial({ to: 'x', from: 'y', callId: 'c', appUrl: 'https://app.test' }, ENV, fetchImpl);
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
  assert.equal(r.code, 21211);
  assert.equal(r.detail, 'Invalid To number');
});

test('hangup goes to SignalWire for a SignalWire call id and to Telnyx for a Telnyx one', async () => {
  const urls = [];
  const fetchImpl = async (url) => { urls.push(url); return { ok: true, status: 200 }; };
  assert.equal((await hangupCall('sw-call-1', { env: ENV, fetchImpl })).ok, true);
  assert.equal(urls[0], 'https://demo.signalwire.com/api/laml/2010-04-01/Accounts/proj-1/Calls/sw-call-1.json');
  await hangupCall('v3:abc', { env: { TELNYX_API_KEY: 'K', TELNYX_ACCOUNT_ID: 'acct' }, fetchImpl });
  assert.match(urls[1], /api\.telnyx\.com\/v2\/texml\/Accounts\/acct\/Calls\//);
  const unconfigured = await signalwireHangup('sw-call-1', { env: {}, fetchImpl });
  assert.equal(unconfigured.ok, false);
});

test('lamlRequest throws with the carrier code and status when SignalWire refuses', async () => {
  const fetchImpl = async () => ({ ok: false, status: 400, json: async () => ({ code: 21450, message: 'already verified' }) });
  await assert.rejects(() => lamlRequest('OutgoingCallerIds.json', { method: 'POST', body: { PhoneNumber: '+1' }, env: ENV, fetchImpl }),
    (err) => err.code === 21450 && err.statusCode === 400 && /already verified/.test(err.message));
});

test('the SignalWire start frame carries the call id in customParameters', () => {
  const s = streamStart({ event: 'start', start: { streamSid: 'MZ1', callSid: 'sw-call-1', customParameters: { callId: 'call-9' } } });
  assert.equal(s.callSid, 'sw-call-1');
  assert.equal(s.customParameters.callId, 'call-9');
});

test('SignalWire is the default provider', () => {
  assert.equal(telephonyProvider({}), 'signalwire');
});
