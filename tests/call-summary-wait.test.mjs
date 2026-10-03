// A trigger that loses the summary claim must report the real summary, not a
// generic "Finished the call" line.
import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForCallSummary } from '../lib/callSession.js';

function fakeSupabase(rows) {
  let i = 0;
  return {
    from() {
      return {
        select() { return this; },
        eq() { return this; },
        async maybeSingle() { return { data: rows[Math.min(i++, rows.length - 1)] }; },
      };
    },
  };
}

test('returns the summary once the claimant finishes', async () => {
  const sb = fakeSupabase([
    { summary_status: 'pending', outcome_summary: null },
    { summary_status: 'completed', outcome_summary: 'Asked about his daughters; all well.' },
  ]);
  const r = await waitForCallSummary(sb, 'c1', { timeoutMs: 1000, intervalMs: 5 });
  assert.equal(r.status, 'completed');
  assert.match(r.summary, /daughters/);
});

test('reports failed and skipped without waiting out the timeout', async () => {
  assert.equal((await waitForCallSummary(fakeSupabase([{ summary_status: 'failed' }]), 'c', { timeoutMs: 1000, intervalMs: 5 })).status, 'failed');
  assert.equal((await waitForCallSummary(fakeSupabase([{ summary_status: 'skipped' }]), 'c', { timeoutMs: 1000, intervalMs: 5 })).status, 'skipped');
});

test('gives up as pending when the claimant never finishes', async () => {
  const r = await waitForCallSummary(fakeSupabase([{ summary_status: 'pending', outcome_summary: null }]), 'c', { timeoutMs: 30, intervalMs: 10 });
  assert.equal(r.status, 'pending');
});
