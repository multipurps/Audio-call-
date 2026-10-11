import test from 'node:test';
import assert from 'node:assert/strict';
import { detectUserMemoryOperations, referencesPriorCall, formatMemoryBlockForPrompt } from '../lib/memoryManager.js';

test('standing do / don\'t rules are saved as instructions; one-offs and personal facts are not', () => {
  const rule = detectUserMemoryOperations('From now on, never mention the price unless I ask.').newFacts;
  assert.equal(rule.length, 1);
  assert.equal(rule[0].memory_type, 'instruction');
  assert.deepEqual(detectUserMemoryOperations("don't call him now, call at 5").newFacts, []);
  assert.notEqual(detectUserMemoryOperations('I always prefer window seats').newFacts[0]?.memory_type, 'instruction');
});

test('a newer rule on the same subject shares a key so it replaces the older one', () => {
  const a = detectUserMemoryOperations('Never mention the price').newFacts[0];
  const b = detectUserMemoryOperations('From now on always mention the price').newFacts[0];
  assert.equal(a.subject_key, b.subject_key);
});

test('earlier-call context is only used when this call asks for it', () => {
  assert.equal(referencesPriorCall('Call Ayo about the invoice'), false);
  assert.equal(referencesPriorCall('Call Ayo again'), true);
  assert.equal(referencesPriorCall('Follow up on the delivery'), true);
});

test('prompt block puts standing rules first and says memory is background only', () => {
  const block = formatMemoryBlockForPrompt({ instructionMemories: [{ content: 'Never mention the price' }], coreMemories: [{ content: 'Lives in Lyon' }] });
  assert.ok(block.indexOf('standing_instructions') < block.indexOf('core_semantic_memory'));
  assert.match(block, /background only/);
});
