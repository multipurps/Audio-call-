import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentRoute, LIVE_VOICES } from '../lib/agentRoute.js';

function fakeRes() {
  return { code: 0, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, setHeader() {} };
}
// user_agents is the only table the voice route touches now.
function fakeSupabase({ agent = null } = {}) {
  const db = { user_agents: agent ? [{ user_id: 'u1', ...agent }] : [] };
  const writes = [];
  function from(table) {
    const filters = [];
    let op = 'select';
    const match = () => db[table].filter((r) => filters.every(([c, v]) => r[c] === v));
    const q = {
      select() { return q; },
      eq(col, val) { filters.push([col, val]); return q; },
      delete() { op = 'delete'; return q; },
      maybeSingle: async () => ({ data: match()[0] || null, error: null }),
      upsert: async (payload) => { writes.push(payload); db[table] = [...db[table].filter((r) => r.user_id !== payload.user_id), payload]; return { error: null }; },
      then(resolve, reject) {
        if (op === 'delete') { const gone = match(); db[table] = db[table].filter((r) => !gone.includes(r)); }
        return Promise.resolve({ error: null }).then(resolve, reject);
      },
    };
    return q;
  }
  return { from, writes, db };
}

// A stand-in for the shared Inworld workspace: it stores voices with their tags, lists them a few
// at a time (so paging is exercised), clones, and deletes. `calls` records every request.
function fakeInworld({ voices = [], pageSize = 2, failDelete = 0, deleteStatus = 200 } = {}) {
  const state = { voices: [...voices], calls: [], next: 1, failDelete };
  globalThis.fetch = async (url, init = {}) => {
    const method = init.method || 'GET';
    const u = new URL(url);
    state.calls.push(`${method} ${u.pathname}${u.search}`);
    const json = (body, ok = true, status = 200) => ({ ok, status, json: async () => body, text: async () => JSON.stringify(body) });
    if (method === 'GET' && u.pathname === '/voices/v1/voices') {
      const start = Number(u.searchParams.get('pageToken') || 0);
      const page = state.voices.slice(start, start + pageSize);
      const more = start + pageSize < state.voices.length;
      return json({ voices: page, nextPageToken: more ? String(start + pageSize) : '' });
    }
    if (method === 'POST' && u.pathname === '/voices/v1/voices:clone') {
      const body = JSON.parse(init.body);
      const voice = { voiceId: `ws__v${state.next++}`, displayName: body.displayName, description: body.description, tags: body.tags };
      state.voices.push(voice);
      state.lastClone = body;
      return json({ voice });
    }
    if (method === 'DELETE' && u.pathname.startsWith('/voices/v1/voices/')) {
      const id = decodeURIComponent(u.pathname.split('/').pop());
      if (state.failDelete > 0) { state.failDelete--; return json({ message: 'boom' }, false, 500); }
      const before = state.voices.length;
      state.voices = state.voices.filter((v) => v.voiceId !== id);
      if (deleteStatus === 404 || before === state.voices.length) return json({}, false, 404);
      return json({});
    }
    return json({}, false, 500);
  };
  return state;
}
const mineTag = (id) => `emysa-user-${id}`;
const voiceOf = (id, userId, name = 'My voice') => ({ voiceId: id, displayName: name, tags: [mineTag(userId)], description: mineTag(userId) });
const CLONE_BODY = { name: 'My voice', consent: true, sample: { type: 'audio/wav', data: 'AAAA' } };
const post = (action, body, sb, user = 'u1') => { const res = fakeRes(); return agentRoute({ method: 'POST', query: { action }, body }, res, sb, user, { inworld: 'key123' }).then(() => res); };
const del = (sb, user = 'u1') => { const res = fakeRes(); return agentRoute({ method: 'DELETE', query: { action: 'delete' } }, res, sb, user, { inworld: 'key123' }).then(() => res); };
const get = (query, sb, user = 'u1', keys = { inworld: 'key123' }) => { const res = fakeRes(); return agentRoute({ method: 'GET', query }, res, sb, user, keys).then(() => res); };

test('status: the Live presets are always listed; the custom voice is the one carrying the user’s mark', async () => {
  fakeInworld({ voices: [voiceOf('ws__a', 'u1', 'Mine')] });
  const res = await get({ action: 'status' }, fakeSupabase({ agent: { active: true, provider: 'inworld', voice_id: 'ws__a' } }));
  assert.equal(res.code, 200);
  assert.equal(res.body.provider, 'custom');
  assert.equal(res.body.voiceName, 'Mine');
  assert.deepEqual(res.body.custom.voices.map((v) => v.id), ['ws__a']);
  assert.equal(res.body.live.voices.length, LIVE_VOICES.length);
});

test('status: nobody else’s clone is ever shown, however far down the shared workspace it sits', async () => {
  // 7 voices over pages of 2; u1's is on the last page, u2 has none
  const voices = [1, 2, 3, 4, 5, 6].map((n) => voiceOf(`ws__o${n}`, `other${n}`));
  voices.push(voiceOf('ws__mine', 'u1'));
  const inworld = fakeInworld({ voices });
  const own = await get({ action: 'status' }, fakeSupabase());
  assert.deepEqual(own.body.custom.voices.map((v) => v.id), ['ws__mine']); // found by paging
  assert.ok(inworld.calls.length >= 4);
  const stranger = await get({ action: 'status' }, fakeSupabase(), 'u2');
  assert.deepEqual(stranger.body.custom.voices, []);
});

test('status: with no Inworld key, custom says why and live still works', async () => {
  const res = await get({ action: 'status' }, fakeSupabase(), 'u1', { inworld: '' });
  assert.match(res.body.custom.error, /not available/);
  assert.equal(res.body.live.voices.length, LIVE_VOICES.length);
});

test('choose custom: only the user’s own clone can be saved', async () => {
  fakeInworld({ voices: [voiceOf('ws__mine', 'u1'), voiceOf('ws__theirs', 'u2')] });
  const sb = fakeSupabase();
  const choose = (voiceId, user) => { const res = fakeRes(); return agentRoute({ method: 'PUT', query: { action: 'choose' }, body: { provider: 'custom', voiceId } }, res, sb, user, { inworld: 'key123' }).then(() => res); };
  assert.equal((await choose('ws__mine', 'u1')).code, 200);
  assert.equal(sb.writes[0].provider, 'inworld');
  assert.equal((await choose('ws__theirs', 'u1')).code, 400); // someone else's voice, by its exact id
  assert.equal((await choose('ws__mine', 'u2')).code, 400);
  assert.equal(sb.writes.length, 1);
});

test('preview: a custom voice must be one the user owns', async () => {
  fakeInworld({ voices: [voiceOf('ws__mine', 'u1'), voiceOf('ws__theirs', 'u2')] });
  assert.equal((await get({ action: 'preview', provider: 'custom', voice: 'ws__theirs' }, fakeSupabase())).code, 400);
  assert.equal((await get({ action: 'preview', provider: 'custom', voice: 'ws__mine' }, fakeSupabase(), 'u2')).code, 400);
});

test('clone: a good clip creates the voice, marked with its owner, and returns its id', async () => {
  const inworld = fakeInworld();
  const res = await post('clone', CLONE_BODY, fakeSupabase());
  assert.equal(res.code, 200);
  assert.equal(res.body.voiceId, 'ws__v1');
  assert.equal(inworld.lastClone.displayName, 'My voice');
  assert.deepEqual(inworld.lastClone.voiceSamples, [{ audioData: 'AAAA' }]);
  assert.deepEqual(inworld.lastClone.tags, [mineTag('u1')]);
  assert.equal(inworld.lastClone.description, mineTag('u1'));
});

test('clone: one custom voice per user. A second is refused before anything is created', async () => {
  const inworld = fakeInworld({ voices: [voiceOf('ws__mine', 'u1')] });
  const res = await post('clone', CLONE_BODY, fakeSupabase());
  assert.equal(res.code, 409);
  assert.match(res.body.error, /Delete it/);
  assert.equal(inworld.calls.some((c) => c.startsWith('POST')), false);
  // another user is not blocked by u1's voice
  assert.equal((await post('clone', CLONE_BODY, fakeSupabase(), 'u2')).code, 200);
});

test('clone: two clones racing for one user leave exactly one voice', async () => {
  // u1 already has ws__a (made a moment earlier by the other request); this request creates ws__v1.
  // The lowest id stays, so this one removes itself.
  const inworld = fakeInworld({ voices: [] });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const r = await realFetch(url, init);
    if ((init.method || 'GET') === 'POST') inworld.voices.unshift(voiceOf('ws__a', 'u1')); // the other request lands right after
    return r;
  };
  const res = await post('clone', CLONE_BODY, fakeSupabase());
  assert.equal(res.code, 409);
  assert.deepEqual(inworld.voices.filter((v) => v.tags?.includes(mineTag('u1'))).map((v) => v.voiceId), ['ws__a']);
});

test('delete: removes the clone at the provider and switches calls off it; the user can then clone again', async () => {
  const inworld = fakeInworld({ voices: [voiceOf('ws__mine', 'u1'), voiceOf('ws__theirs', 'u2')] });
  const sb = fakeSupabase({ agent: { active: true, provider: 'inworld', voice_id: 'ws__mine' } });
  const res = await del(sb);
  assert.equal(res.code, 200);
  assert.equal(res.body.deleted, true);
  assert.ok(inworld.calls.includes('DELETE /voices/v1/voices/ws__mine'));
  assert.deepEqual(inworld.voices.map((v) => v.voiceId), ['ws__theirs']); // only theirs is left, and untouched
  assert.deepEqual(sb.db.user_agents, []);
  assert.equal((await post('clone', CLONE_BODY, sb)).code, 200);
});

test('delete: a Live voice choice survives, and a user with no voice deletes nothing', async () => {
  const inworld = fakeInworld({ voices: [voiceOf('ws__mine', 'u1')] });
  const sb = fakeSupabase({ agent: { active: true, provider: 'grok', voice_id: 'eve' } });
  assert.equal((await del(sb)).body.deleted, true);
  assert.equal(sb.db.user_agents.length, 1);
  const before = inworld.calls.length;
  const stranger = await del(fakeSupabase(), 'u2');
  assert.equal(stranger.body.deleted, false);
  assert.equal(inworld.calls.slice(before).some((c) => c.startsWith('DELETE')), false);
});

test('delete: if the provider refuses, the voice stays and it can be retried; one already gone counts as deleted', async () => {
  const logged = []; const orig = console.error; console.error = (...a) => logged.push(a.join(' '));
  try {
    const inworld = fakeInworld({ voices: [voiceOf('ws__mine', 'u1')], failDelete: 1 });
    const sb = fakeSupabase({ agent: { active: true, provider: 'inworld', voice_id: 'ws__mine' } });
    const failed = await del(sb);
    assert.equal(failed.code, 502);
    assert.equal(inworld.voices.length, 1);
    assert.equal(sb.db.user_agents.length, 1); // calls are not switched off by a failed delete
    const retry = await del(sb);
    assert.equal(retry.code, 200);
    assert.equal(inworld.voices.length, 0);
    // a voice that disappeared between listing and deleting is fine too
    fakeInworld({ voices: [voiceOf('ws__mine', 'u1')], deleteStatus: 404 });
    assert.equal((await del(fakeSupabase())).code, 200);
  } finally { console.error = orig; }
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
