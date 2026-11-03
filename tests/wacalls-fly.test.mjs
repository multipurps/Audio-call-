import test from 'node:test';
import assert from 'node:assert/strict';
import {
  flyEnabled, flyConfig, flyCreateSession, flyListSessions, flyStartPairing, flyPairPhone, flyDeleteSession,
  flyWaitForQr, flySessionDetail, startFlyCall, submitFlyOffer, flyVideoStart, flyVideoAccept, flyVideoStop, flyEndCall,
} from '../lib/wacallsFly.js';

const env = { WACALLS_FLY_URL: 'https://wacalls.example.test/', WACALLS_FLY_API_KEY: 'k-123' };

// Fake WaCalls: JSON routes by "METHOD /path" and an SSE body for /api/events.
function fake(routes = {}, { events = [] } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method || 'GET';
    calls.push({ method, path: u.pathname, headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : undefined });
    if (u.pathname === '/api/events') {
      const body = new ReadableStream({
        start(c) {
          const enc = new TextEncoder();
          for (const ev of events) c.enqueue(enc.encode(`data: ${JSON.stringify(ev)}\n\n`));
          // stays open like the real stream; a client abort ends it, as fetch does
          init.signal?.addEventListener('abort', () => { try { c.close(); } catch {} });
        },
      });
      return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }
    const r = routes[`${method} ${u.pathname}`] || { status: 200, body: {} };
    const status = r.status || 200;
    if (status === 204) return new Response(null, { status });
    const text = r.raw ?? JSON.stringify(r.body ?? null);
    return new Response(text, { status });
  };
  return { fetchImpl, calls };
}

const PNG_PREFIX = 'data:image/png;base64,';

test('config: enabled only with both URL and key; URL has no trailing slash', () => {
  assert.equal(flyEnabled({}), false);
  assert.equal(flyEnabled({ WACALLS_FLY_URL: 'x' }), false);
  assert.equal(flyEnabled(env), true);
  assert.throws(() => flyConfig({}), /not configured/);
  assert.equal(flyConfig(env).baseUrl, 'https://wacalls.example.test');
});

test('create and delete a per-user session with the key on every request', async () => {
  const f = fake({
    'POST /api/sessions': { body: { id: 'sess-A' } },
    'DELETE /api/sessions/sess-A': { status: 204, raw: '' },
  });
  assert.deepEqual(await flyCreateSession({ name: 'user-1', env, fetchImpl: f.fetchImpl }), { id: 'sess-A' });
  await flyDeleteSession({ sid: 'sess-A', env, fetchImpl: f.fetchImpl });
  assert.deepEqual(f.calls.map((c) => c.headers['X-API-Key']), ['k-123', 'k-123']);
  assert.deepEqual(f.calls[0].body, { name: 'user-1' });
});

test('list sessions returns the paired flag and state the app reads', async () => {
  const f = fake({ 'GET /api/sessions': { body: { sessions: [{ id: 'sess-A', paired: true, state: 'open', jid: '234@s.whatsapp.net' }] } } });
  const list = await flyListSessions({ env, fetchImpl: f.fetchImpl });
  assert.equal(list[0].paired, true);
});

test('detail: a paired session is connected and never starts pairing', async () => {
  const f = fake({ 'GET /api/sessions': { body: { sessions: [{ id: 'sess-A', paired: true, state: 'open', jid: 'j' }] } } });
  const d = await flySessionDetail({ sid: 'sess-A', env, fetchImpl: f.fetchImpl });
  assert.equal(d.paired, true);
  assert.equal(f.calls.some((c) => c.path.endsWith('/pair')), false);
});

test('detail: an unpaired session starts QR pairing and returns the QR as a PNG data URL', async () => {
  const f = fake(
    {
      'GET /api/sessions': { body: { sessions: [{ id: 'sess-A', paired: false, state: 'connecting' }] } },
      'POST /api/sessions/sess-A/pair': { status: 204, raw: '' },
    },
    { events: [{ type: 'session-qr', sessionId: 'other', qr: 'WRONG' }, { type: 'session-qr', sessionId: 'sess-A', qr: 'QR-PAYLOAD' }] },
  );
  const d = await flySessionDetail({ sid: 'sess-A', timeoutMs: 2000, env, fetchImpl: f.fetchImpl });
  assert.equal(d.state, 'qr');
  assert.ok(d.qr.startsWith(PNG_PREFIX), 'QR must be an image the app can show');
  assert.ok(f.calls.some((c) => c.method === 'POST' && c.path === '/api/sessions/sess-A/pair'));
});

test('detail: a session already waiting for a QR is not restarted', async () => {
  const f = fake(
    { 'GET /api/sessions': { body: { sessions: [{ id: 'sess-A', paired: false, state: 'qr' }] } } },
    { events: [{ type: 'session-qr', sessionId: 'sess-A', qr: 'Q' }] },
  );
  await flySessionDetail({ sid: 'sess-A', timeoutMs: 2000, env, fetchImpl: f.fetchImpl });
  assert.equal(f.calls.some((c) => c.path.endsWith('/pair')), false);
});

test('detail: no QR within the wait returns qr null (the app asks again), not an error', async () => {
  const f = fake({ 'GET /api/sessions': { body: { sessions: [{ id: 'sess-A', paired: false, state: 'qr' }] } } }, { events: [] });
  const d = await flySessionDetail({ sid: 'sess-A', timeoutMs: 200, env, fetchImpl: f.fetchImpl });
  assert.equal(d.qr, null);
});

test('detail: an unknown session is a 404 so the caller unlinks the stale id', async () => {
  const f = fake({ 'GET /api/sessions': { body: { sessions: [] } } });
  await assert.rejects(flySessionDetail({ sid: 'sess-A', env, fetchImpl: f.fetchImpl }), (e) => e.statusCode === 404);
});

test('phone pairing returns the code from WaCalls', async () => {
  const f = fake({ 'POST /api/sessions/sess-A/pair-phone': { body: { code: 'ABCD-1234' } } });
  assert.deepEqual(await flyPairPhone({ sid: 'sess-A', phone: '+2348000000000', env, fetchImpl: f.fetchImpl }), { code: 'ABCD-1234' });
  assert.deepEqual(f.calls[0].body, { phone: '+2348000000000' });
});

test('WaCalls error text reaches the caller', async () => {
  const f = fake({ 'POST /api/sessions/sess-A/pair-phone': { status: 400, body: { error: 'session already paired' } } });
  await assert.rejects(flyPairPhone({ sid: 'sess-A', phone: '1', env, fetchImpl: f.fetchImpl }), /session already paired/);
});

test('calls: start with audio or video, offer and renegotiate, video routes, end', async () => {
  const f = fake({
    'POST /api/sessions/sess-A/calls': { body: { call: { callId: 'c-9' } } },
    'POST /api/sessions/sess-A/calls/c-9/webrtc': { body: { sdp_answer: 'ANS' } },
    'POST /api/sessions/sess-A/calls/c-9/webrtc/renegotiate': { body: { sdp_answer: 'ANS2' } },
    'POST /api/sessions/sess-A/calls/c-9/video/start': { body: {} },
    'POST /api/sessions/sess-A/calls/c-9/video/accept': { body: {} },
    'POST /api/sessions/sess-A/calls/c-9/video/stop': { body: {} },
    'DELETE /api/sessions/sess-A/calls/c-9': { status: 204, raw: '' },
  });
  assert.deepEqual(await startFlyCall({ sid: 'sess-A', phone: '2348', video: true, env, fetchImpl: f.fetchImpl }), { callId: 'c-9' });
  assert.deepEqual(f.calls[0].body, { phone: '2348', video: true });
  assert.deepEqual(await submitFlyOffer({ sid: 'sess-A', callId: 'c-9', sdpOffer: 'OFF', env, fetchImpl: f.fetchImpl }), { sdpAnswer: 'ANS' });
  assert.deepEqual(await submitFlyOffer({ sid: 'sess-A', callId: 'c-9', sdpOffer: 'OFF2', renegotiate: true, env, fetchImpl: f.fetchImpl }), { sdpAnswer: 'ANS2' });
  await flyVideoStart({ sid: 'sess-A', callId: 'c-9', env, fetchImpl: f.fetchImpl });
  await flyVideoAccept({ sid: 'sess-A', callId: 'c-9', env, fetchImpl: f.fetchImpl });
  await flyVideoStop({ sid: 'sess-A', callId: 'c-9', env, fetchImpl: f.fetchImpl });
  await flyEndCall({ sid: 'sess-A', callId: 'c-9', env, fetchImpl: f.fetchImpl });
  assert.deepEqual(f.calls.slice(1).map((c) => `${c.method} ${c.path}`), [
    'POST /api/sessions/sess-A/calls/c-9/webrtc',
    'POST /api/sessions/sess-A/calls/c-9/webrtc/renegotiate',
    'POST /api/sessions/sess-A/calls/c-9/video/start',
    'POST /api/sessions/sess-A/calls/c-9/video/accept',
    'POST /api/sessions/sess-A/calls/c-9/video/stop',
    'DELETE /api/sessions/sess-A/calls/c-9',
  ]);
});
