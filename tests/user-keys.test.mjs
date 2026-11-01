import test from 'node:test';
import assert from 'node:assert/strict';
import { validKeyValue, userKeysRoute, anamAvatarsRoute, anamAvatarSaveRoute } from '../lib/userKeys.js';

const KEY = 'sk-anam-personal-key-1234567890';
const UUID = '11111111-2222-3333-4444-555555555555';
const emptySb = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }) };
const withKey = {
  from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { anam_api_key_secret_id: 'sid' } }) }) }) }),
  rpc: async () => ({ data: KEY, error: null }),
};
const fakeRes = () => ({ code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });

test('a key must look like a key', () => {
  assert.match(validKeyValue('short'), /does not look like a key/);
  assert.match(validKeyValue('has a space in it here 12345'), /cannot contain spaces/);
  assert.equal(validKeyValue(KEY), null);
});

test('keys route refuses unknown providers and bad keys', async () => {
  const r1 = fakeRes();
  await userKeysRoute({ method: 'POST', body: { provider: 'decart', key: KEY } }, r1, emptySb, 'u1');
  assert.equal(r1.code, 400);
  const r2 = fakeRes();
  await userKeysRoute({ method: 'POST', body: { provider: 'anam', key: 'x' } }, r2, emptySb, 'u1');
  assert.equal(r2.code, 400);
});

test('avatar list needs the person’s own key first', async () => {
  const res = fakeRes();
  await anamAvatarsRoute({ method: 'GET' }, res, emptySb, 'u1', { fetchImpl: async () => { throw new Error('should not call'); } });
  assert.equal(res.code, 400);
  assert.match(res.body.error, /Save your Anam API key first/);
});

test('avatar list uses the person’s key and returns id and name only', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ id: UUID, displayName: 'My face', imageUrl: 'x' }] }) };
  };
  const res = fakeRes();
  await anamAvatarsRoute({ method: 'GET' }, res, withKey, 'u1', { fetchImpl });
  assert.equal(calls[0].url, 'https://api.anam.ai/v1/avatars');
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${KEY}`);
  assert.deepEqual(res.body, { avatars: [{ id: UUID, name: 'My face' }] });
  assert.equal(JSON.stringify(res.body).includes(KEY), false);
});

test('saving an avatar only accepts an Anam id', async () => {
  const res = fakeRes();
  await anamAvatarSaveRoute({ method: 'POST', body: { id: '../../etc', name: 'x' } }, res, emptySb, 'u1');
  assert.equal(res.code, 400);
});
