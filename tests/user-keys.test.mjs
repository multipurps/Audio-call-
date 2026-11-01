import test from 'node:test';
import assert from 'node:assert/strict';
import { serverKey, getAnamAvatar, anamAvatarsRoute, anamAvatarSaveRoute } from '../lib/userKeys.js';

const KEY = 'sk-anam-server-key-1234567890';
const UUID = '11111111-2222-3333-4444-555555555555';
const emptySb = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }) };
const savedSb = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { anam_avatar_id: UUID, anam_avatar_name: 'My face' } }) }) }) }) };
const fakeRes = () => ({ code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });

test('keys come only from the server environment', () => {
  assert.equal(serverKey('anam', { ANAM_API_KEY: ` ${KEY} ` }), KEY);
  assert.equal(serverKey('xmax', { XMAX_API_KEY: 'xk' }), 'xk');
  assert.equal(serverKey('anam', {}), null);
  assert.equal(serverKey('decart', { ANAM_API_KEY: KEY }), null);
});

test('avatar list says so when ANAM_API_KEY is missing and makes no call', async () => {
  const res = fakeRes();
  await anamAvatarsRoute({ method: 'GET' }, res, emptySb, 'u1', {
    env: {}, fetchImpl: async () => { throw new Error('should not call'); },
  });
  assert.equal(res.code, 500);
  assert.equal(res.body.error, 'ANAM_API_KEY is not set on the server.');
});

test('avatar list uses the server key and returns id and name only', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ id: UUID, displayName: 'My face', imageUrl: 'x' }] }) };
  };
  const res = fakeRes();
  await anamAvatarsRoute({ method: 'GET' }, res, emptySb, 'u1', { env: { ANAM_API_KEY: KEY }, fetchImpl });
  assert.equal(calls[0].url, 'https://api.anam.ai/v1/avatars');
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${KEY}`);
  assert.deepEqual(res.body, { avatars: [{ id: UUID, name: 'My face' }] });
  assert.equal(JSON.stringify(res.body).includes(KEY), false);
});

test('a failed Anam call is reported without leaking the key', async () => {
  const res = fakeRes();
  await anamAvatarsRoute({ method: 'GET' }, res, emptySb, 'u1', {
    env: { ANAM_API_KEY: KEY }, fetchImpl: async () => ({ ok: false, status: 401, text: async () => 'nope' }),
  });
  assert.equal(res.code, 401);
  assert.equal(JSON.stringify(res.body).includes(KEY), false);
});

test('saving an avatar only accepts an Anam id', async () => {
  const res = fakeRes();
  await anamAvatarSaveRoute({ method: 'POST', body: { id: '../../etc', name: 'x' } }, res, emptySb, 'u1');
  assert.equal(res.code, 400);
});

test('the picked avatar can be read back', async () => {
  assert.deepEqual(await getAnamAvatar(savedSb, 'u1'), { id: UUID, name: 'My face' });
  assert.equal(await getAnamAvatar(emptySb, 'u1'), null);
  const res = fakeRes();
  await anamAvatarSaveRoute({ method: 'GET' }, res, savedSb, 'u1');
  assert.deepEqual(res.body, { avatar: { id: UUID, name: 'My face' } });
});
