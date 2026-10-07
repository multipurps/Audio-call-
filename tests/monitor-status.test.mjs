import test from 'node:test';
import assert from 'node:assert/strict';
import { describeMonitorMessage, describeMonitorClose, noAudioMessage } from '../lib/monitorStatus.js';

test('ready only speaks up when the call has not started; otherwise the status is left alone', () => {
  assert.match(describeMonitorMessage({ type: 'ready', callLive: false }).text, /Waiting for the call to start/);
  assert.equal(describeMonitorMessage({ type: 'ready', callLive: true }), null);
});

test('an auth refusal is a plain message that names no configuration', () => {
  const info = describeMonitorMessage({ type: 'error', reason: 'auth-refused' });
  assert.equal(info.kind, 'error');
  assert.match(info.text, /isn.t available right now/);
  assert.doesNotMatch(info.text, /SECRET|Vercel|service/i);
});

test('a socket that never opened tells the user to check their connection, not the config', () => {
  const text = describeMonitorClose({ opened: false });
  assert.match(text, /Check your connection/);
  assert.doesNotMatch(text, /PUBLIC_|wss|Render|service/i);
});

test('closes after opening are described, and explained errors are not repeated', () => {
  assert.match(describeMonitorClose({ opened: true, code: 1013 }), /interrupted/);
  assert.match(describeMonitorClose({ opened: true, code: 1006, hadAudio: true }), /dropped/);
  assert.match(describeMonitorClose({ opened: true, code: 1006, hadAudio: false }), /before any audio/);
  assert.equal(describeMonitorClose({ opened: true, alreadyExplained: true }), null);
});

test('silence messages differ for an absent assistant vs a quiet line', () => {
  assert.match(noAudioMessage(false), /Nothing to hear yet/);
  assert.match(noAudioMessage(true), /No audio yet/);
});

test('unknown messages keep the current status', () => {
  assert.equal(describeMonitorMessage({ type: 'whatever' }), null);
  assert.equal(describeMonitorMessage(null), null);
});
