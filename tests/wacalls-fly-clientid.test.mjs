import test from 'node:test';
import assert from 'node:assert/strict';
import {
  startFlyCall, submitFlyOffer, flyVideoStart, flyVideoAccept, flyVideoStop, flyEndCall, flyCallState, flyClearCalls,
  flyCreateSession, flyDeleteSession,
} from '../lib/wacallsFly.js';

const env = { WACALLS_FLY_URL: 'https://wacalls.example.test/', WACALLS_FLY_API_KEY: 'k-123' };

// Records each request's path and headers; answers every call with a small JSON body.
function recorder() {
  const seen = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    seen.push({ method: init.method || 'GET', path: u.pathname, headers: init.headers || {} });
    return new Response(JSON.stringify({ id: 'x', call: { callId: 'c-9' }, sdp_answer: 'ANS', state: 'ended' }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  };
  return { fetchImpl, seen };
}

test('every call-level request carries the signed-in person as X-Client-Id', async () => {
  const r = recorder();
  const clientId = 'user-42';
  await startFlyCall({ sid: 'sess-A', phone: '2348', video: false, clientId, env, fetchImpl: r.fetchImpl });
  await submitFlyOffer({ sid: 'sess-A', callId: 'c-9', sdpOffer: 'OFF', clientId, env, fetchImpl: r.fetchImpl });
  await submitFlyOffer({ sid: 'sess-A', callId: 'c-9', sdpOffer: 'OFF2', renegotiate: true, clientId, env, fetchImpl: r.fetchImpl });
  await flyVideoStart({ sid: 'sess-A', callId: 'c-9', clientId, env, fetchImpl: r.fetchImpl });
  await flyVideoAccept({ sid: 'sess-A', callId: 'c-9', clientId, env, fetchImpl: r.fetchImpl });
  await flyVideoStop({ sid: 'sess-A', callId: 'c-9', clientId, env, fetchImpl: r.fetchImpl });
  await flyCallState({ sid: 'sess-A', callId: 'c-9', clientId, env, fetchImpl: r.fetchImpl });
  await flyClearCalls({ sid: 'sess-A', clientId, env, fetchImpl: r.fetchImpl });
  await flyEndCall({ sid: 'sess-A', callId: 'c-9', clientId, env, fetchImpl: r.fetchImpl });

  assert.equal(r.seen.length, 9);
  for (const req of r.seen) {
    assert.equal(req.headers['X-Client-Id'], clientId, `${req.method} ${req.path} should carry X-Client-Id`);
    assert.equal(req.headers['X-API-Key'], 'k-123');
  }
});

test('session-level requests do not send X-Client-Id', async () => {
  const r = recorder();
  await flyCreateSession({ name: 'user-42', env, fetchImpl: r.fetchImpl });
  await flyDeleteSession({ sid: 'sess-A', env, fetchImpl: r.fetchImpl });
  for (const req of r.seen) {
    assert.equal('X-Client-Id' in req.headers, false, `${req.method} ${req.path} should not carry X-Client-Id`);
  }
});

test('a call without clientId sends no X-Client-Id header', async () => {
  const r = recorder();
  await flyCallState({ sid: 'sess-A', callId: 'c-9', env, fetchImpl: r.fetchImpl });
  assert.equal('X-Client-Id' in r.seen[0].headers, false);
});
