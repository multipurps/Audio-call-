// The browser listen-in token: a short-lived HMAC grant per call, scoped to
// that call's monitor session, minted only for the owning user's live calls.
// The signature scheme must stay byte-identical to the pipecat service's
// verify_monitor_token (pipecat-service/app/monitor.py):
//   token = `${exp}.${userId}.${hex(hmac_sha256(SECRET, `monitor:${sessionId}:${userId}:${exp}`))}`
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { database, loadApi, request } from './helpers.mjs';

const SECRET = 'monitor-secret-test';
const ENV = {
  ASSISTANT_BRIDGE_SECRET: SECRET,
  PUBLIC_ASSISTANT_WS_URL: 'wss://assistant.test/stream',
  OPENAI_API_KEY: 'test-only',
};

function fixture(extra = {}) {
  const db = database({
    calls: [
      {
        id: 'call-live', user_id: 'user-1', platform: 'whatsapp', to_number: '+15550001',
        platform_call_id: '42', status: 'in_progress', transcript: [],
        created_at: new Date().toISOString(),
      },
      {
        id: 'call-done', user_id: 'user-1', platform: 'whatsapp', to_number: '+15550001',
        platform_call_id: '43', status: 'completed', transcript: [],
        created_at: new Date().toISOString(),
      },
      {
        id: 'call-phone', user_id: 'user-1', platform: 'twilio', to_number: '+15550001',
        platform_call_id: null, status: 'in_progress', transcript: [],
        created_at: new Date().toISOString(),
      },
      {
        id: 'call-foreign', user_id: 'user-2', platform: 'whatsapp', to_number: '+15550001',
        platform_call_id: '44', status: 'in_progress', transcript: [],
        created_at: new Date().toISOString(),
      },
    ],
  });
  return { db, extra };
}

async function setup(env = ENV) {
  const f = fixture();
  const { default: handler } = await loadApi('api/calls.js', f.db, async (url) => {
    throw new Error(`Unexpected external call: ${url}`);
  }, env);
  return { ...f, handler };
}

test('monitor-token mints a per-call grant matching the pipecat HMAC scheme exactly', async () => {
  const f = await setup();
  const res = await request(f.handler, 'monitor-token', { callId: 'call-live' });
  assert.equal(res.code, 200, JSON.stringify(res.data));
  const { token, sessionId, url, sampleRate } = res.data;
  assert.equal(sessionId, 'call-42');
  assert.equal(sampleRate, 16000);

  // Shape: exp.user.sig
  const parts = token.split('.');
  assert.equal(parts.length, 3);
  const [exp, userId, sig] = parts;
  assert.equal(userId, 'user-1');
  assert.ok(Number(exp) > Date.now() / 1000, 'token must be a future expiry');

  // Signature: HMAC-SHA256(secret, `monitor:${sessionId}:${userId}:${exp}`)
  const expected = createHmac('sha256', SECRET)
    .update(`monitor:${sessionId}:${userId}:${exp}`)
    .digest('hex');
  assert.equal(sig, expected, 'JS mint must verify against Python verify_monitor_token');

  // URL: browser-reachable ws base with /stream swapped for /monitor.
  assert.ok(url.startsWith('wss://assistant.test/monitor/call-42?token='), url);
  assert.ok(url.includes(encodeURIComponent(token)));
});

test('monitor-token only serves the call\'s owner', async () => {
  const f = await setup();
  assert.equal((await request(f.handler, 'monitor-token', { callId: 'call-foreign' })).code, 404);
  assert.equal((await request(f.handler, 'monitor-token', { callId: 'nope' })).code, 404);
});

test('monitor-token refuses finished calls and lines with no monitor stream', async () => {
  const f = await setup();
  const done = await request(f.handler, 'monitor-token', { callId: 'call-done' });
  assert.equal(done.code, 409);
  assert.match(done.data.error, /not live/i);
  // Phone calls only expose a monitor stream once bridged to the assistant
  // service (TWILIO_VIA_PIPECAT) — say so instead of handing back a dead socket.
  const phone = await request(f.handler, 'monitor-token', { callId: 'call-phone' });
  assert.equal(phone.code, 409);
  assert.match(phone.data.error, /not enabled/i);
});

test('monitor-token reports missing configuration honestly', async () => {
  const f = await setup({ OPENAI_API_KEY: 'test-only' });
  const res = await request(f.handler, 'monitor-token', { callId: 'call-live' });
  assert.equal(res.code, 501);
  assert.match(res.data.error, /not configured/i);
});

test('monitor-token requires authentication and a call id', async () => {
  const f = await setup();
  assert.equal((await request(f.handler, 'monitor-token', { callId: 'call-live' }, { auth: false })).code, 401);
  assert.equal((await request(f.handler, 'monitor-token', {})).code, 400);
  assert.equal((await request(f.handler, 'monitor-token', { callId: 'call-live' }, { method: 'GET' })).code, 405);
});
