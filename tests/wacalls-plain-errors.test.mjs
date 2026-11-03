import test from 'node:test';
import assert from 'node:assert/strict';
import { plainCallError } from '../lib/wacallsFlyCalls.js';

test('a number WhatsApp cannot find gets a plain sentence, not the technical text', () => {
  const raw = 'WaCalls POST /api/sessions/x/calls failed (HTTP 500): usync returned no LID for 2349038226059 (peer unreachable or not on WhatsApp)';
  const plain = plainCallError(raw);
  assert.match(plain, /couldn't find that number/);
  assert.doesNotMatch(plain, /usync|HTTP|WaCalls|LID/);
});

test('a busy WhatsApp line gets a wait-and-retry sentence', () => {
  assert.match(plainCallError('operator already on a call'), /Another WhatsApp call is still open/);
});

test('an unlinked account gets a link-first sentence', () => {
  assert.match(plainCallError('WhatsApp is not linked. Connect it in Connected accounts first.'), /link WhatsApp first/);
});

test('a disconnected WhatsApp gets a check-connection sentence', () => {
  assert.match(plainCallError('websocket not connected'), /disconnected right now/);
});

test('an unknown failure gets a generic plain sentence', () => {
  assert.equal(plainCallError('something odd'), 'The WhatsApp call could not start. Try again in a moment.');
  assert.equal(plainCallError(undefined), 'The WhatsApp call could not start. Try again in a moment.');
});
