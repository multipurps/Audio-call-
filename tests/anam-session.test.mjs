import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAvatarPrompt, mintAnamSessionToken, anamSessionRoute, ANAM_SESSION_URL } from '../lib/anamSession.js';

const KEY = 'sk-anam-test-key-1234567890';
const TOKEN = 'anam-session-token-xyz';
const supabaseNoRow = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }) };
const fakeRes = () => ({ code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });
const okFetch = (calls) => async (url, init) => {
  calls.push({ url, init });
  return { ok: true, status: 200, text: async () => JSON.stringify({ sessionToken: TOKEN }) };
};

test('mint sends the key as a Bearer header and returns only the session token', async () => {
  const calls = [];
  const out = await mintAnamSessionToken({ apiKey: KEY, avatarId: 'av1', voiceId: 'v1', llmId: 'l1', systemPrompt: 'hi', fetchImpl: okFetch(calls) });
  assert.deepEqual(out, { sessionToken: TOKEN });
  assert.equal(JSON.stringify(out).includes(KEY), false);
  assert.equal(calls[0].url, ANAM_SESSION_URL);
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${KEY}`);
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.personaConfig.avatarId, 'av1');
  assert.equal(body.personaConfig.skipGreeting, true);
});

test('mint refuses without a key or an avatar id', async () => {
  await assert.rejects(() => mintAnamSessionToken({ apiKey: '', avatarId: 'a', fetchImpl: okFetch([]) }), (e) => e.status === 400);
  await assert.rejects(() => mintAnamSessionToken({ apiKey: KEY, avatarId: '', fetchImpl: okFetch([]) }), (e) => e.status === 400);
});

test('mint maps an Anam error to its status', async () => {
  const bad = async () => ({ ok: false, status: 401, text: async () => JSON.stringify({ message: 'bad key' }) });
  await assert.rejects(() => mintAnamSessionToken({ apiKey: KEY, avatarId: 'a', fetchImpl: bad }), (e) => e.status === 401 && /bad key/.test(e.message));
});

test('the avatar prompt carries the brief and the honesty rule', () => {
  const p = buildAvatarPrompt('Ask about Friday', 'Tunde');
  assert.match(p, /with Tunde/);
  assert.match(p, /Ask about Friday/);
  assert.match(p, /answer honestly/);
  assert.match(buildAvatarPrompt(), /has not given a brief/);
});

test('route: GET refused; POST uses the person\'s own key and avatar and returns a token only', async () => {
  const res = fakeRes();
  await anamSessionRoute({ method: 'GET' }, res, supabaseNoRow, 'u1', { env: {} });
  assert.equal(res.code, 405);
  const calls = [];
  const ok = fakeRes();
  await anamSessionRoute({ method: 'POST', body: { brief: 'Say hello', contactName: 'Tunde' } }, ok, supabaseNoRow, 'u1', {
    env: {}, getKey: async () => KEY, getAvatar: async () => ({ id: 'av1', name: 'Me' }), fetchImpl: okFetch(calls),
  });
  assert.equal(ok.code, 200);
  assert.equal(ok.body.sessionToken, TOKEN);
  assert.equal(JSON.stringify(ok.body).includes(KEY), false);
  assert.match(JSON.parse(calls[0].init.body).personaConfig.systemPrompt, /Say hello/);
});
