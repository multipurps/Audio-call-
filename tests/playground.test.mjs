import test from 'node:test';
import assert from 'node:assert/strict';
import { playgroundRoute } from '../lib/playground.js';

function fake({ remaining = 10, row = null } = {}) {
  const calls = { inserts: [], updates: [] };
  const supabase = {
    from(t) {
      const q = {
        _t: t,
        select() { return q; }, eq() { return q; },
        insert(r) { calls.inserts.push(r); q._ins = true; return q; },
        update(r) { calls.updates.push(r); q._upd = true; return q; },
        single: async () => ({ data: { id: '11111111-1111-1111-1111-111111111111' }, error: null }),
        maybeSingle: async () => (t === 'user_usage'
          ? { data: { call_minutes_used: 0, monthly_minute_limit: remaining, bonus_minutes: 0 }, error: null }
          : { data: row, error: null }),
        then(res) { res({ error: null }); },
      };
      return q;
    },
    rpc: async () => ({}),
  };
  return { supabase, calls };
}
const mkRes = () => { const r = { code: 0, body: null, status(c) { r.code = c; return r; }, json(b) { r.body = b; return r; } }; return r; };

test('playground start charges the first minute as video and refuses under 2 credits', async () => {
  const a = fake({ remaining: 10 }); const r = mkRes();
  await playgroundRoute({ method: 'POST', body: { op: 'start', kind: 'avatar' } }, r, a.supabase, 'u1');
  assert.equal(r.code, 200);
  assert.equal(a.calls.inserts[0].is_video, true);
  assert.equal(a.calls.inserts[0].duration_seconds, 1);
  const b = fake({ remaining: 1 }); const r2 = mkRes();
  await playgroundRoute({ method: 'POST', body: { op: 'start' } }, r2, b.supabase, 'u1');
  assert.equal(r2.code, 402);
  assert.equal(b.calls.inserts.length, 0);
});

test('playground tick bills elapsed server time', async () => {
  const created = new Date(Date.now() - 95_000).toISOString();
  const a = fake({ remaining: 10, row: { id: 'x', created_at: created, status: 'in_progress' } }); const r = mkRes();
  await playgroundRoute({ method: 'POST', body: { op: 'tick', id: '11111111-1111-1111-1111-111111111111' } }, r, a.supabase, 'u1');
  assert.equal(r.code, 200);
  assert.ok(a.calls.updates[0].duration_seconds >= 95 && a.calls.updates[0].duration_seconds <= 97);
});
