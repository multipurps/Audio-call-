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

test('failed calls say it never rang; connected calls are left to the summary', () => {
  assert.match(d({ rawStatus: 'failed', reason: 'not registered' }), /did not connect.*never rang/);
  assert.equal(d({ rawStatus: 'completed', answered: true }), null);
});
