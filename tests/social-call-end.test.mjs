import test from 'node:test';
import assert from 'node:assert/strict';
import { describeSocialCallEnd } from '../lib/socialCallEnd.js';

const d = (o) => describeSocialCallEnd({ who: 'Sam', channel: 'WhatsApp', ...o });

test('declined, busy, rang out and voicemail are told apart with the action taken', () => {
  assert.match(d({ rawStatus: 'rejected' }), /declined.*did not retry/);
  assert.match(d({ rawStatus: 'busy' }), /busy.*ended the call/);
  assert.match(d({ rawStatus: 'unanswered' }), /didn't pick up.*rang out/);
  assert.match(d({ rawStatus: 'ended', reason: 'voicemail' }), /voicemail.*without leaving a message/);
});

test('failed calls say only that they did not connect; no claim about ringing or the recipient\'s app', () => {
  const text = d({ rawStatus: 'failed', reason: 'not registered' });
  assert.match(text, /did not connect/);
  assert.match(text, /don't know why/);
  assert.doesNotMatch(text, /never rang|check that they have/i);
  assert.equal(d({ rawStatus: 'completed', answered: true }), null);
});
