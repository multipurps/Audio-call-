// Chat with no minutes: answered on the server without touching the AI model, so it costs nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { database, loadApi, request } from './helpers.mjs';
import { NO_MINUTES_CHAT_REPLY } from '../lib/billing.js';

const MODEL_HOSTS = ['api.openai.com', 'openai.com', 'anthropic', 'groq', 'embeddings'];
async function setup(usageRows) {
  const db = database(usageRows ? { user_usage: usageRows } : {}, { funded: false });
  const network = [];
  const fetcher = async (url, options) => {
    network.push(String(url));
    if (String(url).includes('api.openai.com')) {
      const body = JSON.parse(options.body || '{}');
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: body.response_format ? JSON.stringify({ action: 'reply', reply: 'Hello from the model.' }) : 'Hello from the model.' } }], data: [{ embedding: [0, 0, 0] }] }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const { default: handler } = await loadApi('api/assistant.js', db, fetcher);
  const usedModel = () => network.some((u) => MODEL_HOSTS.some((h) => u.includes(h)));
  return { db, handler, network, usedModel };
}
// Results come from a separate VM context, so copy them into plain arrays before deep comparisons.
const assistantTexts = (r) => Array.from(r.data.messages.filter((m) => m.role === 'assistant').map((m) => m.content));

test('no usage row (a brand-new account): the reply is "buy minutes first" and the model is never called', async () => {
  const f = await setup();
  const r = await request(f.handler, 'send', { text: 'hello, how are you?' });
  assert.equal(r.code, 200);
  assert.equal(r.data.noMinutes, true);
  assert.deepEqual(assistantTexts(r), [NO_MINUTES_CHAT_REPLY]);
  assert.equal(f.usedModel(), false, `no model call, saw: ${f.network.join(', ')}`);
  assert.equal(f.network.length, 0, 'nothing external at all');
});

test('the exchange is saved so the chat history reads naturally', async () => {
  const f = await setup();
  await request(f.handler, 'send', { text: 'hello' });
  const saved = Array.from(f.db.tables.assistant_messages.map((m) => [m.role, m.content]));
  assert.deepEqual(saved, [['user', 'hello'], ['assistant', NO_MINUTES_CHAT_REPLY]]);
});

test('minutes used up (or only a fraction left) gets the same reply', async () => {
  for (const usage of [{ call_minutes_used: 60, monthly_minute_limit: 60, bonus_minutes: 0 }, { call_minutes_used: 59.5, monthly_minute_limit: 60, bonus_minutes: 0 }]) {
    const f = await setup([{ user_id: 'user-1', ...usage }]);
    const r = await request(f.handler, 'send', { text: 'hi' });
    assert.equal(r.data.noMinutes, true, JSON.stringify(usage));
    assert.equal(f.usedModel(), false);
  }
});

test('someone with minutes chats normally and the model is used', async () => {
  const f = await setup([{ user_id: 'user-1', call_minutes_used: 0, monthly_minute_limit: 0, bonus_minutes: 5 }]);
  const r = await request(f.handler, 'send', { text: 'hello' });
  assert.equal(r.code, 200);
  assert.notEqual(r.data.noMinutes, true);
  assert.equal(f.usedModel(), true);
  assert.ok(assistantTexts(r).length > 0);
  assert.ok(!assistantTexts(r).includes(NO_MINUTES_CHAT_REPLY));
});

test('"end the call" still works with no minutes, and costs no model call', async () => {
  const f = await setup();
  const r = await request(f.handler, 'send', { text: 'end the call' });
  assert.equal(r.code, 200);
  assert.notEqual(r.data.noMinutes, true);
  assert.match(assistantTexts(r)[0], /no active call/i);
  assert.equal(f.usedModel(), false);
});

test('a live voice turn on a call that was allowed to start is not cut off', async () => {
  const f = await setup();
  const r = await request(f.handler, 'send', { text: 'hello there', source: 'call' });
  assert.notEqual(r.data.noMinutes, true);
  assert.equal(f.usedModel(), true);
});

test('a photo with no minutes gets the same reply and never reaches the vision model', async () => {
  const f = await setup();
  const r = await request(f.handler, 'sendImage', { imageBase64: 'AAAA', mimeType: 'image/png', caption: 'look' });
  assert.equal(r.code, 200);
  assert.equal(r.data.noMinutes, true);
  assert.deepEqual(assistantTexts(r), [NO_MINUTES_CHAT_REPLY]);
  assert.equal(f.usedModel(), false);
});

test('the gate sits before any memory, embedding or model work, and fails open only if the balance cannot be read', () => {
  const src = readFileSync(new URL('../api/assistant.js', import.meta.url), 'utf8');
  const send = src.slice(src.indexOf('async function sendMessage'));
  const gate = send.indexOf('NO_MINUTES_CHAT_REPLY');
  assert.ok(gate > 0);
  for (const later of ['prepareTurnContext(', 'createChatCompletion(', 'fetchGlobalAi(']) {
    assert.ok(send.indexOf(later) > gate, `${later} must come after the minutes check`);
  }
  assert.match(send, /if \(left && left\.remaining < 1\)/);
});

test('the app refreshes its balance when the server says there are no minutes', () => {
  assert.match(readFileSync(new URL('../app.js', import.meta.url), 'utf8'), /if \(data\.noMinutes\) loadBalance\(\)/);
});
