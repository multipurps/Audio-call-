import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentRoute, LIVE_VOICES } from '../lib/agentRoute.js';

function fakeRes() {
  return { code: 0, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, setHeader() {} };
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
  assert.match(res.body.custom.error, /not available/);
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

test('preview: a built-in preset plays the shared sentence; an unknown preset is refused', async () => {
  let sent = null;
  globalThis.fetch = async (url, init) => {
    sent = { url, body: JSON.parse(init.body) };
    return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([1, 2]).buffer, headers: { get: () => 'audio/mpeg' } };
  };
  const res = fakeRes();
  await agentRoute({ method: 'GET', query: { action: 'preview', provider: 'live', voice: 'eve' } }, res, fakeSupabase(), 'u1', { xai: 'xai-key' });
  assert.equal(res.code, 200);
  assert.equal(sent.body.text, 'This is how I sound when I call for you.');
  assert.equal(sent.body.voice_id, 'eve');
  const bad = fakeRes();
  await agentRoute({ method: 'GET', query: { action: 'preview', provider: 'live', voice: 'nobody' } }, bad, fakeSupabase(), 'u1', { xai: 'xai-key' });
  assert.equal(bad.code, 400);
});

test('preview: a custom voice must be one the user owns', async () => {
  stubInworld();
  const res = fakeRes();
  await agentRoute({ method: 'GET', query: { action: 'preview', provider: 'custom', voice: 'ws__other' } }, res, fakeSupabase(), 'u1', { inworld: 'key' });
  assert.equal(res.code, 400);
});

test('clone: needs a name, consent, a clip, and a clip under 4 MB', async () => {
  const base = { name: 'My voice', consent: true, sample: { type: 'audio/mpeg', data: 'AAAA' } };
  const cases = [
    [{ ...base, name: '' }, /name/],
    [{ ...base, consent: false }, /Confirm/],
    [{ ...base, sample: {} }, /clip/],
    [{ ...base, sample: { type: 'text/plain', data: 'AAAA' } }, /audio/],
    [{ ...base, sample: { type: 'audio/mpeg', data: 'A'.repeat(6 * 1024 * 1024) } }, /too large/],
  ];
  for (const [body, msg] of cases) {
    const res = fakeRes();
    await agentRoute({ method: 'POST', query: { action: 'clone' }, body }, res, fakeSupabase(), 'u1', { inworld: 'key' });
    assert.equal(res.code, 400);
    assert.match(res.body.error, msg);
  }
});

test('clone: a good clip creates the voice in the user’s workspace and returns its id', async () => {
  let sent = null;
  globalThis.fetch = async (url, init) => {
    sent = { url, body: JSON.parse(init.body), auth: init.headers.Authorization };
    return { ok: true, status: 200, json: async () => ({ voice: { voiceId: 'ws__new' } }) };
  };
  const res = fakeRes();
  await agentRoute({ method: 'POST', query: { action: 'clone' }, body: { name: 'My voice', consent: true, sample: { type: 'audio/mpeg', data: 'AAAA' } } }, res, fakeSupabase(), 'u1', { inworld: 'key123' });
  assert.equal(res.code, 200);
  assert.equal(res.body.voiceId, 'ws__new');
  assert.equal(sent.body.displayName, 'My voice');
  assert.deepEqual(sent.body.voiceSamples, [{ audioData: 'AAAA' }]);
  assert.equal(sent.auth, 'Basic key123');
});

test('preview: JSON audio from the speech service is accepted as well as raw audio', async () => {
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    headers: { get: () => 'application/json' },
    json: async () => ({ audio: 'AQID', content_type: 'audio/mpeg', duration: 2 }),
  });
  const res = fakeRes();
  await agentRoute({ method: 'GET', query: { action: 'preview', provider: 'live', voice: 'eve' } }, res, fakeSupabase(), 'u1', { xai: 'k' });
  assert.equal(res.code, 200);
  assert.equal(res.body.audioBase64, 'AQID');
  assert.equal(res.body.mimeType, 'audio/mpeg');
});

test('preview: a refusal is logged with its reason, and the user only sees a neutral message', async () => {
  const logged = [];
  const orig = console.error;
  console.error = (...a) => logged.push(a.join(' '));
  try {
    globalThis.fetch = async () => ({ ok: false, status: 403, text: async () => '{"error":"no credits"}', headers: { get: () => 'application/json' } });
    const res = fakeRes();
    await agentRoute({ method: 'GET', query: { action: 'preview', provider: 'live', voice: 'eve' } }, res, fakeSupabase(), 'u1', { xai: 'secret-key-value' });
    assert.equal(res.code, 502);
    assert.equal(res.body.error, 'Preview is not available right now');
    assert.match(logged.join('\n'), /status=403.*no credits/);
    assert.equal(logged.join('\n').includes('secret-key-value'), false);
    assert.equal(JSON.stringify(res.body).toLowerCase().match(/xai|grok|inworld/), null);
  } finally {
    console.error = orig;
  }
});
