import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

process.env.WACALLS_RELAY_URL = 'https://relay.test';
process.env.WACALLS_INTERNAL_SECRET = 'x';
mock.module(new URL('../lib/supabaseAdmin.js', import.meta.url).href, { namedExports: { getServiceClient: () => ({}), getAuthedUserId: async () => null } });
mock.module(new URL('../lib/voiceChoice.js', import.meta.url).href, { namedExports: { resolveVoiceChoice: async () => ({ mode: 'standard', provider: 'test', source: 'test' }) } });
const { wacallsPlaceAICall } = await import('../lib/wacallsClient.js');

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

test('operator busy: clears leftover calls, retries once, and the call goes through', async () => {
  const realFetch = globalThis.fetch;
  let starts = 0;
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).endsWith('/calls') && init.method === 'POST') {
      starts += 1;
      return starts === 1 ? json(409, { error: 'operator already on a call' }) : json(200, { call: { callId: 'c2' } });
    }
    if (String(url).endsWith('/calls/c2/ai')) return json(200, { status: 'attached' });
    return json(404, { error: 'unexpected ' + url });
  };
  let cleaned = 0;
  try {
    const out = await wacallsPlaceAICall('u1', 's1', '+2348000000000', { onOperatorBusy: async () => { cleaned += 1; } });
    assert.equal(out.callId, 'c2');
    assert.equal(starts, 2);
    assert.equal(cleaned, 1);
  } finally { globalThis.fetch = realFetch; }
});

test('operator busy twice: friendly message, not the raw relay text', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => json(409, { error: 'operator already on a call' });
  try {
    await assert.rejects(
      wacallsPlaceAICall('u1', 's1', '+2348000000000', { onOperatorBusy: async () => {} }),
      (err) => err.statusCode === 409 && /still being closed/.test(err.message) && !/operator/.test(err.message),
    );
  } finally { globalThis.fetch = realFetch; }
});

test('other errors are not swallowed', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => json(503, { error: 'not paired' });
  try {
    await assert.rejects(wacallsPlaceAICall('u1', 's1', '+2348000000000', { onOperatorBusy: async () => {} }), (e) => e.statusCode === 503);
  } finally { globalThis.fetch = realFetch; }
});
