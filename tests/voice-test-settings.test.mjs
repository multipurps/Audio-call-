import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

// In-memory stand-in for the one table the endpoint touches.
let row = null;
const fakeDb = {
  from() {
    const q = {
      select() { return q; }, eq() { return q; },
      maybeSingle: async () => ({ data: row }),
      delete() { return { eq: async () => { row = null; return {}; } }; },
      update(v) { return { eq: async () => { if (row) Object.assign(row, v); return {}; } }; },
      upsert: async (r) => { row = { provider: r.provider, voice_id: r.voice_id, api_key: r.api_key, active: r.active }; return {}; },
    };
    return q;
  },
};
mock.module(new URL('../lib/supabaseAdmin.js', import.meta.url).href, { namedExports: { getServiceClient: () => fakeDb, getAuthedUserId: async () => 'u1' } });
mock.module(new URL('../lib/liveVoices.js', import.meta.url).href, { namedExports: { LIVE_VOICES: [], liveVoiceById: () => null } });
mock.module(new URL('../lib/liveVoicePreview.js', import.meta.url).href, { namedExports: { liveVoicePreview: async () => Buffer.alloc(0) } });
const { default: handler } = await import('../api/voice-clone.js');

const call = async (method, body) => {
  const res = { code: 0, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, setHeader() {} };
  await handler({ method, query: { action: 'test-voice' }, body, headers: {} }, res);
  return res;
};

test('save, read back without the key, keep the key when left empty, then remove', async () => {
  row = null;
  let r = await call('PUT', { provider: 'elevenlabs', voiceId: 'VoiceId12345', apiKey: 'sk_secret_abcdefgh1234' });
  assert.equal(r.code, 200);
  assert.deepEqual(r.body, { active: true, provider: 'elevenlabs', voiceId: 'VoiceId12345', hasKey: true, keyTail: '1234' });
  assert.ok(!JSON.stringify(r.body).includes('secret'), 'the key is never returned');

  r = await call('PUT', { provider: 'elevenlabs', voiceId: 'AnotherVoice99', apiKey: '' });
  assert.equal(r.code, 200);
  assert.equal(row.api_key, 'sk_secret_abcdefgh1234', 'empty key keeps the saved one');

  r = await call('PUT', { provider: 'cartesia', voiceId: 'AnotherVoice99', apiKey: '' });
  assert.equal(r.code, 400, 'a saved ElevenLabs key is not reused for Cartesia');

  r = await call('GET');
  assert.equal(r.body.hasKey, true);
  assert.ok(!('apiKey' in r.body) && !JSON.stringify(r.body).includes('secret'));

  r = await call('DELETE');
  assert.equal(r.body.active, false);
  assert.equal(row, null);
});

test('bad input is refused', async () => {
  row = null;
  assert.equal((await call('PUT', { provider: 'polly', voiceId: 'VoiceId12345', apiKey: 'k'.repeat(20) })).code, 400);
  assert.equal((await call('PUT', { provider: 'cartesia', voiceId: 'bad id!', apiKey: 'k'.repeat(20) })).code, 400);
  assert.equal((await call('PUT', { provider: 'cartesia', voiceId: 'VoiceId12345', apiKey: 'short' })).code, 400);
  assert.equal(row, null);
});

test('turning it off keeps the key; saving again turns it back on', async () => {
  row = null;
  await call('PUT', { provider: 'cartesia', voiceId: 'VoiceId12345', apiKey: 'sk_secret_abcdefgh1234' });
  let r = await call('PUT', { active: false });
  assert.equal(r.code, 200);
  assert.equal(r.body.active, false);
  assert.equal(r.body.hasKey, true);
  assert.equal(row.api_key, 'sk_secret_abcdefgh1234');
  r = await call('PUT', { provider: 'cartesia', voiceId: 'VoiceId12345', apiKey: '' });
  assert.equal(r.body.active, true);
  row = null;
  assert.equal((await call('PUT', { active: false })).code, 400, 'nothing saved to switch off');
});
