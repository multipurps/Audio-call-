import test from 'node:test';
import assert from 'node:assert/strict';
import { phoneCheck } from '../lib/phoneCheck.js';

const env = { SIGNALWIRE_SPACE: 'x.signalwire.com', SIGNALWIRE_PROJECT_ID: 'p1', SIGNALWIRE_API_TOKEN: 't' };
const fakeFetch = (routes) => async (url) => {
  const hit = Object.entries(routes).find(([k]) => url.includes(k));
  const body = hit ? hit[1] : {};
  return { ok: true, status: 200, text: async () => JSON.stringify(body) };
};

test('phone check flags a FROM number that SignalWire does not own', async () => {
  const r = await phoneCheck({ env, appLines: ['+2348012345678'], fetchImpl: fakeFetch({
    '/IncomingPhoneNumbers': { incoming_phone_numbers: [{ phone_number: '+15550001111', capabilities: { voice: true } }] },
    '/OutgoingCallerIds': { outgoing_caller_ids: [] },
    '/Calls.json': { calls: [{ sid: 'CA1', to: '+1555', from: '+234', status: 'no-answer', duration: '0' }] },
  }) });
  assert.match(r.problems[0], /neither a number in this SignalWire project nor a verified caller ID/);
  assert.equal(r.recentCalls[0].status, 'no-answer');
});

test('phone check states plainly when the FROM number is only a verified caller ID', async () => {
  const r = await phoneCheck({ env, appLines: ['+2348012345678'], fetchImpl: fakeFetch({
    '/OutgoingCallerIds': { outgoing_caller_ids: [{ phone_number: '+2348012345678' }] },
  }) });
  assert.match(r.problems[0], /only a verified caller ID/);
  assert.equal(r.lines[0].verifiedCallerId, true);
});

test('phone check reports a clean setup when the number is owned with voice', async () => {
  const r = await phoneCheck({ env, appLines: ['+15550001111'], fetchImpl: fakeFetch({
    '/IncomingPhoneNumbers': { incoming_phone_numbers: [{ phone_number: '+15550001111', capabilities: { voice: true } }] },
  }) });
  assert.deepEqual(r.problems, []);
});

test('phone check says so when SignalWire is not configured', async () => {
  const r = await phoneCheck({ env: {}, appLines: [] });
  assert.equal(r.configured, false);
});
