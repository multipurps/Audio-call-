import test from 'node:test';
import assert from 'node:assert/strict';
import { VOICE_SLOTS, voiceSlotsFor, premiumForUser } from '../lib/plan.js';

const supa = (result) => ({ from: () => ({ select() { return this; }, eq() { return this; }, maybeSingle: async () => result }) });
const day = 864e5;

test('a free account has 1 custom voice slot and Premium has 5', () => {
  assert.deepEqual({ ...VOICE_SLOTS }, { free: 1, premium: 5 });
  assert.equal(voiceSlotsFor(false), 1);
  assert.equal(voiceSlotsFor(true), 5);
});

test('premiumForUser: active, expired, never bought', async () => {
  assert.deepEqual(await premiumForUser(supa({ data: { premium_until: new Date(Date.now() + day).toISOString() }, error: null }), 'u'), { premium: true, known: true });
  assert.deepEqual(await premiumForUser(supa({ data: { premium_until: new Date(Date.now() - day).toISOString() }, error: null }), 'u'), { premium: false, known: true });
  assert.deepEqual(await premiumForUser(supa({ data: null, error: null }), 'u'), { premium: false, known: true });
});

test('premiumForUser: a database that predates sql/037 has no Premium users; any other failure is "unknown", never "free"', async () => {
  assert.deepEqual(await premiumForUser(supa({ data: null, error: { code: '42703', message: 'column user_usage.premium_until does not exist' } }), 'u'), { premium: false, known: true });
  assert.deepEqual(await premiumForUser(supa({ data: null, error: { message: 'connection reset' } }), 'u'), { premium: false, known: false });
  const throwing = { from: () => { throw new Error('boom'); } };
  assert.deepEqual(await premiumForUser(throwing, 'u'), { premium: false, known: false });
  assert.deepEqual(await premiumForUser(supa({ data: null, error: null }), ''), { premium: false, known: false });
});
