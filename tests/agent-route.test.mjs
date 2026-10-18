import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentRoute } from '../lib/agentRoute.js';

function fakeRes() {
  return { code: 0, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
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
const VOICES = { voices: [{ voice_id: 'Abcd1234EFGH', name: 'Bossa', preview_url: 'https://p.example/a.mp3', labels: { gender: 'female', accent: 'british' } }] };
function stubFetch(body = VOICES, ok = true) {
  globalThis.fetch = async () => ({ ok, status: ok ? 200 : 500, json: async () => body });
}

test('status returns the account voices with preview clips, and the chosen voice', async () => {
  stubFetch();
  const res = fakeRes();
  await agentRoute({ method: 'GET', query: { action: 'status' } }, res, fakeSupabase({ row: { active: true, voice_id: 'Abcd1234EFGH' } }), 'u1', 'sk-secret');
  assert.equal(res.code, 200);
  assert.equal(res.body.active, true);
  assert.equal(res.body.voiceName, 'Bossa');
  assert.equal(res.body.voices[0].previewUrl, 'https://p.example/a.mp3');
  assert.equal(JSON.stringify(res.body).includes('sk-secret'), false);
});

test('choose saves a voice from the account and turns the Agent on', async () => {
  stubFetch();
  const sb = fakeSupabase();
  const res = fakeRes();
  await agentRoute({ method: 'PUT', query: { action: 'choose' }, body: { voiceId: 'Abcd1234EFGH' } }, res, sb, 'u1', 'k');
  assert.equal(res.code, 200);
  assert.equal(sb.writes[0].voice_id, 'Abcd1234EFGH');
  assert.equal(sb.writes[0].active, true);
});

test('choose refuses a voice that is not on the account, and malformed ids', async () => {
  stubFetch();
  const sb = fakeSupabase();
  const res = fakeRes();
  await agentRoute({ method: 'PUT', query: { action: 'choose' }, body: { voiceId: 'Zzzz9999Zzzz' } }, res, sb, 'u1', 'k');
  assert.equal(res.code, 400);
  await agentRoute({ method: 'PUT', query: { action: 'choose' }, body: { voiceId: '../x' } }, fakeRes(), sb, 'u1', 'k');
  assert.equal(sb.writes.length, 0);
});
