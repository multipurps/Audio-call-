import test from 'node:test';
import assert from 'node:assert/strict';
import { describeMonitorMessage, describeMonitorClose, noAudioMessage } from '../lib/monitorStatus.js';

test('ready reports whether the assistant is on the call', () => {
  assert.match(describeMonitorMessage({ type: 'ready', callLive: false }).text, /not on this call yet/);
  assert.match(describeMonitorMessage({ type: 'ready', callLive: true }).text, /waiting for call audio/);
});

test('an auth refusal names the secret mismatch', () => {
  const info = describeMonitorMessage({ type: 'error', reason: 'auth-refused' });
  assert.equal(info.kind, 'error');
  assert.match(info.text, /ASSISTANT_BRIDGE_SECRET/);
});

test('a socket that never opened points at the URL / sleeping service', () => {
  assert.match(describeMonitorClose({ opened: false }), /PUBLIC_ASSISTANT_WS_URL/);
});

test('closes after opening are described, and explained errors are not repeated', () => {
  assert.match(describeMonitorClose({ opened: true, code: 1013 }), /restarting/);
  assert.match(describeMonitorClose({ opened: true, code: 1006, hadAudio: true }), /dropped/);
  assert.match(describeMonitorClose({ opened: true, code: 1006, hadAudio: false }), /before any audio/);
  assert.equal(describeMonitorClose({ opened: true, alreadyExplained: true }), null);
});

test('silence messages differ for an absent assistant vs a quiet line', () => {
  assert.match(noAudioMessage(false), /has not joined/);
  assert.match(noAudioMessage(true), /no call audio/);
});

test('unknown messages keep the current status', () => {
  assert.equal(describeMonitorMessage({ type: 'whatever' }), null);
  assert.equal(describeMonitorMessage(null), null);
});
