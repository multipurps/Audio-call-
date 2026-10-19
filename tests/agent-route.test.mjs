import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentRoute } from '../lib/agentRoute.js';

function fakeRes() {
  return { code: 0, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, setHeader() {} };
}
function fakeSupabase({ row = null, failRead = false, failWrite = false } = {}) {
  const writes = [];
  const q = {
    select() { return q; }, eq() { return q; },
    maybeSingle: async () => (failRead ? { data: null, error: { message: 'x' } } : { data: row, error: null }),
    upsert: async (payload) => { writes.push(payload); return { error: failWrite ? { message: 'x' } : null }; },
  };
  return { from: () => q, writes };
}
const VOICES = { voices: [{ voice_id: 'nlbqfwie', name: 'Emysa', gender: 'male', accent: 'american', language: 'en' }] };
function stubFetch(body = VOICES, ok = true, extra = {}) {
  let last = null;
  globalThis.fetch = async (url, init) => {
    last = { url, init };
    return { ok, status: ok ? 200 : 500, json: async () => body, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer, headers: { get: () => 'audio/wav' }, ...extra };
  };
  return () => last;
}

test('status lists the user’s custom voices and the chosen one, without the key', async () => {
  stubFetch();
  const res = fakeRes();
  await agentRoute({ method: 'GET', query: { action: 'status' } }, res, fakeSupabase({ row: { active: true, voice_id: 'nlbqfwie' } }), 'u1', 'xai-secret');
  assert.equal(res.code, 200);
  assert.equal(res.body.active, true);
  assert.equal(res.body.voiceName, 'Emysa');
  assert.equal(res.body.voices[0].gender, 'male');
  assert.equal(JSON.stringify(res.body).includes('xai-secret'), false);
});

test('choose saves a voice from the user’s own list and turns the Agent on', async () => {
  stubFetch();
  const sb = fakeSupabase();
  const res = fakeRes();
  await agentRoute({ method: 'PUT', query: { action: 'choose' }, body: { voiceId: 'nlbqfwie' } }, res, sb, 'u1', 'k');
  assert.equal(res.code, 200);
  assert.equal(sb.writes[0].voice_id, 'nlbqfwie');
  assert.equal(sb.writes[0].active, true);
});

test('choose refuses a voice that is not on the account, and malformed ids', async () => {
  stubFetch();
  const sb = fakeSupabase();
  const res = fakeRes();
  await agentRoute({ method: 'PUT', query: { action: 'choose' }, body: { voiceId: 'zzzz9999' } }, res, sb, 'u1', 'k');
  assert.equal(res.code, 400);
  await agentRoute({ method: 'PUT', query: { action: 'choose' }, body: { voiceId: '../x' } }, fakeRes(), sb, 'u1', 'k');
  assert.equal(sb.writes.length, 0);
});

test('preview: rejects a malformed id without calling xAI', async () => {
  const last = stubFetch();
  const res = fakeRes();
  await agentRoute({ method: 'GET', query: { action: 'preview', voice: '../../x' } }, res, fakeSupabase(), 'u1', 'k');
  assert.equal(res.code, 400);
  assert.equal(last(), null);
});

test('preview: returns the reference clip as base64 from the custom-voices audio endpoint', async () => {
  const last = stubFetch();
  const res = fakeRes();
  await agentRoute({ method: 'GET', query: { action: 'preview', voice: 'nlbqfwie' } }, res, fakeSupabase(), 'u1', 'k');
  assert.equal(res.code, 200);
  assert.equal(res.body.mimeType, 'audio/wav');
  assert.match(last().url, /custom-voices\/nlbqfwie\/audio$/);
});
