import test from 'node:test';
import assert from 'node:assert/strict';
import { avatarDisplayName, getAnamAvatar, anamAvatarsRoute, anamAvatarSelectRoute, anamAvatarCreateRoute, anamAvatarDeleteRoute } from '../lib/anamAvatars.js';
import { serverKey } from '../lib/serverKeys.js';

const KEY = 'anam-server-key-1234567890';
const ME = '11111111-1111-1111-1111-111111111111';
const OTHER = '22222222-2222-2222-2222-222222222222';
const NEW_ID = '33333333-3333-3333-3333-333333333333';
const OLD_ID = '44444444-4444-4444-4444-444444444444';
const OTHER_ID = '55555555-5555-5555-5555-555555555555';
const LINKED_ID = '66666666-6666-6666-6666-666666666666';
const BASE = 'https://proj.supabase.co';
const PICTURE = `${BASE}/storage/v1/object/public/avatars/${ME}/video-avatar.png?v=1`;
const env = { ANAM_API_KEY: KEY, SUPABASE_URL: BASE };

// Tiny in-memory stand-in for the supabase-js query builder (only what the routes use).
function fakeDb(seed) {
  const tables = JSON.parse(JSON.stringify(seed));
  const from = (name) => {
    tables[name] ||= [];
    const filters = [];
    let op = 'select', payload = null;
    const matches = (r) => filters.every(([c, v]) => r[c] === v);
    const run = () => {
      const list = tables[name];
      if (op === 'insert') { list.push({ ...payload }); return []; }
      if (op === 'upsert') {
        const key = payload.user_id;
        const row = list.find((r) => r.user_id === key);
        if (row) Object.assign(row, payload); else list.push({ ...payload });
        return [];
      }
      if (op === 'update') { list.filter(matches).forEach((r) => Object.assign(r, payload)); return []; }
      if (op === 'delete') { tables[name] = list.filter((r) => !matches(r)); return []; }
      return list.filter(matches).map((r) => ({ ...r }));
    };
    const q = {
      select() { return q; },
      eq(c, v) { filters.push([c, v]); return q; },
      order() { return q; },
      insert(p) { op = 'insert'; payload = p; return q; },
      upsert(p) { op = 'upsert'; payload = p; return q; },
      update(p) { op = 'update'; payload = p; return q; },
      delete() { op = 'delete'; return q; },
      async maybeSingle() { return { data: run()[0] || null, error: null }; },
      then(res, rej) { return Promise.resolve({ data: run(), error: null }).then(res, rej); },
    };
    return q;
  };
  return { from, tables };
}

const seed = () => ({
  profiles: [{ user_id: ME, name: 'Ariana Silver', video_avatar_url: PICTURE }],
  user_anam_avatars: [
    { anam_avatar_id: OLD_ID, user_id: ME, display_name: 'Ariana Silver', source: 'upload' },
    { anam_avatar_id: LINKED_ID, user_id: ME, display_name: 'Ariana twins', source: 'linked' },
    { anam_avatar_id: OTHER_ID, user_id: OTHER, display_name: 'Someone else', source: 'upload' },
  ],
  user_video_settings: [{ user_id: ME, anam_avatar_id: OLD_ID, anam_avatar_name: 'Ariana Silver' }],
});

const fakeRes = () => ({ code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });

// Fake fetch: the picture download, Anam create (POST) and Anam delete (DELETE).
function fakeFetch({ createOk = true, deleteStatus = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', init });
    if (url === PICTURE) {
      return { ok: true, status: 200, headers: { get: (h) => (h === 'content-type' ? 'image/png' : null) }, arrayBuffer: async () => new ArrayBuffer(16) };
    }
    if (url === 'https://api.anam.ai/v1/avatars' && init.method === 'POST') {
      if (!createOk) return { ok: false, status: 422, text: async () => JSON.stringify({ message: 'bad image' }) };
      return { ok: true, status: 201, text: async () => JSON.stringify({ id: NEW_ID, displayName: 'Ariana Silver' }) };
    }
    if (url.startsWith('https://api.anam.ai/v1/avatars/') && init.method === 'DELETE') {
      return { ok: deleteStatus < 300, status: deleteStatus, text: async () => '' };
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  return { fetchImpl, calls };
}

test('the avatar name is the profile name, 3 to 50 characters', () => {
  assert.equal(avatarDisplayName('Al'), null);
  assert.equal(avatarDisplayName('  Ariana   Silver  '), 'Ariana Silver');
  assert.equal(avatarDisplayName('x'.repeat(80)).length, 50);
  assert.equal(serverKey('anam', {}), null);
});

test('create: sends the picture to Anam named after the profile, selects it, and removes the old upload', async () => {
  const db = fakeDb(seed());
  const { fetchImpl, calls } = fakeFetch();
  const res = fakeRes();
  await anamAvatarCreateRoute({ method: 'POST' }, res, db, ME, { fetchImpl, env });
  assert.equal(res.code, 201);
  assert.deepEqual(res.body, { avatar: { id: NEW_ID, name: 'Ariana Silver' } });
  const post = calls.find((c) => c.method === 'POST');
  assert.equal(post.init.headers.Authorization, `Bearer ${KEY}`);
  assert.equal(post.init.body.get('displayName'), 'Ariana Silver');
  assert.ok(post.init.body.get('imageFile'));
  // Old upload deleted at Anam (hard) and from our table; the linked dashboard avatar is untouched.
  assert.ok(calls.some((c) => c.method === 'DELETE' && c.url === `https://api.anam.ai/v1/avatars/${OLD_ID}?hard=true`));
  assert.ok(!calls.some((c) => c.url.includes(LINKED_ID)));
  const rows = db.tables.user_anam_avatars.filter((r) => r.user_id === ME).map((r) => r.anam_avatar_id).sort();
  assert.deepEqual(rows, [LINKED_ID, NEW_ID].sort());
  assert.equal(db.tables.user_video_settings[0].anam_avatar_id, NEW_ID);
});

test('create: refuses without a server key, a name, or a picture, and makes no Anam call', async () => {
  const noKey = fakeRes(); const f1 = fakeFetch();
  await anamAvatarCreateRoute({ method: 'POST' }, noKey, fakeDb(seed()), ME, { fetchImpl: f1.fetchImpl, env: {} });
  assert.equal(noKey.code, 500);
  assert.equal(noKey.body.error, 'ANAM_API_KEY is not set on the server.');

  const s = seed(); s.profiles[0].name = 'Al';
  const noName = fakeRes(); const f2 = fakeFetch();
  await anamAvatarCreateRoute({ method: 'POST' }, noName, fakeDb(s), ME, { fetchImpl: f2.fetchImpl, env });
  assert.equal(noName.code, 400);

  const s2 = seed(); s2.profiles[0].video_avatar_url = null;
  const noPic = fakeRes(); const f3 = fakeFetch();
  await anamAvatarCreateRoute({ method: 'POST' }, noPic, fakeDb(s2), ME, { fetchImpl: f3.fetchImpl, env });
  assert.equal(noPic.code, 400);
  assert.equal(f1.calls.length + f2.calls.length + f3.calls.length, 0);
});

test('create: a failed Anam create keeps the old avatar and says why', async () => {
  const db = fakeDb(seed());
  const res = fakeRes();
  await anamAvatarCreateRoute({ method: 'POST' }, res, db, ME, { fetchImpl: fakeFetch({ createOk: false }).fetchImpl, env });
  assert.equal(res.code, 422);
  assert.match(res.body.error, /bad image/);
  assert.equal(db.tables.user_video_settings[0].anam_avatar_id, OLD_ID);
});

test('list shows only this person’s avatars, never another user’s', async () => {
  const res = fakeRes();
  await anamAvatarsRoute({ method: 'GET' }, res, fakeDb(seed()), ME, { env: {}, fetchImpl: async () => { throw new Error('no network in tests'); } });
  assert.deepEqual(res.body.avatars.map((a) => a.name).sort(), ['Ariana Silver', 'Ariana twins']);
  assert.equal(JSON.stringify(res.body).includes('Someone else'), false);
  assert.equal(res.body.selectedId, OLD_ID);
});

test('select: own avatar is accepted, another person’s is refused', async () => {
  const db = fakeDb(seed());
  const ok = fakeRes();
  await anamAvatarSelectRoute({ method: 'POST', body: { id: LINKED_ID } }, ok, db, ME);
  assert.equal(ok.code, 200);
  assert.equal(db.tables.user_video_settings[0].anam_avatar_id, LINKED_ID);
  const bad = fakeRes();
  await anamAvatarSelectRoute({ method: 'POST', body: { id: OTHER_ID } }, bad, db, ME);
  assert.equal(bad.code, 404);
  assert.equal(db.tables.user_video_settings[0].anam_avatar_id, LINKED_ID);
});

test('a video call never uses an avatar that is not this person’s', async () => {
  const db = fakeDb(seed());
  db.tables.user_video_settings[0].anam_avatar_id = OTHER_ID;
  assert.equal(await getAnamAvatar(db, ME), null);
  db.tables.user_video_settings[0].anam_avatar_id = LINKED_ID;
  assert.deepEqual(await getAnamAvatar(db, ME), { id: LINKED_ID, name: 'Ariana twins' });
});

test('delete: removes the uploaded avatar at Anam and clears the selection; linked avatars stay', async () => {
  const db = fakeDb(seed());
  const { fetchImpl, calls } = fakeFetch();
  const res = fakeRes();
  await anamAvatarDeleteRoute({ method: 'POST' }, res, db, ME, { fetchImpl, env });
  assert.equal(res.code, 200);
  assert.ok(calls.some((c) => c.method === 'DELETE' && c.url.includes(OLD_ID)));
  assert.equal(db.tables.user_anam_avatars.some((r) => r.anam_avatar_id === OLD_ID), false);
  assert.equal(db.tables.user_anam_avatars.some((r) => r.anam_avatar_id === LINKED_ID), true);
  assert.equal(db.tables.user_video_settings[0].anam_avatar_id, null);
});

test('delete: if Anam refuses, the row is kept so nothing is silently orphaned', async () => {
  const db = fakeDb(seed());
  const res = fakeRes();
  await anamAvatarDeleteRoute({ method: 'POST' }, res, db, ME, { fetchImpl: fakeFetch({ deleteStatus: 500 }).fetchImpl, env });
  assert.equal(res.code, 502);
  assert.equal(db.tables.user_anam_avatars.some((r) => r.anam_avatar_id === OLD_ID), true);
  assert.equal(db.tables.user_video_settings[0].anam_avatar_id, OLD_ID);
});

test('delete: a 404 from Anam (already gone) still clears our record', async () => {
  const db = fakeDb(seed());
  const res = fakeRes();
  await anamAvatarDeleteRoute({ method: 'POST' }, res, db, ME, { fetchImpl: fakeFetch({ deleteStatus: 404 }).fetchImpl, env });
  assert.equal(res.code, 200);
  assert.equal(db.tables.user_anam_avatars.some((r) => r.anam_avatar_id === OLD_ID), false);
});
