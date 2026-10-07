import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeWhatsappCaller, matchContactByNumber, resolveContactByCaller } from '../lib/contactMatch.js';
import { database } from './helpers.mjs';

test('WhatsApp caller ids normalise to E.164', () => {
  for (const [raw, want] of [
    ['2348012345678@s.whatsapp.net', '+2348012345678'],
    ['2348012345678:12@s.whatsapp.net', '+2348012345678'],
    ['+234 801 234 5678', '+2348012345678'],
    ['2348012345678', '+2348012345678'],
    ['002348012345678', '+2348012345678'],
  ]) assert.equal(normalizeWhatsappCaller(raw), want, raw);
});

test('ids with no usable number never match anything', () => {
  for (const raw of ['123456789012345@lid', '', null, undefined, 'Marilyn', '0801 234 5678', '12345', '120363025@g.us']) {
    assert.equal(normalizeWhatsappCaller(raw), null, String(raw));
  }
});

const contacts = [
  { id: 'c1', name: 'Marilyn', phone_number: '+2348012345678' },
  { id: 'c2', name: 'David', phone_number: '+14155552671' },
];

test('matching is by number, exact, and never by name or partial digits', () => {
  assert.equal(matchContactByNumber(contacts, '2348012345678@s.whatsapp.net').contact.id, 'c1');
  assert.equal(matchContactByNumber(contacts, '+1 415 555 2671').contact.id, 'c2');
  for (const near of ['2348012345679@s.whatsapp.net', '348012345678@s.whatsapp.net', '8012345678@s.whatsapp.net']) {
    assert.equal(matchContactByNumber(contacts, near).status, 'none', near);
  }
  assert.equal(matchContactByNumber(contacts, 'Marilyn').status, 'invalid');
});

test('two contacts with one number are ambiguous: no contact is returned', () => {
  const twin = [...contacts, { id: 'c3', name: 'Marilyn work', phone_number: '+234 801 234 5678' }];
  const r = matchContactByNumber(twin, '2348012345678@s.whatsapp.net');
  assert.equal(r.status, 'ambiguous');
  assert.equal(r.contact, null);
});

test('DB lookup only ever sees the signed-in user\'s contacts', async () => {
  const db = database({ contacts: [
    { id: 'a1', user_id: 'A', name: 'Marilyn', phone_number: '+2348012345678' },
    { id: 'b1', user_id: 'B', name: 'Someone', phone_number: '+2348012345678' },
    { id: 'b2', user_id: 'B', name: 'Only B', phone_number: '+14155552671' },
  ] });
  assert.equal((await resolveContactByCaller(db, 'A', '2348012345678@s.whatsapp.net')).contact.id, 'a1');
  assert.equal((await resolveContactByCaller(db, 'B', '2348012345678@s.whatsapp.net')).contact.id, 'b1');
  assert.equal((await resolveContactByCaller(db, 'A', '14155552671@s.whatsapp.net')).status, 'none'); // B's contact
});
