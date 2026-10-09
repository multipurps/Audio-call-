// Regression tests for the WhatsApp retry incident: attempt state, retry identity,
// owner-link problems kept away from the recipient, stale/missing events, repeated retries.
import test from 'node:test';
import assert from 'node:assert/strict';
import { database } from './helpers.mjs';
import {
  appendAttemptEvent, attemptFacts, attemptStateForProviderStatus, classifyPlacementError,
  isRetryCommand, ownerMessageFor, planRetry, stripLanguagePrefix,
} from '../lib/callAttempts.js';
import { createCallRecord, markCallFailed, recordAttemptEvent } from '../lib/callSession.js';
import { describeSocialCallEnd } from '../lib/socialCallEnd.js';

test('"Try again" and its variants are retry commands; real objectives are not', () => {
  for (const t of ['Try again', 'try again.', 'call him again', 'Retry', 'call her back', 'one more time', 'again']) assert.ok(isRetryCommand(t), t);
  for (const t of ['Call Sam and say the venue is booked', 'Try again on Friday about the invoice', 'hello']) assert.ok(!isRetryCommand(t), t);
});

test('retry keeps recipient, number, platform and the ORIGINAL objective and instructions', () => {
  const calls = [
    { id: 'c1', contact_id: 'k1', to_number: '+2348000000001', platform: 'whatsapp', status: 'no_answer', attempt_number: 1,
      objective: 'Speak only in French for this entire call, regardless of what language this instruction is written in. Ask about the invoice',
      instructions: 'Ask about the invoice, keep it casual', created_at: '2026-10-09T10:00:00Z' },
  ];
  const plan = planRetry(calls, { channel: 'whatsapp' });
  assert.equal(plan.toNumber, '+2348000000001');
  assert.equal(plan.contactId, 'k1');
  assert.equal(plan.platform, 'whatsapp');
  assert.equal(plan.objective, 'Ask about the invoice', 'language prefix is not stacked');
  assert.equal(plan.instructions, 'Ask about the invoice, keep it casual');
  assert.equal(plan.rootId, 'c1');
  assert.equal(plan.attemptNumber, 2);
});

test('legacy rows whose instructions are the retry wording do not carry it forward', () => {
  const plan = planRetry([{ id: 'c2', retry_of: 'c1', attempt_number: 2, to_number: '+1', platform: 'whatsapp', objective: 'x', instructions: 'Try again' },
    { id: 'c1', to_number: '+1', platform: 'whatsapp', objective: 'x', instructions: 'Ask about the invoice' }]);
  assert.equal(plan.instructions, null);
  assert.equal(plan.attemptNumber, 3);
  assert.equal(plan.rootId, 'c1');
});

test('retry after no answer, then recipient answers on the second attempt: each attempt keeps its own events', async () => {
  const db = database({ calls: [] });
  const first = await createCallRecord(db, 'u1', { platform: 'whatsapp', toNumber: '+1', objective: 'o', contactId: 'k1' });
  await recordAttemptEvent(db, first.id, { state: 'ringing' });
  await recordAttemptEvent(db, first.id, { state: 'ended', code: 'no_answer' });
  const second = await createCallRecord(db, 'u1', { platform: 'whatsapp', toNumber: '+1', objective: 'o', contactId: 'k1', retryOf: first.id, attemptNumber: 2 });
  await recordAttemptEvent(db, second.id, { state: 'ringing' });
  await recordAttemptEvent(db, second.id, { state: 'answered' });
  const [a, b] = ['calls'].flatMap(() => [db.tables.calls.find((r) => r.id === first.id), db.tables.calls.find((r) => r.id === second.id)]);
  assert.deepEqual(attemptFacts(a).states, ['requested', 'ringing', 'ended']);
  assert.equal(attemptFacts(a).answered, false);
  assert.equal(attemptFacts(b).answered, true);
  assert.equal(b.retry_of, first.id);
  assert.equal(b.attempt_number, 2);
});

test('DND / unavailable: no ringing event means the ring is UNKNOWN, never "didn\'t ring"', () => {
  const f = attemptFacts({ status: 'no_answer', attempt_events: [{ state: 'requested' }, { state: 'unknown' }] });
  assert.equal(f.rang, null);
  assert.equal(f.answered, false);
  const text = describeSocialCallEnd({ rawStatus: 'failed', reason: 'unreachable' });
  assert.doesNotMatch(text, /never rang|have WhatsApp/i);
});

test('stale and duplicate events are not recorded', () => {
  let ev = appendAttemptEvent([], { state: 'requested' });
  ev = appendAttemptEvent(ev, { state: 'ringing' });
  ev = appendAttemptEvent(ev, { state: 'answered' });
  assert.equal(appendAttemptEvent(ev, { state: 'ringing' }), null, 'late ringing after answered');
  assert.equal(appendAttemptEvent(ev, { state: 'answered' }), null, 'redelivery');
  assert.equal(appendAttemptEvent(ev, { state: 'bogus' }), null);
});

test('missing events stay unknown; "disconnected" with no talk time is unknown, not failed', () => {
  assert.equal(attemptStateForProviderStatus('disconnected', { durationSeconds: 0 }), 'unknown');
  assert.equal(attemptStateForProviderStatus('disconnected', { durationSeconds: 12 }), 'ended');
  assert.equal(attemptFacts({}).unknown, true);
  assert.equal(attemptFacts({}).rang, null);
});

test('owner WhatsApp disconnect is an owner-link problem with an owner-facing message, not a recipient fact', () => {
  const c = classifyPlacementError(new Error('WhatsApp is not connected — link it in Profile first.'));
  assert.equal(c.scope, 'owner_link');
  assert.equal(c.ownerLinkDown, true);
  const msg = ownerMessageFor(c, { label: 'Sam', channelName: 'WhatsApp' });
  assert.match(msg, /Your WhatsApp link needs reconnecting/);
  assert.doesNotMatch(msg, /Sam.*(not on|doesn't have)/i);
  const stale = Object.assign(new Error('WhatsApp session expired - please reconnect WhatsApp and try again'), { statusCode: 409 });
  assert.equal(classifyPlacementError(stale).scope, 'owner_link');
});

test('an assistant-join failure never unlinks the owner; temporary provider errors are unknown, not failed', () => {
  const join = Object.assign(new Error('the call was placed but the assistant could not join it (bridge not connected)'), { statusCode: 502 });
  const j = classifyPlacementError(join);
  assert.equal(j.ownerLinkDown, false);
  const timeout = classifyPlacementError(Object.assign(new Error('request timed out'), { statusCode: 504 }));
  assert.equal(timeout.scope, 'provider_temporary');
  assert.equal(timeout.attemptState, 'unknown');
  assert.match(ownerMessageFor(timeout, { label: 'Sam', channelName: 'WhatsApp' }), /can't tell whether/);
});

test('a failed placement is stored for the owner but can never be mistaken for a conversation summary', async () => {
  const db = database({ calls: [{ id: 'f1', user_id: 'u1', status: 'queued', attempt_events: [] }] });
  await markCallFailed(db, 'f1', 'WhatsApp is not connected', { scope: 'owner_link', ownerMessage: 'Your WhatsApp link needs reconnecting.' });
  const row = db.tables.calls[0];
  assert.equal(row.status, 'failed');
  assert.equal(row.failure_scope, 'owner_link');
  assert.equal(row.summary_status, 'skipped');
  assert.deepEqual(attemptFacts(row).states, ['failed']);
});

test('simultaneous / repeated retries: the unique attempt index lets exactly one through', async () => {
  const db = database({ calls: [{ id: 'root', user_id: 'u1' }] });
  const real = db.from.bind(db);
  // Emulate the (retry_of, attempt_number) unique index from sql/029.
  db.from = (table) => {
    const q = real(table);
    if (table !== 'calls') return q;
    const insert = q.insert.bind(q);
    q.insert = (value) => {
      const inner = insert(value);
      const wrapper = {
        select: () => wrapper,
        single: () => { inner.single(); return wrapper; },
        // The index is enforced when the write executes, like Postgres does.
        then: (ok, fail) => {
          if (value.retry_of && db.tables.calls.some((r) => r.retry_of === value.retry_of && r.attempt_number === value.attempt_number)) {
            return Promise.resolve({ data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "calls_retry_attempt_unique"' } }).then(ok, fail);
          }
          return inner.then(ok, fail);
        },
      };
      return wrapper;
    };
    return q;
  };
  const args = { platform: 'whatsapp', toNumber: '+1', objective: 'o', retryOf: 'root', attemptNumber: 2 };
  const [a, b] = await Promise.all([createCallRecord(db, 'u1', args), createCallRecord(db, 'u1', args)]);
  assert.equal(db.tables.calls.filter((r) => r.retry_of === 'root').length, 1);
  assert.equal(a.id, b.id);
  assert.ok(a.duplicateOfAttempt || b.duplicateOfAttempt, 'the loser is told it is a duplicate and must not dial');
});

test('stripLanguagePrefix removes stacked directives only', () => {
  const p = 'Speak only in Hausa for this entire call, regardless of what language this instruction is written in. ';
  assert.equal(stripLanguagePrefix(p + p + 'Ask about rent'), 'Ask about rent');
  assert.equal(stripLanguagePrefix('Ask about rent'), 'Ask about rent');
});
