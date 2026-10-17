import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hangupPipecatSession, pipecatHttpBase } from '../lib/pipecatHangup.js';

const ENV = { ASSISTANT_BRIDGE_URL: 'wss://emysa-pipecat.example.com/stream', ASSISTANT_BRIDGE_SECRET: 's3cret' };

function fakeFetch(status, { throwWith } = {}) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    if (throwWith) throw throwWith;
    return { status, ok: status >= 200 && status < 300 };
  };
  return { fn, calls };
}

test('base URL is derived from the websocket bridge URL', () => {
  assert.equal(pipecatHttpBase(ENV), 'https://emysa-pipecat.example.com');
  assert.equal(pipecatHttpBase({ ASSISTANT_BRIDGE_URL: 'ws://localhost:8000/stream/' }), 'http://localhost:8000');
  assert.equal(pipecatHttpBase({}), null);
});

test('posts the hangup to the call session with the bridge secret as bearer', async () => {
  const { fn, calls } = fakeFetch(200);
  const r = await hangupPipecatSession('WA-123', { env: ENV, fetchImpl: fn });
  assert.equal(r.ok, true);
  assert.equal(r.found, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://emysa-pipecat.example.com/calls/call-WA-123/hangup');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer s3cret');
});

test('404 means no live session: success with found=false, not an error', async () => {
  const { fn } = fakeFetch(404);
  const r = await hangupPipecatSession('gone', { env: ENV, fetchImpl: fn });
  assert.deepEqual(r, { ok: true, found: false });
});

test('a server error is reported with its status, never thrown', async () => {
  const { fn } = fakeFetch(500);
  const r = await hangupPipecatSession('x', { env: ENV, fetchImpl: fn });
  assert.equal(r.ok, false);
  assert.equal(r.httpStatus, 500);
});

test('a network failure is reported with a reason, never thrown', async () => {
  const { fn } = fakeFetch(0, { throwWith: new Error('socket hang up') });
  const r = await hangupPipecatSession('x', { env: ENV, fetchImpl: fn });
  assert.equal(r.ok, false);
  assert.match(r.error, /socket hang up/);
});

test('unconfigured deployment is skipped, not failed, and makes no request', async () => {
  const { fn, calls } = fakeFetch(200);
  const r = await hangupPipecatSession('x', { env: {}, fetchImpl: fn });
  assert.equal(r.skipped, true);
  assert.equal(calls.length, 0);
});

test('a missing session key is skipped without a request', async () => {
  const { fn, calls } = fakeFetch(200);
  const r = await hangupPipecatSession(null, { env: ENV, fetchImpl: fn });
  assert.equal(r.skipped, true);
  assert.equal(calls.length, 0);
});
