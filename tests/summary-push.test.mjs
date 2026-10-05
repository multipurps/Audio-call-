import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSummaryPushPayload, sendCallSummaryPush } from '../lib/summaryPush.js';

const env = { VAPID_PUBLIC_KEY: 'pub', VAPID_PRIVATE_KEY: 'priv', VAPID_SUBJECT: 'mailto:test@example.com' };

function fakeSupabase(subs, deleted = []) {
  return {
    from() {
      return {
        select() { return this; },
        eq: async () => ({ data: subs, error: null }),
        delete() { return { eq: async (_c, id) => { deleted.push(id); return {}; } }; },
      };
    },
  };
}

test('payload deep-links to the call and truncates long summaries', () => {
  const p = buildSummaryPushPayload('abc 1', 'x'.repeat(300), 'Ada');
  assert.equal(p.url, './index.html?callId=abc%201');
  assert.ok(p.body.length <= 140);
  assert.equal(p.title, 'Call summary: Ada');
});

test('sends to every subscription of the user', async () => {
  const sent = [];
  const sender = { setVapidDetails() {}, sendNotification: async (s, body) => { sent.push([s.endpoint, JSON.parse(body).callId]); } };
  const r = await sendCallSummaryPush(fakeSupabase([{ id: 1, endpoint: 'e1', p256dh: 'a', auth: 'b' }, { id: 2, endpoint: 'e2', p256dh: 'a', auth: 'b' }]), { userId: 'u', callId: 'c1', summary: 'Done.', env, sender });
  assert.deepEqual(r, { status: 'sent', sent: 2, failed: 0 });
  assert.equal(sent.length, 2);
});

test('removes expired subscriptions (410) and never throws', async () => {
  const deleted = [];
  const sender = { setVapidDetails() {}, sendNotification: async () => { const e = new Error('gone'); e.statusCode = 410; throw e; } };
  const r = await sendCallSummaryPush(fakeSupabase([{ id: 7, endpoint: 'e', p256dh: 'a', auth: 'b' }], deleted), { userId: 'u', callId: 'c', summary: 's', env, sender });
  assert.equal(r.failed, 1);
  assert.deepEqual(deleted, [7]);
});

test('skips quietly when VAPID env is missing or no subscriptions exist', async () => {
  const sender = { setVapidDetails() { throw new Error('should not be called'); }, sendNotification: async () => {} };
  assert.equal((await sendCallSummaryPush(fakeSupabase([]), { userId: 'u', callId: 'c', summary: 's', env: {}, sender })).status, 'not-configured');
  const sender2 = { setVapidDetails() {}, sendNotification: async () => {} };
  assert.equal((await sendCallSummaryPush(fakeSupabase([]), { userId: 'u', callId: 'c', summary: 's', env, sender: sender2 })).status, 'no-subscriptions');
});
