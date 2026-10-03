import test from 'node:test';
import assert from 'node:assert/strict';
import { database } from './helpers.mjs';
import { resolvePersonSession, peerKeyFor } from '../lib/personSession.js';

const U = 'user-1';
const seed = () => database({
  chat_sessions: [
    { id: 'mrA', user_id: U, title: 'Mr A', peer_key: 'p:2349038226059', archived: false, updated_at: '2026-09-28T10:00:00Z' },
    { id: 'mrB', user_id: U, title: 'Mr B', peer_key: 'p:14155552671', archived: false, updated_at: '2026-09-29T10:00:00Z' },
    { id: 'fresh', user_id: U, title: 'New chat', archived: false },
  ],
  assistant_messages: [
    { id: 'm1', user_id: U, session_id: 'mrA', role: 'user', content: 'call him' },
    { id: 'm2', user_id: U, session_id: 'fresh', role: 'user', content: '+234 903 822 6059' },
  ],
  calls: [
    { id: 'c1', user_id: U, session_id: 'mrA', to_number: '+2349038226059' },
    { id: 'c2', user_id: U, session_id: 'fresh', to_number: '+2349038226059' },
  ],
  call_plans: [],
});

test('peer key ignores number formatting and prefers the number over a contact id', () => {
  assert.equal(peerKeyFor({ toNumber: '+234 903-822-6059' }), 'p:2349038226059');
  assert.equal(peerKeyFor({ toNumber: '+2349038226059', contactId: 'x' }), 'p:2349038226059');
  assert.equal(peerKeyFor({ contactId: 'x' }), 'c:x');
  assert.equal(peerKeyFor({}), null);
});

test("pasting Mr A's number in a brand-new chat folds that chat into Mr A's one conversation", async () => {
  const db = seed();
  const r = await resolvePersonSession(db, U, { sessionId: 'fresh', toNumber: '+234 903 822 6059' });
  assert.equal(r.sessionId, 'mrA');
  assert.equal(r.merged, true);
  assert.deepEqual(db.tables.chat_sessions.map((s) => s.id).sort(), ['mrA', 'mrB']);
  assert.equal(db.tables.assistant_messages.find((m) => m.id === 'm2').session_id, 'mrA');
  assert.ok(db.tables.calls.every((c) => c.session_id === 'mrA'));
});

test('a saved contact and a pasted number for the same person land in the same chat', async () => {
  const db = seed();
  const viaContact = await resolvePersonSession(db, U, { sessionId: null, contactId: 'ct-1', contactNumber: '+2349038226059' });
  const viaNumber = await resolvePersonSession(db, U, { sessionId: 'fresh', toNumber: '2349038226059'.replace(/^/, '+') });
  assert.equal(viaContact.sessionId, 'mrA');
  assert.equal(viaNumber.sessionId, 'mrA');
});

test('calling a different person never merges into someone else\'s chat', async () => {
  const db = seed();
  const r = await resolvePersonSession(db, U, { sessionId: 'mrA', toNumber: '+14155552671' });
  // mrA belongs to Mr A; the call goes to Mr B's own conversation and mrA is untouched.
  assert.equal(r.sessionId, 'mrB');
  assert.equal(r.merged, false);
  assert.ok(db.tables.chat_sessions.some((s) => s.id === 'mrA'));
  assert.equal(db.tables.assistant_messages.find((m) => m.id === 'm1').session_id, 'mrA');
});

test('the first call to a new person tags the originating chat as theirs', async () => {
  const db = seed();
  const r = await resolvePersonSession(db, U, { sessionId: 'fresh', toNumber: '+4420 7946 0958', label: 'Sam' });
  assert.equal(r.sessionId, 'fresh');
  assert.equal(r.merged, false);
  const row = db.tables.chat_sessions.find((s) => s.id === 'fresh');
  assert.equal(row.peer_key, 'p:442079460958');
  assert.equal(row.title, 'Sam');
});

test('an archived conversation is brought back when the person is called again', async () => {
  const db = seed();
  db.tables.chat_sessions.find((s) => s.id === 'mrA').archived = true;
  const r = await resolvePersonSession(db, U, { sessionId: null, toNumber: '+2349038226059' });
  assert.equal(r.sessionId, 'mrA');
  assert.equal(db.tables.chat_sessions.find((s) => s.id === 'mrA').archived, false);
});

test('another user with the same number never shares a conversation', async () => {
  const db = seed();
  const r = await resolvePersonSession(db, 'user-2', { sessionId: null, toNumber: '+2349038226059', label: 'Mr A' });
  assert.notEqual(r.sessionId, 'mrA');
  assert.equal(db.tables.chat_sessions.find((s) => s.id === r.sessionId).user_id, 'user-2');
});
