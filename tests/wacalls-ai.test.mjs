import test from 'node:test';
import assert from 'node:assert/strict';
import { database, loadApi, request } from './helpers.mjs';

const ENV = { WACALLS_RELAY_URL: 'https://relay.test', WACALLS_INTERNAL_SECRET: 'secret-test-value' };

function fixture({ start, attach, hangup, history } = {}) {
  const db = database({
    whatsapp_accounts: [{ user_id: 'user-1', wacalls_session_id: 'wa-sess-1', status: 'connected' }],
    chat_sessions: [{ id: 'chat-1', user_id: 'user-1', title: 'New chat', archived: false }],
  });
  const calls = [];
  const fetcher = async (url, options = {}) => {
    const path = url.replace('https://relay.test', '');
    calls.push({ path, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null, timeoutSignal: options.signal });
    let handler;
    if (path.endsWith('/history')) handler = history;
    else if (path.endsWith('/calls') && options.method === 'POST') handler = start;
    else if (path.endsWith('/ai')) handler = attach;
    else if (options.method === 'DELETE') handler = hangup;
    const result = handler ? await handler() : { status: 200, body: {} };
    return { ok: result.status < 400, status: result.status, json: async () => result.body };
  };
  return { db, calls, fetcher };
}
const ok = (body) => async () => ({ status: 200, body });
const fail = (status, error) => async () => ({ status, body: { error } });

async function place(f, body = { platform: 'whatsapp', to: '+1 415 555 2671', sessionId: 'chat-1' }) {
  const { default: handler } = await loadApi('api/social-calling.js', f.db, f.fetcher, ENV);
  return request(handler, 'call', body);
}

test('placing a WhatsApp call starts it and attaches the assistant to the SAME call id', async () => {
  const f = fixture({ start: ok({ call: { callId: 'call-42' } }), attach: ok({ status: 'attached' }) });
  const res = await place(f);
  assert.equal(res.code, 200);
  assert.equal(res.data.callId, 'call-42');
  assert.equal(res.data.aiAttached, true);
  assert.deepEqual(f.calls.map((c) => `${c.method} ${c.path}`), [
    'POST /api/sessions/wa-sess-1/calls',
    'POST /api/sessions/wa-sess-1/calls/call-42/ai',
  ]);
  const attach = f.calls[1].body;
  assert.equal(attach.sessionId, 'chat-1');
  assert.equal(attach.peerNumber, '+1 415 555 2671');
});

test('the attach request is allowed longer than the relay needs to retry a cold assistant', async () => {
  const src = await import('node:fs/promises').then((m) => m.readFile(new URL('../lib/wacallsClient.js', import.meta.url), 'utf8'));
  const timeout = Number(/ATTACH_TIMEOUT_MS = ([\d_]+)/.exec(src)[1].replaceAll('_', ''));
  // aibridge.go: 5 dial attempts x 6s + 4 gaps x 4s = 46s worst case
  assert.ok(timeout > 46_000, 'attach fetch must outlive the relay dial retries');
  assert.ok(timeout < 60_000, 'and stay under the 60s Vercel function limit');
});

test('a start response without a call id is an error, and nothing is attached', async () => {
  const f = fixture({ start: ok({}) });
  const res = await place(f);
  assert.equal(res.code, 502);
  assert.match(res.data.error, /call id/);
  assert.equal(f.calls.length, 1);
});

test('a definite attach failure hangs the call up and reports it', async () => {
  const f = fixture({ start: ok({ call: { callId: 'call-7' } }), attach: fail(500, 'assistant unreachable'), hangup: ok({ status: 'ok' }) });
  const res = await place(f);
  assert.equal(res.code, 500);
  assert.match(res.data.error, /assistant could not join/);
  assert.match(res.data.error, /I hung up/);
  assert.equal(f.calls.at(-1).method, 'DELETE');
  assert.equal(f.calls.at(-1).path, '/api/sessions/wa-sess-1/calls/call-7');
});

test('if the hangup also fails the user is told to hang up manually', async () => {
  const f = fixture({ start: ok({ call: { callId: 'call-7' } }), attach: fail(502, 'bridge down'), hangup: fail(500, 'boom') });
  const res = await place(f);
  assert.match(res.data.error, /hang up manually/);
});

test('an attach timeout leaves the call up and reports it as unconfirmed', async () => {
  const f = fixture({ start: ok({ call: { callId: 'call-9' } }) });
  const base = f.fetcher;
  f.fetcher = async (url, options) => {
    if (url.endsWith('/ai')) { const e = new Error('The operation timed out'); e.name = 'TimeoutError'; throw e; }
    return base(url, options);
  };
  const res = await place(f);
  assert.equal(res.code, 200);
  assert.equal(res.data.aiAttached, 'unconfirmed');
  assert.ok(!f.calls.some((c) => c.method === 'DELETE'), 'must not hang up a call the relay may still connect');
});

test('a dead relay session clears the stored id instead of failing every call', async () => {
  const f = fixture({ start: fail(404, 'no such session') });
  const res = await place(f);
  assert.equal(res.code, 409);
  assert.equal(f.db.tables.whatsapp_accounts[0].wacalls_session_id, null);
});

test('logs never contain the secret or the full phone number', async () => {
  const lines = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = (...a) => lines.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
  try {
    const f = fixture({ start: ok({ call: { callId: 'call-1' } }), attach: fail(500, 'nope'), hangup: ok({}) });
    await place(f);
  } finally { Object.assign(console, orig); }
  const text = lines.join('\n');
  assert.ok(text.includes('call-1'));
  assert.ok(!text.includes('secret-test-value'));
  assert.ok(!text.includes('4155552671') && !text.includes('415 555'));
});

test('the assistant chat path attaches the AI and tells the user when it cannot', async () => {
  const f = fixture({ start: ok({ call: { callId: 'call-3' } }), attach: fail(500, 'assistant unreachable'), hangup: ok({}) });
  f.db.tables.contacts = [{ id: 'c1', user_id: 'user-1', name: 'Alex', phone_number: '+1 (415) 555-2671' }];
  const wrapped = f.fetcher;
  f.fetcher = async (url, options) => {
    if (url.includes('api.openai.com')) {
      const body = JSON.parse(options.body);
      const intent = { action: 'call', contactName: 'Alex', objective: 'Confirm lunch at noon.', channel: 'whatsapp' };
      return { ok: true, json: async () => ({ choices: [{ message: { content: body.response_format ? JSON.stringify(intent) : 'ok' } }] }) };
    }
    return wrapped(url, options);
  };
  const { default: handler } = await loadApi('api/assistant.js', f.db, f.fetcher, ENV);
  const res = await request(handler, 'send', { text: 'Call Alex and confirm lunch at noon.', channel: 'whatsapp', target: { contactId: 'c1' } });
  const paths = f.calls.map((c) => `${c.method} ${c.path}`);
  assert.ok(paths.includes('POST /api/sessions/wa-sess-1/calls/call-3/ai'), `attach never requested: ${paths}`);
  assert.ok(paths.includes('DELETE /api/sessions/wa-sess-1/calls/call-3'));
  const said = JSON.stringify(res.data);
  assert.ok(!/Calling Alex on WhatsApp/.test(said), 'must not claim the call is going ahead');
});

test('"no such call" + a call the relay says ended reports the real reason, does not hang up, and keeps the WhatsApp link', async () => {
  const f = fixture({
    start: ok({ call: { callId: 'call-5' } }),
    attach: fail(404, 'no such call'),
    history: ok({ rows: [{ callId: 'call-5', endedAt: 1, endReason: 'declined' }] }),
    hangup: ok({}),
  });
  const res = await place(f);
  assert.equal(res.code, 502, 'a call-level 404 must not be surfaced as a dead session');
  assert.match(res.data.error, /ended before the assistant could join/);
  assert.match(res.data.error, /declined/);
  assert.ok(!f.calls.some((c) => c.method === 'DELETE'), 'nothing to hang up - the call already ended');
  assert.equal(f.db.tables.whatsapp_accounts[0].wacalls_session_id, 'wa-sess-1', 'session must not be cleared');
});

test('"no such call" while the call is still live is retried once and then succeeds', async () => {
  let attaches = 0;
  const f = fixture({
    start: ok({ call: { callId: 'call-6' } }),
    attach: async () => (++attaches === 1 ? { status: 404, body: { error: 'no such call' } } : { status: 200, body: { status: 'attached' } }),
    history: ok({ rows: [{ callId: 'call-6' }] }),
  });
  const res = await place(f);
  assert.equal(res.code, 200);
  assert.equal(res.data.aiAttached, true);
  assert.equal(attaches, 2);
});

test('if the history lookup itself fails, the failure is still reported (after one retry) and the call is hung up', async () => {
  const f = fixture({
    start: ok({ call: { callId: 'call-8' } }),
    attach: fail(404, 'no such call'),
    history: fail(500, 'boom'),
    hangup: ok({}),
  });
  const res = await place(f);
  assert.equal(res.code, 502);
  assert.match(res.data.error, /assistant could not join/);
  assert.equal(f.db.tables.whatsapp_accounts[0].wacalls_session_id, 'wa-sess-1');
});
