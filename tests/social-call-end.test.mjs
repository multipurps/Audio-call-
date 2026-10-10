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

test('Do Not Disturb is only named when the relay reported it', () => {
  const out = describeSocialCallEnd({ rawStatus: 'no_answer', reason: 'do_not_disturb', who: 'Ariana' });
  assert.match(out, /Do Not Disturb/);
  assert.doesNotMatch(describeSocialCallEnd({ rawStatus: 'no_answer', reason: 'timeout', who: 'Ariana' }), /Do Not Disturb/);
});

test('an end with no reason says exactly that, and a block is never named', () => {
  const out = describeSocialCallEnd({ rawStatus: 'failed', reason: 'user_ended', who: 'Ariana' });
  assert.match(out, /ended before it was answered/);
  assert.match(out, /did not say why/);
  assert.doesNotMatch(out, /block/i);
});
