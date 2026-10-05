// In-app Emysa call: a live GPT-Live session started through a short-lived,
// per-session token. The token scheme must match pipecat-service/app/app_call.py:
//   token = `${exp}.${userId}.${hex(hmac_sha256(SECRET, `appcall:${sessionId}:${userId}:${exp}`))}`
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { database, loadApi, request } from './helpers.mjs';

const SECRET = 'app-call-secret-test';
const ENV = { ASSISTANT_BRIDGE_SECRET: SECRET, PUBLIC_ASSISTANT_WS_URL: 'wss://assistant.test/stream', OPENAI_API_KEY: 'test-only' };

async function setup(env = ENV, extra = {}) {
  const db = database({ calls: [], voice_preferences: [], voice_profiles: [], chat_sessions: [], ...extra });
  const { default: handler } = await loadApi('api/calls.js', db, async (u) => { throw new Error(`Unexpected external call: ${u}`); }, env);
  return { db, handler };
}

test('app-call-start creates the call row and mints a token matching the pipecat scheme', async () => {
  const f = await setup();
  const res = await request(f.handler, 'app-call-start', {});
  assert.equal(res.code, 200, JSON.stringify(res.data));
  const { callId, sessionId, url, engine, sampleRate } = res.data;
  assert.ok(callId);
  assert.match(sessionId, /^call-/);
  assert.equal(sampleRate, 16000);
  assert.equal(engine, 'gpt-live');
  assert.match(url, /^wss:\/\/assistant\.test\/app-call\/call-/);

  const token = new URL(url.replace('wss://', 'https://')).searchParams.get('token');
  const [exp, userId, sig] = token.split('.');
  assert.equal(userId, 'user-1');
  assert.equal(sig, createHmac('sha256', SECRET).update(`appcall:${sessionId}:user-1:${exp}`).digest('hex'));
  assert.ok(Number(exp) - Date.now() / 1000 <= 600 + 5, 'token is short-lived');

  const rows = f.db.tables?.calls || (await f.db.from('calls').select('*')).data;
  const row = rows.find((r) => r.id === callId);
  assert.equal(row.platform, 'app');
  assert.equal(row.status, 'in_progress');
  assert.equal(row.user_id, 'user-1');
});

test('GPT-Live always, except when the user chose their ready cloned voice', async () => {
  const clone = { user_id: 'user-1', status: 'ready', provider_voice_id: 'fish-abc1234' };
  const chosenClone = await setup(ENV, { voice_profiles: [clone], voice_preferences: [{ user_id: 'user-1', use_custom_voice: true }] });
  assert.equal((await request(chosenClone.handler, 'app-call-start', {})).data.engine, 'classic');

  const chosenStandard = await setup(ENV, { voice_profiles: [clone], voice_preferences: [{ user_id: 'user-1', use_custom_voice: false, live_voice_id: 'tempo' }] });
  assert.equal((await request(chosenStandard.handler, 'app-call-start', {})).data.engine, 'gpt-live');

  const noClone = await setup();
  assert.equal((await request(noClone.handler, 'app-call-start', {})).data.engine, 'gpt-live');
});

test('app-call-start needs auth, POST, and names missing configuration', async () => {
  const f = await setup();
  assert.equal((await request(f.handler, 'app-call-start', {}, { auth: false })).code, 401);
  assert.equal((await request(f.handler, 'app-call-start', {}, { method: 'GET' })).code, 405);
  const noSecret = await setup({ ...ENV, ASSISTANT_BRIDGE_SECRET: '' });
  assert.equal((await request(noSecret.handler, 'app-call-start', {})).data.code, 'missing-secret');
  const insecure = await setup({ ...ENV, PUBLIC_ASSISTANT_WS_URL: 'ws://assistant.test/stream' });
  assert.equal((await request(insecure.handler, 'app-call-start', {})).data.code, 'insecure-url');
});
