// The summary must be produced from the WHOLE transcript and reach the chat thread and the call detail,
// whichever way the call ends: the End button, the other side hanging up, or the assistant ending it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { database, loadApi, request } from './helpers.mjs';
import { parseSummaryReply, transcriptForPrompt, formatSummaryForChat } from '../lib/callSession.js';

const SECRET = 'relay-secret-test';
const ENV = { RELAY_CALLBACK_SECRET: SECRET, OPENAI_API_KEY: 'test-only' };
const CHAT = '11111111-1111-1111-1111-111111111111';
const SUMMARY = {
  summary: 'Agreed to move lunch to 1pm at the window table; Ayo will email the menu.',
  topics: ['lunch'], decisions: ['1pm, window table'], commitments: ['Ayo emails the menu'],
  followups: ['email the menu'], incomplete: false, memories: [],
};

function turns(n = 6) {
  const list = [{ speaker: 'caller', content: 'OPENING-LINE we should plan lunch' }];
  for (let i = 0; i < n; i += 1) {
    list.push({ speaker: 'ai', content: `Emysa turn ${i}` }, { speaker: 'caller', content: `Caller turn ${i}` });
  }
  list.push({ speaker: 'caller', content: 'CLOSING-LINE thanks, bye' });
  return list;
}

const BUBBLE = formatSummaryForChat(SUMMARY.summary, SUMMARY);

function fixture({ platform = 'whatsapp', llm } = {}) {
  const db = database({
    chat_sessions: [{ id: CHAT, user_id: 'user-1', title: 'chat' }],
    assistant_messages: [],
    social_calls: [],
    whatsapp_accounts: [],
    calls: [{
      id: 'call-1', user_id: 'user-1', session_id: CHAT, platform, platform_call_id: 'pc-1',
      status: 'in_progress', answered_at: new Date(Date.now() - 90_000).toISOString(),
      objective: 'Plan lunch', transcript: turns(), created_at: new Date().toISOString(),
    }],
  });
  const llmBodies = [];
  const fetcher = async (url, options = {}) => {
    if (url.includes('api.openai.com')) {
      const body = JSON.parse(options.body);
      llmBodies.push(body);
      const reply = llm ? llm(llmBodies.length, body) : { content: JSON.stringify(SUMMARY) };
      if (reply.fail) return { ok: false, status: 500, text: async () => reply.fail, json: async () => ({}) };
      return { ok: true, json: async () => ({ choices: [{ message: { content: reply.content }, finish_reason: reply.finish || 'stop' }], model: 'gpt-6-luna' }) };
    }
    throw new Error(`Unexpected external call: ${url}`);
  };
  return { db, fetcher, llmBodies };
}

const call = (f) => f.db.tables.calls.find((c) => c.id === 'call-1');
const chatMessages = (f) => f.db.tables.assistant_messages.filter((m) => m.call_id === 'call-1');

async function relayReport(f, body) {
  const { default: handler } = await loadApi('api/social-calling.js', f.db, f.fetcher, ENV);
  const res = { code: 200, data: null, status(c) { this.code = c; return this; }, json(d) { this.data = d; return this; } };
  await handler({ method: 'POST', headers: { 'x-relay-secret': SECRET }, query: { action: 'relay-call-status' }, body }, res);
  return res;
}

test('End button: the full-call summary is stored on the call AND posted into the chat thread', async () => {
  const f = fixture();
  const { default: handler } = await loadApi('api/calls.js', f.db, f.fetcher, ENV);
  const res = await request(handler, 'hangup', { callId: 'call-1' });
  assert.equal(res.code, 200, JSON.stringify(res.data));

  assert.equal(call(f).status, 'completed');
  assert.equal(call(f).summary_status, 'completed');
  assert.equal(call(f).outcome_summary, SUMMARY.summary);
  const msgs = chatMessages(f);
  assert.equal(msgs.length, 1, 'exactly one chat message');
  assert.equal(msgs[0].content, BUBBLE);
  assert.match(msgs[0].content, /Agreed to move lunch to 1pm/);
  assert.equal(msgs[0].session_id, CHAT);

  const prompt = f.llmBodies[0].messages[1].content;
  assert.match(prompt, /OPENING-LINE/, 'the start of the call is in the summary input');
  assert.match(prompt, /CLOSING-LINE/, 'the end of the call is in the summary input');
});

test('the other side hangs up: summary stored and posted once', async () => {
  const f = fixture({ platform: 'whatsapp' });
  const res = await relayReport(f, { callId: 'call-1', userId: 'user-1', sessionId: 'call-pc-1', platform: 'whatsapp', status: 'completed', durationSeconds: 90 });
  assert.equal(res.code, 200, JSON.stringify(res.data));
  assert.equal(call(f).outcome_summary, SUMMARY.summary);
  assert.equal(chatMessages(f).length, 1);
  assert.equal(chatMessages(f)[0].content, BUBBLE);
});

test('the assistant ends the call (service end report): summary stored and posted once', async () => {
  const f = fixture({ platform: 'whatsapp' });
  // This is exactly the body pipecat's report_end posts after the assistant hangs up.
  const res = await relayReport(f, { callId: 'call-1', userId: 'user-1', sessionId: 'call-pc-1', platform: 'whatsapp', status: 'completed', durationSeconds: 75, contactName: 'Ayo' });
  assert.equal(res.code, 200, JSON.stringify(res.data));
  assert.equal(call(f).summary_status, 'completed');
  assert.equal(chatMessages(f).length, 1);
  assert.equal(chatMessages(f)[0].content, BUBBLE);
});

test('an in-app Emysa call is a briefing: ending it never produces a summary or a chat post', async () => {
  const f = fixture({ platform: 'app' });
  const { default: handler } = await loadApi('api/calls.js', f.db, f.fetcher, ENV);
  const res = await request(handler, 'hangup', { callId: 'call-1' });
  assert.equal(res.code, 200, JSON.stringify(res.data));
  assert.equal(call(f).status, 'completed');
  assert.equal(f.llmBodies.length, 0, 'no summary model call for an in-app briefing');
  assert.equal(chatMessages(f).length, 0);
});

test('End button followed by the service end report never duplicates the summary or the model call', async () => {
  const f = fixture();
  const { default: calls } = await loadApi('api/calls.js', f.db, f.fetcher, ENV);
  await request(calls, 'hangup', { callId: 'call-1' });
  await relayReport(f, { callId: 'call-1', userId: 'user-1', sessionId: 'call-pc-1', platform: 'whatsapp', status: 'completed', durationSeconds: 90 });
  assert.equal(chatMessages(f).length, 1);
  assert.equal(f.llmBodies.length, 1, 'summarised once');
});

test('a failed summary is reported honestly in the chat and keeps the real reason for the retry button', async () => {
  const f = fixture({ llm: () => ({ fail: 'model overloaded' }) });
  const { default: handler } = await loadApi('api/calls.js', f.db, f.fetcher, ENV);
  await request(handler, 'hangup', { callId: 'call-1' });
  assert.equal(call(f).summary_status, 'failed');
  assert.ok(call(f).summary_json.error, 'reason is stored on the call');
  const msgs = chatMessages(f);
  assert.equal(msgs.length, 1);
  assert.match(msgs[0].content, /couldn't write its summary/);
});

test('REGRESSION: a reply cut off at the token limit is retried with a bigger budget instead of failing', async () => {
  const cut = '{"summary":"Agreed to move lunch to 1pm at the window table; Ayo will email the menu.","topics":["lunch"],"decisions":["1pm';
  const f = fixture({ llm: (n) => (n === 1 ? { content: cut, finish: 'length' } : { content: JSON.stringify(SUMMARY) }) });
  const { default: handler } = await loadApi('api/calls.js', f.db, f.fetcher, ENV);
  await request(handler, 'hangup', { callId: 'call-1' });
  assert.equal(f.llmBodies.length, 2);
  assert.ok(f.llmBodies[1].max_completion_tokens > f.llmBodies[0].max_completion_tokens);
  assert.equal(call(f).summary_status, 'completed');
});

test('REGRESSION: if the reply is still cut off, what was written is kept (not "empty summary")', () => {
  const cut = '{"summary":"Agreed to move lunch to 1pm.","topics":["lunch","menu"],"learned":["likes windows"],"decisions":["1pm';
  const { parsed, salvaged } = parseSummaryReply(cut);
  assert.equal(salvaged, true);
  assert.equal(parsed.summary, 'Agreed to move lunch to 1pm.');
  assert.deepEqual(parsed.topics, ['lunch', 'menu']);
  assert.deepEqual(parsed.learned, ['likes windows']);
  assert.equal(parsed.decisions, undefined, 'an unfinished array is dropped, not guessed');
});

test('REGRESSION: a long call is summarised from its whole transcript (it used to keep only the last 120 lines)', () => {
  const long = [{ speaker: 'caller', content: 'FIRST-THING-SAID' }];
  for (let i = 0; i < 400; i += 1) long.push({ speaker: i % 2 ? 'ai' : 'caller', content: `line ${i} ${'x'.repeat(60)}` });
  const { text, omittedLines } = transcriptForPrompt(long);
  assert.equal(omittedLines, 0);
  assert.match(text, /FIRST-THING-SAID/);
  assert.match(text, /line 399 /);
});

test('only a truly huge transcript is trimmed, from the middle, and says so', () => {
  const huge = [{ speaker: 'caller', content: 'FIRST-THING-SAID' }];
  for (let i = 0; i < 2000; i += 1) huge.push({ speaker: 'ai', content: `line ${i} ${'y'.repeat(100)}` });
  huge.push({ speaker: 'caller', content: 'LAST-THING-SAID' });
  const { text, omittedLines } = transcriptForPrompt(huge);
  assert.ok(omittedLines > 0);
  assert.match(text, /FIRST-THING-SAID/);
  assert.match(text, /LAST-THING-SAID/);
  assert.match(text, /omitted for length/);
});
