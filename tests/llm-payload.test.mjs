import test from 'node:test';
import assert from 'node:assert/strict';
import { buildChatPayload, isReasoningModel, createChatCompletion } from '../lib/llmClient.js';

const base = { messages: [{ role: 'user', content: 'hi' }], temperature: 0.65, max_tokens: 300 };

test('gpt-6-luna uses max_completion_tokens + reasoning_effort none, never max_tokens', () => {
  const p = buildChatPayload({ ...base, model: 'gpt-6-luna', env: {} });
  assert.equal(p.max_completion_tokens, 300);
  assert.equal(p.reasoning_effort, 'none');
  assert.equal(p.temperature, 0.65);
  assert.ok(!('max_tokens' in p));
});

test('non-none effort drops temperature (unsupported with reasoning on)', () => {
  const p = buildChatPayload({ ...base, model: 'gpt-6-luna', env: { LLM_REASONING_EFFORT: 'low' } });
  assert.equal(p.reasoning_effort, 'low');
  assert.ok(!('temperature' in p));
});

test('classic models keep max_tokens and temperature, no reasoning params', () => {
  const p = buildChatPayload({ ...base, model: 'openai/gpt-4o-mini', env: {} });
  assert.equal(p.max_tokens, 300);
  assert.equal(p.temperature, 0.65);
  assert.ok(!('reasoning_effort' in p) && !('max_completion_tokens' in p));
  assert.equal(isReasoningModel('openai/gpt-6-luna'), true);
  assert.equal(isReasoningModel('gpt-4o-mini'), false);
});

test('tools and response_format are forwarded', () => {
  const tools = [{ type: 'function', function: { name: 'x' } }];
  const p = buildChatPayload({ ...base, model: 'gpt-6-luna', tools, tool_choice: 'auto', response_format: { type: 'json_object' }, env: {} });
  assert.deepEqual(p.tools, tools);
  assert.equal(p.tool_choice, 'auto');
  assert.deepEqual(p.response_format, { type: 'json_object' });
});

test('failed primary attempts are logged, then the fallback result is used', async () => {
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (m) => warnings.push(String(m));
  try {
    const calls = [];
    const fetchImpl = async (url, opts) => {
      calls.push({ url, body: JSON.parse(opts.body) });
      if (url.includes('openai.com')) {
        return { ok: false, status: 400, text: async () => '{"error":"boom"}' };
      }
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) };
    };
    const res = await createChatCompletion({
      messages: base.messages,
      env: { OPENAI_API_KEY: 'sk-test', FAL_KEY: 'fal-test' },
      fetchImpl,
    });
    assert.equal(res.ok, true);
    assert.equal(calls[0].body.max_completion_tokens, 450);
    assert.ok(!('max_tokens' in calls[0].body));
    assert.ok(warnings.some((w) => w.includes('[llm]') && w.includes('400')));
  } finally {
    console.warn = origWarn;
  }
});
