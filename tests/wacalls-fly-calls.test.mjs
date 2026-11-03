import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveOwnedFlyCall, startFlyWhatsappCall, relayFlyOffer, endFlyCall, sanitizeTranscript } from '../lib/wacallsFlyCalls.js';

// Minimal fake of the Supabase query builder used here: rows per table, eq filters, maybeSingle, update.
function fakeDb({ whatsapp_accounts = [], calls = [] } = {}) {
  const updates = [];
  const db = {
    updates,
    from(table) {
      const rows = { whatsapp_accounts, calls }[table] || [];
      const filters = [];
      const q = {
        select() { return q; },
        eq(col, val) { filters.push([col, val]); return q; },
        in(col, vals) { filters.push([col, (r) => vals.includes(r)]); return q; },
        maybeSingle() {
          const hit = rows.find((r) => filters.every(([c, v]) => (typeof v === 'function' ? v(r[c]) : r[c] === v)));
          return Promise.resolve({ data: hit || null, error: null });
        },
        update(patch) {
          const conds = [];
          const applyNow = () => {
            const hits = rows.filter((r) => conds.every(([col, test]) => test(r[col])));
            hits.forEach((r) => Object.assign(r, patch));
            updates.push({ table, patch, count: hits.length });
            return { error: null };
          };
          const u = {
            eq(col, val) { conds.push([col, (x) => x === val]); return u; },
            in(col, vals) { conds.push([col, (x) => vals.includes(x)]); return u; },
            neq(col, val) { conds.push([col, (x) => x !== val]); return u; },
            then(ok) { return Promise.resolve(applyNow()).then(ok); },
          };
          return u;
        },
      };
      return q;
    },
  };
  return db;
}

const linked = { user_id: 'u1', wacalls_session_id: 'sess-1' };
const ownCall = { id: 'db-1', user_id: 'u1', platform: 'whatsapp', platform_call_id: 'c-9' };
const otherCall = { id: 'db-2', user_id: 'u2', platform: 'whatsapp', platform_call_id: 'c-7' };

test('ownership: a call belongs to the person who placed it; another person gets 404', async () => {
  const db = fakeDb({ whatsapp_accounts: [linked], calls: [ownCall, otherCall] });
  assert.deepEqual(await resolveOwnedFlyCall(db, 'u1', 'c-9'), { sid: 'sess-1', dbCallId: 'db-1' });
  await assert.rejects(resolveOwnedFlyCall(db, 'u1', 'c-7'), (e) => e.statusCode === 404);
});

test('no WhatsApp link: 409 with a clear message, WaCalls is not called', async () => {
  const db = fakeDb({ calls: [ownCall] });
  await assert.rejects(resolveOwnedFlyCall(db, 'u1', 'c-9'), (e) => e.statusCode === 409 && /not linked/.test(e.message));
});

test('start: creates the row first, places the call (audio or video) and records the WaCalls call id', async () => {
  const db = fakeDb({ whatsapp_accounts: [linked] });
  const seen = {};
  const deps = {
    createCallRecord: async (_s, _u, args) => { seen.created = args; return { id: 'db-new' }; },
    startFlyCall: async (args) => { seen.started = args; return { callId: 'c-new' }; },
    markCallPlaced: async (_s, id, opts) => { seen.placed = { id, ...opts }; },
    markCallFailed: async () => { seen.failed = true; },
  };
  const out = await startFlyWhatsappCall({ supabase: db, userId: 'u1', to: '+2348000000000', video: true, deps });
  assert.deepEqual(out, { callId: 'c-new', dbCallId: 'db-new', video: true });
  assert.equal(seen.created.platform, 'whatsapp');
  assert.equal(seen.started.sid, 'sess-1');
  assert.equal(seen.started.video, true);
  assert.deepEqual(seen.placed, { id: 'db-new', platformCallId: 'c-new', status: 'ringing' });
  assert.equal(seen.failed, undefined);
});

test('start: a WaCalls refusal marks the row failed with the real reason and rethrows it', async () => {
  const db = fakeDb({ whatsapp_accounts: [linked] });
  let failedWith = null;
  const deps = {
    createCallRecord: async () => ({ id: 'db-new' }),
    startFlyCall: async () => { throw Object.assign(new Error('operator already on a call'), { statusCode: 409 }); },
    markCallFailed: async (_s, id, reason) => { failedWith = { id, reason }; },
  };
  await assert.rejects(startFlyWhatsappCall({ supabase: db, userId: 'u1', to: '1', deps }), /Another WhatsApp call is still open/);
  assert.deepEqual(failedWith, { id: 'db-new', reason: 'Another WhatsApp call is still open. Wait a moment, then try again.' });
});

test('offer: only the owner can relay an SDP offer; the answer comes back under the app’s name', async () => {
  const db = fakeDb({ whatsapp_accounts: [linked], calls: [ownCall] });
  const deps = { submitFlyOffer: async ({ sid, callId, sdpOffer, renegotiate }) => ({ sdpAnswer: `ANS:${sid}:${callId}:${sdpOffer}:${renegotiate}` }) };
  assert.deepEqual(await relayFlyOffer({ supabase: db, userId: 'u1', callId: 'c-9', sdpOffer: 'OFF', deps }), { sdp_answer: 'ANS:sess-1:c-9:OFF:false' });
  await assert.rejects(relayFlyOffer({ supabase: db, userId: 'u2', callId: 'c-9', sdpOffer: 'OFF', deps }), (e) => e.statusCode === 409 || e.statusCode === 404);
  await assert.rejects(relayFlyOffer({ supabase: db, userId: 'u1', callId: 'c-9', sdpOffer: '', deps }), (e) => e.statusCode === 400);
});

test('end: WaCalls already not knowing the call counts as ended; the row is closed', async () => {
  const calls = [{ ...ownCall }];
  const db = fakeDb({ whatsapp_accounts: [linked], calls });
  const deps = { flyEndCall: async () => { throw Object.assign(new Error('gone'), { statusCode: 404 }); }, maybeGenerateCallSummary: async () => ({ status: 'noop' }) };
  assert.equal((await endFlyCall({ supabase: db, userId: 'u1', callId: 'c-9', deps })).ok, true);
  assert.equal(calls[0].status, 'completed');
});

test('end: a real WaCalls error is not swallowed', async () => {
  const db = fakeDb({ whatsapp_accounts: [linked], calls: [{ ...ownCall }] });
  const deps = { flyEndCall: async () => { throw Object.assign(new Error('boom'), { statusCode: 500 }); }, maybeGenerateCallSummary: async () => ({ status: 'noop' }) };
  await assert.rejects(endFlyCall({ supabase: db, userId: 'u1', callId: 'c-9', deps }), /boom/);
});

test('transcript: only text turns, bounded, roles normalised', () => {
  const t = sanitizeTranscript([{ role: 'user', content: '  hi  ' }, { role: 'system', content: 'x' }, { role: 'assistant', content: '' }, { text: 'legacy' }, { role: 'user', content: 'y'.repeat(5000) }]);
  assert.equal(t.length, 4, 'empty turns dropped, the legacy text field kept');
  assert.equal(t[0].content, 'hi');
  assert.equal(t[1].role, 'assistant', 'anything but user is assistant');
  assert.equal(t[2].content, 'legacy');
  assert.equal(t[3].content.length, 2000);
  assert.deepEqual(sanitizeTranscript('nope'), []);
});

test('summary: a finished call with a summary is posted to the chat once', async () => {
  const calls = [{ id: 'db-1', user_id: 'u1', platform: 'whatsapp', platform_call_id: 'c-9', session_id: 'chat-1', status: 'ringing' }];
  const db = fakeDb({ whatsapp_accounts: [linked], calls });
  const posted = [];
  const deps = {
    flyEndCall: async () => ({}),
    maybeGenerateCallSummary: async () => ({ status: 'completed', summary: 'Talked about the trip.', summaryJson: { outcome: 'Agreed' } }),
    postCallChatMessage: async (_s, args) => { posted.push(args); return { posted: true }; },
    formatSummaryForChat: (text, j) => text + ' / ' + j.outcome,
  };
  const out = await endFlyCall({ supabase: db, userId: 'u1', callId: 'c-9', transcript: [{ role: 'user', content: 'hello' }], deps });
  assert.equal(out.summary, 'posted');
  assert.equal(posted.length, 1);
  assert.equal(posted[0].text, 'Talked about the trip. / Agreed');
  assert.equal(posted[0].sessionId, 'chat-1');
  assert.equal(calls[0].status, 'completed');
  assert.equal(calls[0].transcript.length, 1);
});

test('summary: a failure in the summary never fails the end of the call', async () => {
  const db = fakeDb({ whatsapp_accounts: [linked], calls: [{ ...ownCall }] });
  const deps = { flyEndCall: async () => ({}), maybeGenerateCallSummary: async () => { throw new Error('model down'); } };
  const out = await endFlyCall({ supabase: db, userId: 'u1', callId: 'c-9', deps });
  assert.equal(out.ok, true);
  assert.equal(out.summary, 'error');
});

test('busy: WaCalls says an old call is still live, so it is cleared and the start is retried once', async () => {
  const calls = [{ id: 'old', user_id: 'u1', platform: 'whatsapp', platform_call_id: 'c-old', status: 'ringing' }];
  const db = fakeDb({ whatsapp_accounts: [linked], calls });
  let starts = 0, cleared = 0;
  const deps = {
    createCallRecord: async () => ({ id: 'db-new' }),
    startFlyCall: async () => {
      starts++;
      if (starts === 1) throw Object.assign(new Error('operator already on a call'), { statusCode: 409 });
      return { callId: 'c-new' };
    },
    flyClearCalls: async () => { cleared++; return { cleared: 1 }; },
    markCallPlaced: async () => {},
  };
  const out = await startFlyWhatsappCall({ supabase: db, userId: 'u1', to: '1', deps });
  assert.equal(out.callId, 'c-new');
  assert.equal(starts, 2);
  assert.equal(cleared, 1);
  assert.equal(calls[0].status, 'canceled', 'the old live row is closed');
});

test('busy: a different WaCalls error is not retried', async () => {
  const db = fakeDb({ whatsapp_accounts: [linked] });
  let starts = 0;
  const deps = {
    createCallRecord: async () => ({ id: 'db-new' }),
    startFlyCall: async () => { starts++; throw Object.assign(new Error('max calls reached'), { statusCode: 429 }); },
    markCallFailed: async () => {},
  };
  await assert.rejects(startFlyWhatsappCall({ supabase: db, userId: 'u1', to: '1', deps }), (e) => e.statusCode === 429 && /could not start/.test(e.message));
  assert.equal(starts, 1);
});
