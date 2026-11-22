import test from 'node:test';
import assert from 'node:assert/strict';
import { sameNumber } from '../lib/phoneNumbers.js';

test('the same number written differently is the same number', () => {
  assert.equal(sameNumber('+18042970754', '+1 (804) 297-0754'), true);
  assert.equal(sameNumber('+18042970754', '8042970754'), true);
  assert.equal(sameNumber('+2348011112222', '08011112222'), true);
});

test('different numbers and empty values never match', () => {
  assert.equal(sameNumber('+18042970754', '+18042970755'), false);
  assert.equal(sameNumber('+18042970754', ''), false);
  assert.equal(sameNumber(null, '+18042970754'), false);
  assert.equal(sameNumber('12345', '+112345'), false);
});
