import test from 'node:test';
import assert from 'node:assert/strict';
import { isBlockedModel, allowedModel } from '../lib/modelGuard.js';
import { resolveLlmEndpoints } from '../lib/llmClient.js';

test('Sol models are blocked, other names are not', () => {
  for (const n of ['gpt-6-sol', 'gpt-6.1-sol', 'openai/gpt-6-sol', 'GPT-6.1-SOL', 'sol', 'gpt-6_sol']) assert.equal(isBlockedModel(n), true, n);
  for (const n of ['gpt-6-luna', 'gpt-live-1', 'gpt-4o-mini', 'solid-model', 'console-x', '', null]) assert.equal(isBlockedModel(n), false, String(n));
});

test('allowedModel swaps a blocked name for the fallback', () => {
  assert.equal(allowedModel('gpt-6.1-sol', 'gpt-6-luna'), 'gpt-6-luna');
  assert.equal(allowedModel('gpt-6-luna', 'x'), 'gpt-6-luna');
  assert.equal(allowedModel('', 'gpt-6-luna'), 'gpt-6-luna');
});

test('an env var pointing at Sol never reaches the endpoint list', () => {
  const eps = resolveLlmEndpoints({ LUNA_API_KEY: 'k', LUNA_MODEL: 'gpt-6.1-sol' });
  assert.ok(eps.length > 0);
  for (const ep of eps) assert.equal(isBlockedModel(ep.model), false);
});
