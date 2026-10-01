import test from 'node:test';
import assert from 'node:assert/strict';
import { sendCallNote, assistantHttpBase } from '../lib/callNote.js';

const env = { PUBLIC_ASSISTANT_WS_URL: 'wss://svc.onrender.com/stream', ASSISTANT_BRIDGE_SECRET: 's'.repeat(32) };

test('converts ws url to http base', () => {
  assert.equal(assistantHttpBase(env), 'https://svc.onrender.com');
});

test('posts note with bearer secret to the call session', async () => {
  let seen;
  const fetchImpl = async (url, opts) => { seen = { url, opts }; return { ok: true, status: 200 }; };
  const r = await sendCallNote({ platform_call_id: 'abc' }, 'hello', { env, fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(seen.url, 'https://svc.onrender.com/calls/call-abc/note');
  assert.equal(seen.opts.headers.Authorization, `Bearer ${env.ASSISTANT_BRIDGE_SECRET}`);
  assert.deepEqual(JSON.parse(seen.opts.body), { text: 'hello' });
});

test('reports unsupported call, not-live and unreachable', async () => {
  assert.equal((await sendCallNote({}, 'x', { env })).ok, false);
  const notLive = await sendCallNote({ platform_call_id: 'a' }, 'x', { env, fetchImpl: async () => ({ ok: false, status: 409 }) });
  assert.match(notLive.error, /not live/);
  const down = await sendCallNote({ platform_call_id: 'a' }, 'x', { env, fetchImpl: async () => { throw new Error('x'); } });
  assert.match(down.error, /could not reach/);
});
