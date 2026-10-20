import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentRoute, LIVE_VOICES } from '../lib/agentRoute.js';

function fakeRes() {
  return { code: 0, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
}
function fakeSupabase({ row = null, failWrite = false } = {}) {
  const writes = [];
  const q = {
    select() { return q; }, eq() { return q; },
    maybeSingle: async () => ({ data: row, error: null }),
    upsert: async (payload) => { writes.push(payload); return { error: failWrite ? { message: 'x' } : null }; },
  };
  return { from: () => q, writes };
}
function stubInworld(voices = [{ voiceId: 'ws__mine', displayName: 'Mine', description: 'My clone' }], ok = true) {
  let last = null;
  globalThis.fetch = async (url, init) => {
    last = { url, init };
    return { ok, status: ok ? 200 : 500, json: async () => ({ voices }) };
  };
  return () => last;
}

test('status: the Live presets are always listed; custom voices come from the workspace, owned only', async () => {
  const last = stubInworld();
  const res = fakeRes();
  await agentRoute({ method: 'GET', query: { action: 'status' } }, res, fakeSupabase({ row: { active: true, provider: 'inworld', voice_id: 'ws__mine' } }), 'u1', { inworld: 'key123' });
  assert.equal(res.code, 200);
  assert.equal(res.body.provider, 'custom');
  assert.equal(res.body.voiceName, 'Mine');
  assert.equal(res.body.custom.voices[0].id, 'ws__mine');
  assert.equal(res.body.live.voices.length, LIVE_VOICES.length);
  assert.match(decodeURIComponent(last().url), /filter=owned = "true"/);
  assert.equal(last().init.headers.Authorization, 'Basic key123');
});

test('status: with no Inworld key, custom says why and live still works', async () => {
  const res = fakeRes();
  await agentRoute({ method: 'GET', query: { action: 'status' } }, res, fakeSupabase(), 'u1', { inworld: '' });
  assert.match(res.body.custom.error, /not set up/);
  assert.equal(res.body.live.voices.length, LIVE_VOICES.length);
});

test('choose live: a built-in preset is saved as the default', async () => {
  const sb = fakeSupabase();
  const res = fakeRes();
  await agentRoute({ method: 'PUT', query: { action: 'choose' }, body: { provider: 'live', voiceId: 'eve' } }, res, sb, 'u1', {});
  assert.equal(res.code, 200);
  assert.equal(sb.writes[0].provider, 'grok');
  assert.equal(sb.writes[0].voice_id, 'eve');
  assert.equal(sb.writes[0].active, true);
});

test('choose custom: only an owned clone can be saved', async () => {
  stubInworld();
  const sb = fakeSupabase();
  const res = fakeRes();
  await agentRoute({ method: 'PUT', query: { action: 'choose' }, body: { provider: 'custom', voiceId: 'ws__mine' } }, res, sb, 'u1', { inworld: 'key' });
  assert.equal(res.code, 200);
  assert.equal(sb.writes[0].provider, 'inworld');
  const bad = fakeRes();
  await agentRoute({ method: 'PUT', query: { action: 'choose' }, body: { provider: 'custom', voiceId: 'ws__other' } }, bad, sb, 'u1', { inworld: 'key' });
  assert.equal(bad.code, 400);
  assert.equal(sb.writes.length, 1);
});

test('choose: refuses an unknown provider, an unknown preset and a malformed id', async () => {
  const sb = fakeSupabase();
  for (const body of [{ provider: 'other', voiceId: 'eve' }, { provider: 'live', voiceId: 'nobody' }, { provider: 'live', voiceId: '../x' }]) {
    const res = fakeRes();
    await agentRoute({ method: 'PUT', query: { action: 'choose' }, body }, res, sb, 'u1', {});
    assert.equal(res.code, 400);
  }
  assert.equal(sb.writes.length, 0);
});
