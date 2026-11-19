import test from 'node:test';
import assert from 'node:assert/strict';
import { stateFlyCall, endFlyCall, startFlyWhatsappCall } from '../lib/wacallsFlyCalls.js';

// A small Supabase stand-in that records every write, with the calls row it should find.
function fakeDb(callRow = {}) {
  const updates = [];
  return {
    updates,
    from(table) {
      const b = { table, filters: [], patch: null };
      b.select = () => b;
      b.eq = (k, v) => { b.filters.push(['eq', k, v]); return b; };
      b.neq = (k, v) => { b.filters.push(['neq', k, v]); return b; };
      b.is = (k, v) => { b.filters.push(['is', k, v]); return b; };
      b.update = (patch) => { b.patch = patch; return b; };
      b.maybeSingle = async () => {
        if (table === 'whatsapp_accounts') return { data: { wacalls_session_id: 'sid-1' }, error: null };
        return { data: { id: 'row-1', ...callRow }, error: null };
      };
      b.then = (res, rej) => {
        if (b.patch) updates.push({ table, patch: b.patch, filters: b.filters });
        return Promise.resolve({ data: null, error: null }).then(res, rej);
      };
      return b;
    },
  };
}

test('a call that is answered stamps answered_at once, and nothing is billed yet', async () => {
  const db = fakeDb({ answered_at: null, duration_seconds: null });
  const out = await stateFlyCall({ supabase: db, userId: 'u1', callId: 'c-1', deps: { flyCallState: async () => ({ state: 'active' }) } });
  assert.equal(out.state, 'active');
  const stamp = db.updates.find((u) => u.patch.answered_at);
  assert.ok(stamp, 'answered_at is written');
  assert.deepEqual(stamp.filters.find((f) => f[0] === 'is'), ['is', 'answered_at', null], 'only when it is not stamped yet');
  assert.equal(db.updates.some((u) => u.patch.duration_seconds !== undefined), false, 'no duration while the call is still up');
});

test('when the call ends, the talk time is written as duration_seconds (the trigger bills from it)', async () => {
  const answered = new Date(Date.now() - 90_000).toISOString();
  const db = fakeDb({ answered_at: answered, duration_seconds: null });
  await stateFlyCall({ supabase: db, userId: 'u1', callId: 'c-1', deps: { flyCallState: async () => ({ state: 'ended' }) } });
  const dur = db.updates.find((u) => u.patch.duration_seconds !== undefined);
  assert.ok(dur, 'duration is written when the call ends');
  assert.ok(dur.patch.duration_seconds >= 89 && dur.patch.duration_seconds <= 92, `about 90 seconds, got ${dur.patch.duration_seconds}`);
});

test('a call nobody answered is never billed (no answered_at, so no duration)', async () => {
  const db = fakeDb({ answered_at: null, duration_seconds: null });
  await stateFlyCall({ supabase: db, userId: 'u1', callId: 'c-1', deps: { flyCallState: async () => ({ state: 'ended' }) } });
  assert.equal(db.updates.some((u) => u.patch.duration_seconds !== undefined), false);
});

test('ending a call from the app also writes its duration', async () => {
  const answered = new Date(Date.now() - 60_000).toISOString();
  const db = fakeDb({ answered_at: answered, duration_seconds: null });
  await endFlyCall({
    supabase: db, userId: 'u1', callId: 'c-1', transcript: [],
    deps: {
      flyEndCall: async () => ({}),
      maybeGenerateCallSummary: async () => ({ status: 'none' }),
      postCallChatMessage: async () => {},
      formatSummaryForChat: () => '',
    },
  });
  const dur = db.updates.find((u) => u.patch.duration_seconds !== undefined);
  assert.ok(dur && dur.patch.duration_seconds >= 59 && dur.patch.duration_seconds <= 62);
});

test('a video call is marked is_video on its row, so it bills at 2 credits a minute', async () => {
  const db = fakeDb();
  await startFlyWhatsappCall({
    supabase: db, userId: 'u1', to: '+2348000000009', video: true,
    deps: {
      createCallRecord: async () => ({ id: 'row-9' }),
      startFlyCall: async () => ({ callId: 'c-9' }),
      markCallPlaced: async () => {},
      markCallFailed: async () => {},
    },
  });
  assert.ok(db.updates.some((u) => u.patch.is_video === true), 'is_video is set');
});

test('an audio call is not marked is_video', async () => {
  const db = fakeDb();
  await startFlyWhatsappCall({
    supabase: db, userId: 'u1', to: '+2348000000010', video: false,
    deps: {
      createCallRecord: async () => ({ id: 'row-10' }),
      startFlyCall: async () => ({ callId: 'c-10' }),
      markCallPlaced: async () => {},
      markCallFailed: async () => {},
    },
  });
  assert.equal(db.updates.some((u) => u.patch.is_video !== undefined), false);
});
