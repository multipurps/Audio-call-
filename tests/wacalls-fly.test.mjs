import test from 'node:test';
import assert from 'node:assert/strict';
import { flyConfig, startFlyCall, submitFlyOffer, flyVideoStart, flyVideoAccept, flyVideoStop, flyEndCall } from '../lib/wacallsFly.js';

const env = { WACALLS_FLY_URL: 'https://wacalls-zeeyus12.fly.dev/', WACALLS_FLY_API_KEY: 'k-123', WACALLS_FLY_SESSION_ID: 'sess-1' };

function fake(responses = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : undefined });
    const key = `${init.method || 'GET'} ${new URL(url).pathname}`;
    const r = responses[key] || { status: 200, body: {} };
    return { ok: r.status < 300, status: r.status, text: async () => JSON.stringify(r.body) };
  };
  return { fetchImpl, calls };
}

test('config: all three settings are required and the URL has no trailing slash', () => {
  assert.throws(() => flyConfig({}), /not configured/);
  assert.throws(() => flyConfig({ WACALLS_FLY_URL: 'x', WACALLS_FLY_API_KEY: 'k' }), /not configured/);
  assert.equal(flyConfig(env).baseUrl, 'https://wacalls-zeeyus12.fly.dev');
});

test('start: posts phone and video to the session, sends the key, returns the call id', async () => {
  const f = fake({ 'POST /api/sessions/sess-1/calls': { status: 200, body: { call: { callId: 'c-9' } } } });
  const out = await startFlyCall({ phone: '2348000000000', video: true, env, fetchImpl: f.fetchImpl });
  assert.deepEqual(out, { callId: 'c-9' });
  assert.equal(f.calls[0].url, 'https://wacalls-zeeyus12.fly.dev/api/sessions/sess-1/calls');
  assert.equal(f.calls[0].headers['X-API-Key'], 'k-123');
  assert.deepEqual(f.calls[0].body, { phone: '2348000000000', video: true });
});

test('start: a busy or refused call is reported with WaCalls’ own message', async () => {
  const f = fake({ 'POST /api/sessions/sess-1/calls': { status: 409, body: { error: 'operator already on a call' } } });
  await assert.rejects(startFlyCall({ phone: '1', env, fetchImpl: f.fetchImpl }), /operator already on a call/);
});

test('offer: sends sdp_offer to webrtc and returns the answer; renegotiate uses its own route', async () => {
  const f = fake({
    'POST /api/sessions/sess-1/calls/c-9/webrtc': { status: 200, body: { sdp_answer: 'ANS' } },
    'POST /api/sessions/sess-1/calls/c-9/webrtc/renegotiate': { status: 200, body: { sdp_answer: 'ANS2' } },
  });
  assert.deepEqual(await submitFlyOffer({ callId: 'c-9', sdpOffer: 'OFF', env, fetchImpl: f.fetchImpl }), { sdpAnswer: 'ANS' });
  assert.deepEqual(f.calls[0].body, { sdp_offer: 'OFF' });
  assert.deepEqual(await submitFlyOffer({ callId: 'c-9', sdpOffer: 'OFF2', renegotiate: true, env, fetchImpl: f.fetchImpl }), { sdpAnswer: 'ANS2' });
  assert.match(f.calls[1].url, /\/webrtc\/renegotiate$/);
});

test('video: start, accept and stop use the call’s video routes; end uses DELETE', async () => {
  const f = fake();
  await flyVideoStart({ callId: 'c-9', env, fetchImpl: f.fetchImpl });
  await flyVideoAccept({ callId: 'c-9', env, fetchImpl: f.fetchImpl });
  await flyVideoStop({ callId: 'c-9', env, fetchImpl: f.fetchImpl });
  await flyEndCall({ callId: 'c-9', env, fetchImpl: f.fetchImpl });
  assert.deepEqual(f.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`), [
    'POST /api/sessions/sess-1/calls/c-9/video/start',
    'POST /api/sessions/sess-1/calls/c-9/video/accept',
    'POST /api/sessions/sess-1/calls/c-9/video/stop',
    'DELETE /api/sessions/sess-1/calls/c-9',
  ]);
});
