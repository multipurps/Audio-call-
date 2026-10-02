import test from 'node:test';
import assert from 'node:assert/strict';
import { describeCallEnd } from '../lib/callOutcome.js';

const d = (o) => describeCallEnd({ name: 'Sam', ...o });

test('busy vs declined vs rang out are told apart', () => {
  assert.match(d({ twilioStatus: 'busy', sipResponseCode: 486 }).summary, /line was busy/);
  assert.match(d({ twilioStatus: 'busy', sipResponseCode: 603 }).summary, /declined/);
  assert.match(d({ twilioStatus: 'no-answer' }).summary, /rang but nobody picked up/);
});

test('voicemail is named and says the call was ended', () => {
  const r = d({ twilioStatus: 'completed', answeredBy: 'machine_start' });
  assert.equal(r.reason, 'voicemail');
  assert.match(r.summary, /voicemail.*ended the call/);
});

test('failed calls give the real reason, not a generic failure', () => {
  assert.match(d({ twilioStatus: 'failed', sipResponseCode: 404 }).summary, /doesn't exist/);
  assert.match(d({ twilioStatus: 'failed', errorCode: 21215 }).summary, /aren't enabled/);
  assert.match(d({ twilioStatus: 'failed' }).summary, /nothing rang/);
});

test('connected calls are left to the transcript summary', () => {
  const r = d({ twilioStatus: 'completed' });
  assert.equal(r.status, 'completed');
  assert.equal(r.summary, null);
});

test('user cancel is not called a failure of the number', () => {
  assert.match(d({ twilioStatus: 'canceled', byUser: true }).summary, /You ended the call/);
});
