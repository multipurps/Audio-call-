import test from 'node:test';
import assert from 'node:assert/strict';
import { placeFlyAICall } from '../lib/wacallsFlyCalls.js';
import { flyAttachAI } from '../lib/wacallsFly.js';

const env = { WACALLS_FLY_URL: 'https://wacalls.example.test/', WACALLS_FLY_API_KEY: 'k-123' };

// Just enough of the Supabase builder for the calls placeFlyAICall makes.
function fakeSupabase({ linked = true } = {}) {
  const updates = [];
  return {
    updates,
    from(table) {
      const q = {
        select() { return q; },
        eq() { return q; },
        in() { return q; },
        maybeSingle() {
          const data = table === 'whatsapp_accounts' && linked ? { wacalls_session_id: 'sid-1' } : null;
          return Promise.resolve({ data, error: null });
        },
        update(patch) {
          const u = {
            eq() { return u; },
            in() { return u; },
            then(res, rej) { updates.push({ table, patch }); return Promise.resolve({ error: null }).then(res, rej); },
          };
          return u;
        },
      };
      return q;
    },
  };
}

function deps(overrides = {}) {
  const calls = { start: [], mark: [], fail: [], attach: [], end: [], clear: [] };
  const d = {
    calls,
    startFlyCall: async (args) => { calls.start.push(args); return { callId: 'c-1' }; },
    markCallPlaced: async (_s, id, patch) => { calls.mark.push({ id, patch }); },
    markCallFailed: async (_s, id, msg) => { calls.fail.push({ id, msg }); },
    flyAttachAI: async (args) => { calls.attach.push(args); return { status: 'attached' }; },
    flyEndCall: async (args) => { calls.end.push(args); },
    flyClearCalls: async (args) => { calls.clear.push(args); },
    ...overrides,
  };
  return d;
}

test('an AI audio call starts on Fly, marks the row, and attaches the assistant with the person as clientId', async () => {
  const d = deps();
  const out = await placeFlyAICall({
    supabase: fakeSupabase(), userId: 'user-1', dbCallId: 'row-1', to: '+2348000000001',
    contactName: 'Ada', appSessionId: 'app-s', voiceId: 'v-9', deps: d,
  });
  assert.deepEqual(out, { callId: 'c-1', dbCallId: 'row-1', aiAttached: true });
  assert.equal(d.calls.start[0].video, false, 'the AI leg is audio only');
  assert.equal(d.calls.start[0].clientId, 'user-1');
  assert.deepEqual(d.calls.mark[0], { id: 'row-1', patch: { platformCallId: 'c-1', status: 'ringing' } });
  assert.equal(d.calls.attach[0].callId, 'c-1');
  assert.equal(d.calls.attach[0].peerNumber, '+2348000000001');
  assert.equal(d.calls.attach[0].voiceId, 'v-9');
  assert.equal(d.calls.end.length, 0, 'a successful call is not ended');
  assert.equal(d.calls.fail.length, 0);
});

test('when the assistant does not attach, the ringing call is ended and the row says so in plain words', async () => {
  const d = deps({
    flyAttachAI: async () => { throw Object.assign(new Error('WaCalls POST /x/ai failed (HTTP 502): could not reach assistant: dial'), { statusCode: 502 }); },
  });
  await assert.rejects(
    placeFlyAICall({ supabase: fakeSupabase(), userId: 'user-1', dbCallId: 'row-2', to: '+2348000000002', deps: d }),
    (err) => err.statusCode === 502 && /AI voice did not connect/.test(err.message),
  );
  assert.deepEqual(d.calls.end[0], { sid: 'sid-1', callId: 'c-1', clientId: 'user-1' });
  assert.match(d.calls.fail[0].msg, /AI voice did not connect/);
  assert.doesNotMatch(d.calls.fail[0].msg, /HTTP|WaCalls|dial/, 'no technical text reaches the person');
});

test('a busy operator on the first start clears this person\'s finished calls and retries once', async () => {
  let n = 0;
  const d = deps({
    startFlyCall: async (args) => {
      n += 1;
      if (n === 1) throw Object.assign(new Error('WaCalls POST /calls failed (HTTP 409): operator already on a call'), { statusCode: 409 });
      return { callId: 'c-2' };
    },
  });
  const out = await placeFlyAICall({ supabase: fakeSupabase(), userId: 'user-3', dbCallId: 'row-3', to: '+2348000000003', deps: d });
  assert.equal(out.callId, 'c-2');
  assert.equal(d.calls.clear[0].clientId, 'user-3');
});

test('a person without a linked WhatsApp is refused before anything is dialed', async () => {
  const d = deps();
  await assert.rejects(
    placeFlyAICall({ supabase: fakeSupabase({ linked: false }), userId: 'user-4', dbCallId: 'row-4', to: '+2348000000004', deps: d }),
    (err) => err.statusCode === 409,
  );
  assert.equal(d.calls.start.length, 0);
});

test('flyAttachAI posts to the call\'s /ai route with the person as X-Client-Id and the context in the body', async () => {
  let seen;
  const fetchImpl = async (url, init = {}) => {
    seen = { url: new URL(url).pathname, method: init.method, headers: init.headers, body: JSON.parse(init.body) };
    return new Response(JSON.stringify({ status: 'attached' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const out = await flyAttachAI({
    sid: 'sid-9', callId: 'c-7', clientId: 'user-7', userId: 'user-7', appSessionId: 'app-7',
    contactName: 'Ben', peerNumber: '+2348000000007', voiceId: undefined, env, fetchImpl,
  });
  assert.equal(out.status, 'attached');
  assert.equal(seen.url, '/api/sessions/sid-9/calls/c-7/ai');
  assert.equal(seen.method, 'POST');
  assert.equal(seen.headers['X-Client-Id'], 'user-7');
  assert.deepEqual(seen.body, { userId: 'user-7', sessionId: 'app-7', contactName: 'Ben', peerNumber: '+2348000000007' }, 'an absent voice is left out');
});
