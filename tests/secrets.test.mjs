import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getSecret, validKeyValue, keysStatus, keysSave } from '../lib/secrets.js';

function sb({ row = null, fail = false, writes = [] } = {}) {
  const q = {
    select() { return q; }, eq() { return q; },
    maybeSingle: async () => (fail ? { data: null, error: { message: 'x' } } : { data: row, error: null }),
    upsert: async (p) => { writes.push(p); return { error: null }; },
  };
  return { from: () => q, writes };
}
function fakeRes() {
  return { code: 0, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
}

test('a key saved in admin wins over the environment', async () => {
  assert.equal(await getSecret(sb({ row: { value: ' sk_admin_value_1234 ' } }), 'ELEVENLABS_API_KEY', { ELEVENLABS_API_KEY: 'sk_env_value_9999' }), 'sk_admin_value_1234');
});

test('without a saved key, the environment variable is used', async () => {
  assert.equal(await getSecret(sb(), 'ELEVENLABS_API_KEY', { ELEVENLABS_API_KEY: 'sk_env_value_9999' }), 'sk_env_value_9999');
  assert.equal(await getSecret(sb({ fail: true }), 'ELEVENLABS_API_KEY', { ELEVENLABS_API_KEY: 'sk_env_value_9999' }), 'sk_env_value_9999');
  assert.equal(await getSecret(sb(), 'ELEVENLABS_API_KEY', {}), null);
});

test('key values are checked before saving', () => {
  assert.equal(validKeyValue('sk_good_key_1234567'), null);
  assert.match(validKeyValue('short'), /look like a key/);
  assert.match(validKeyValue('sk_has space_1234567'), /spaces/);
  assert.match(validKeyValue(undefined), /Paste/);
});

test('status shows only the last 4 characters and where the key comes from', async () => {
  const res = fakeRes();
  await keysStatus({}, res, sb({ row: { value: 'sk_admin_value_ABCD', updated_at: '2026-10-18' } }), {});
  const k = res.body.keys.ELEVENLABS_API_KEY;
  assert.equal(k.source, 'admin');
  assert.equal(k.last4, 'ABCD');
  assert.equal(JSON.stringify(res.body).includes('sk_admin_value'), false);
});

test('save refuses unknown names and bad values, and stores a trimmed key', async () => {
  const writes = [];
  const bad = fakeRes();
  await keysSave({ body: { name: 'OTHER', value: 'sk_good_key_1234567' } }, bad, sb({ writes }), 'u1');
  assert.equal(bad.code, 400);
  await keysSave({ body: { name: 'ELEVENLABS_API_KEY', value: 'x' } }, fakeRes(), sb({ writes }), 'u1');
  assert.equal(writes.length, 0);
  const ok = fakeRes();
  await keysSave({ body: { name: 'ELEVENLABS_API_KEY', value: ' sk_good_key_1234567 ' } }, ok, sb({ writes }), 'u1');
  assert.equal(ok.code, 200);
  assert.equal(writes[0].value, 'sk_good_key_1234567');
  assert.equal(ok.body.last4, '4567');
});
