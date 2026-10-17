import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

process.env.WACALLS_RELAY_URL = 'https://relay.test';
process.env.WACALLS_INTERNAL_SECRET = 'x';

// Minimal fake of the supabase query builder used by releaseLeftoverWhatsappCalls.
let dbRows = [];
const updates = [];
const fakeDb = {
  from() {
    const q = {
      select() { return q; }, eq() { return q; }, not() { return q; }, gte() { return q; }, order() { return q; },
      limit() { return Promise.resolve({ data: dbRows }); },
      update(v) { updates.push(v); return { eq() { return { in() { return Promise.resolve({}); } }; } }; },
    };
    return q;
  },
};
mock.module(new URL('../lib/supabaseAdmin.js', import.meta.url).href, { namedExports: { getServiceClient: () => fakeDb, getAuthedUserId: async () => null } });
mock.module(new URL('../lib/voiceChoice.js', import.meta.url).href, { namedExports: { resolveVoiceChoice: async () => ({ mode: 'standard', provider: 'test', source: 'test' }) } });
const { wacallsPlaceAICall } = await import('../lib/wacallsClient.js');

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
const FAST = { busyRetryWaitsMs: [1, 1, 1] };

test('busy because of a stale call: it is hung up on the relay and the retry places the call', async () => {
  dbRows = [{ id: 'row1', status: 'ringing', platform_call_id: 'old1', created_at: iso(10 * 60_000) }];
  updates.length = 0;
  const realFetch = globalThis.fetch;
  const hungUp = [];
  let starts = 0;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (init.method === 'DELETE') { hungUp.push(u.split('/').pop()); return new Response(null, { status: 204 }); }
    if (u.endsWith('/calls') && init.method === 'POST') { starts += 1; return starts === 1 ? json(409, { error: 'operator already on a call' }) : json(200, { call: { callId: 'c2' } }); }
    if (u.endsWith('/calls/c2/ai')) return json(200, { status: 'attached' });
    return json(404, { error: 'unexpected ' + u });
  };
  try {
    const out = await wacallsPlaceAICall('u1', 's1', '+2348000000000', FAST);
    assert.equal(out.callId, 'c2');
    assert.deepEqual(hungUp, ['old1']);
    assert.equal(updates[0]?.status, 'canceled');
  } finally { globalThis.fetch = realFetch; }
});

test('a call that is still dialling or connected is not cut; the message says so', async () => {
  dbRows = [{ id: 'row2', status: 'ringing', platform_call_id: 'live1', created_at: iso(20_000) }];
  const realFetch = globalThis.fetch;
  const hungUp = [];
  globalThis.fetch = async (url, init = {}) => {
    if (init.method === 'DELETE') { hungUp.push(String(url)); return new Response(null, { status: 204 }); }
    return json(409, { error: 'operator already on a call' });
  };
  try {
    await assert.rejects(wacallsPlaceAICall('u1', 's1', '+2348000000000', FAST),
      (e) => e.statusCode === 409 && /still on another call/.test(e.message) && !/operator/.test(e.message));
    assert.equal(hungUp.length, 0);
  } finally { globalThis.fetch = realFetch; }
});

test('busy with nothing we can clear: friendly message, never the raw relay text', async () => {
  dbRows = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => json(409, { error: 'operator already on a call' });
  try {
    await assert.rejects(wacallsPlaceAICall('u1', 's1', '+2348000000000', FAST),
      (e) => e.statusCode === 409 && /still being closed/.test(e.message) && !/operator/.test(e.message));
  } finally { globalThis.fetch = realFetch; }
});

test('other errors are not swallowed', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => json(503, { error: 'not paired' });
  try {
    await assert.rejects(wacallsPlaceAICall('u1', 's1', '+2348000000000', FAST), (e) => e.statusCode === 503);
  } finally { globalThis.fetch = realFetch; }
});

test('the relay is woken with a read BEFORE the call is placed', async () => {
  dbRows = [];
  const realFetch = globalThis.fetch;
  const order = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.endsWith('/api/sessions/s1') && (init.method || 'GET') === 'GET') { order.push('wake'); return json(200, { id: 's1' }); }
    if (u.endsWith('/calls') && init.method === 'POST') { order.push('dial'); return json(200, { callId: 'c9' }); }
    if (u.endsWith('/calls/c9/ai')) return json(200, { status: 'attached' });
    return json(404, { error: 'unexpected ' + u });
  };
  try {
    const out = await wacallsPlaceAICall('u1', 's1', '+2348000000000', FAST);
    assert.equal(out.callId, 'c9');
    assert.deepEqual(order, ['wake', 'dial']);
  } finally { globalThis.fetch = realFetch; }
});

test('a relay that is still waking does not stop the call, and the call is dialled exactly once', async () => {
  dbRows = [];
  const realFetch = globalThis.fetch;
  let dials = 0;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.endsWith('/api/sessions/s1') && (init.method || 'GET') === 'GET') throw Object.assign(new Error('timed out'), { name: 'AbortError' });
    if (u.endsWith('/calls') && init.method === 'POST') { dials += 1; return json(200, { callId: 'c10' }); }
    if (u.endsWith('/calls/c10/ai')) return json(200, { status: 'attached' });
    return json(404, { error: 'unexpected ' + u });
  };
  try {
    const out = await wacallsPlaceAICall('u1', 's1', '+2348000000000', FAST);
    assert.equal(out.callId, 'c10');
    assert.equal(dials, 1);
  } finally { globalThis.fetch = realFetch; }
});

test('a dial that times out is NOT retried (could ring the person twice)', async () => {
  dbRows = [];
  const realFetch = globalThis.fetch;
  let dials = 0;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.endsWith('/calls') && init.method === 'POST') { dials += 1; throw Object.assign(new Error('timed out'), { name: 'AbortError' }); }
    return json(200, { id: 's1' });
  };
  try {
    await assert.rejects(wacallsPlaceAICall('u1', 's1', '+2348000000000', FAST), (e) => e.name === 'AbortError');
    assert.equal(dials, 1);
  } finally { globalThis.fetch = realFetch; }
});
