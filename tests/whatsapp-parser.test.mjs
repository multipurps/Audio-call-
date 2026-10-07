import test from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';
import { parseChat, parseExport, readExport, inferDateOrder, identifyContactParticipant, ExportError } from '../lib/whatsappParser.js';

const LRM = '\u200e';
const NNBSP = '\u202f';

const IOS_DMY = [
  `${LRM}[12/03/2024, 14:05:09] Marilyn: ${LRM}Messages and calls are end-to-end encrypted. No one outside of this chat can read them.`,
  `[12/03/2024, 14:05:09] Marilyn: Hi Zee`,
  `[12/03/2024, 14:06:30] Zee: Hello!`,
  `[13/03/2024, 09:00:00] Marilyn: Can you call me tomorrow?`,
  `It is about the pottery class`,
  `and the deposit`,
  `[13/03/2024, 09:01:10] Marilyn: ${LRM}image omitted`,
  `[13/03/2024, 09:02:00] Zee: ${LRM}You deleted this message`,
  `[13/03/2024, 09:05:00] Marilyn: Missed voice call`,
  `[13/03/2024, 09:06:00] Marilyn: See you then <This message was edited>`,
  `[13/03/2024, 09:07:00] Marilyn: ${LRM}<attached: 00000012-PHOTO-2024-03-13-09-07-00.jpg>`,
  `[13/03/2024, 09:08:00] Marilyn changed the group description: hello there everyone`,
].join('\n');

test('iOS day-first: messages, multi-line bodies, media, calls, deleted, system lines', () => {
  const chat = parseChat(IOS_DMY);
  assert.equal(chat.dateOrder, 'dmy');
  assert.equal(chat.dateOrderAmbiguous, false); // 13 > 12 proves day-first
  assert.equal(chat.messages.length, 8); // encrypted notice + group-description notice are system
  assert.equal(chat.messages[0].text, 'Hi Zee');
  assert.equal(chat.messages[0].sentAt, '2024-03-12T14:05:09.000Z');
  const multi = chat.messages.find((m) => m.text.startsWith('Can you call me tomorrow'));
  assert.equal(multi.text, 'Can you call me tomorrow?\nIt is about the pottery class\nand the deposit');
  assert.deepEqual(chat.messages.map((m) => m.kind), ['text', 'text', 'text', 'media', 'deleted', 'call', 'text', 'media']);
  assert.equal(chat.messages.find((m) => m.kind === 'media' && m.attachment).attachment, '00000012-PHOTO-2024-03-13-09-07-00.jpg');
  assert.equal(chat.messages.find((m) => m.text.startsWith('See you then')).text, 'See you then'); // edit marker stripped
  assert.equal(chat.stats.system, 2);
  assert.deepEqual(chat.participants.map((p) => [p.name, p.messages]), [['Marilyn', 6], ['Zee', 2]]);
  assert.equal(chat.isGroup, false);
});

test('Android day-first 24h', () => {
  const chat = parseChat([
    '12/03/2024, 14:05 - Messages and calls are end-to-end encrypted. No one outside of this chat, not even WhatsApp, can read or listen to them.',
    '12/03/2024, 14:05 - Marilyn: Hi',
    '25/03/2024, 18:30 - Zee: I will bring the form on Friday',
    '25/03/2024, 18:31 - Marilyn: <Media omitted>',
  ].join('\n'));
  assert.equal(chat.dateOrder, 'dmy');
  assert.equal(chat.messages.length, 3);
  assert.equal(chat.messages[1].sentAt, '2024-03-25T18:30:00.000Z');
  assert.equal(chat.messages[2].kind, 'media');
  assert.equal(chat.stats.system, 1);
});

test('US month-first with AM/PM and U+202F: 12 AM is midnight, 12 PM is noon', () => {
  const chat = parseChat([
    `3/14/24, 2:05${NNBSP}PM - Marilyn: afternoon`,
    `3/15/24, 12:10${NNBSP}AM - Zee: just after midnight`,
    `3/15/24, 12:10${NNBSP}PM - Zee: just after noon`,
  ].join('\n'));
  assert.equal(chat.dateOrder, 'mdy');
  assert.deepEqual(chat.messages.map((m) => m.sentAt), ['2024-03-14T14:05:00.000Z', '2024-03-15T00:10:00.000Z', '2024-03-15T12:10:00.000Z']);
});

test('iOS with seconds and AM/PM', () => {
  const chat = parseChat(`[3/14/24, 2:05:09${NNBSP}PM] Marilyn: hi\n[3/14/24, 11:59:59${NNBSP}PM] Zee: night`);
  assert.equal(chat.dateOrder, 'mdy');
  assert.equal(chat.messages[0].sentAt, '2024-03-14T14:05:09.000Z');
  assert.equal(chat.messages[1].sentAt, '2024-03-14T23:59:59.000Z');
});

test('German dotted dates and 4-digit years', () => {
  const chat = parseChat('14.03.2024, 14:05 - Anna: Hallo\n15.03.2024, 08:00 - Ben: Moin');
  assert.equal(chat.dateOrder, 'dmy');
  assert.equal(chat.messages[1].sentAt, '2024-03-15T08:00:00.000Z');
});

test('ambiguous dates are flagged, and an explicit order overrides the guess', () => {
  const text = '03/04/2024, 10:00 - Marilyn: a\n05/06/2024, 11:00 - Zee: b';
  assert.deepEqual(inferDateOrder(['03/04/2024', '05/06/2024']), { order: 'dmy', ambiguous: true });
  const guess = parseChat(text);
  assert.equal(guess.dateOrderAmbiguous, true);
  assert.equal(guess.messages[0].sentAt, '2024-04-03T10:00:00.000Z');
  const forced = parseChat(text, { dateOrder: 'mdy' });
  assert.equal(forced.dateOrderAmbiguous, false);
  assert.equal(forced.messages[0].sentAt, '2024-03-04T10:00:00.000Z');
});

test('only a body with a colon in it stays whole; sender stops at the first colon', () => {
  const chat = parseChat('12/03/2024, 14:05 - Marilyn: note to self: bring cash: 5000');
  assert.equal(chat.messages[0].sender, 'Marilyn');
  assert.equal(chat.messages[0].text, 'note to self: bring cash: 5000');
});

test('Android attachment names inside a zip with media', () => {
  const chat = parseChat('12/03/2024, 14:05 - Marilyn: IMG-20240312-WA0001.jpg (file attached)');
  assert.equal(chat.messages[0].kind, 'media');
  assert.equal(chat.messages[0].attachment, 'IMG-20240312-WA0001.jpg');
});

test('unsaved contacts appear as phone numbers and are identified by number, not name', () => {
  const text = [
    '12/03/2024, 14:05 - +234 801 234 5678: Hi, it is Lyn',
    '12/03/2024, 14:06 - Zee: Hello Lyn',
    '25/03/2024, 14:06 - +234 801 234 5678: ok',
  ].join('\n');
  const chat = parseChat(text);
  const phone = chat.participants.find((p) => p.name.startsWith('+234'));
  assert.equal(phone.phone, '+2348012345678');
  const found = identifyContactParticipant(chat.participants, { name: 'Marilyn', phone_number: '+2348012345678' });
  assert.deepEqual(found, { contactParticipant: '+234 801 234 5678', selfParticipant: 'Zee', method: 'phone' });
});

test('contact identification: exact name, the other person via the user\'s own name, and never a guess', () => {
  const participants = [{ name: 'Marilyn', messages: 5, phone: null }, { name: 'Zee', messages: 4, phone: null }];
  assert.equal(identifyContactParticipant(participants, { name: 'marilyn', phone_number: '+15550000000' }).method, 'name');
  assert.deepEqual(identifyContactParticipant(participants, { name: 'Aunt M', phone_number: '+15550000000' }, { selfName: 'Zee' }),
    { contactParticipant: 'Marilyn', selfParticipant: 'Zee', method: 'only_other' });
  assert.equal(identifyContactParticipant(participants, { name: 'Aunt M', phone_number: '+15550000000' }), null);
  // two participants share a name: refuse to pick
  const twins = [{ name: 'Sam', messages: 1, phone: null }, { name: 'sam', messages: 1, phone: null }];
  assert.equal(identifyContactParticipant(twins, { name: 'Sam', phone_number: '+1' }), null);
});

test('group chats are flagged', () => {
  const chat = parseChat('12/03/2024, 14:05 - A: x\n12/03/2024, 14:06 - B: y\n12/03/2024, 14:07 - C: z');
  assert.equal(chat.isGroup, true);
  assert.equal(chat.participants.length, 3);
});

test('a txt that is not a WhatsApp export, and an empty one, are refused clearly', () => {
  assert.throws(() => parseChat('hello world\nthis is just a note'), (e) => e instanceof ExportError && e.code === 'no_messages');
  assert.throws(() => readExport(new Uint8Array(0)), (e) => e.code === 'empty');
});

test('BOM and CRLF line endings are tolerated', () => {
  const chat = parseChat('\ufeff12/03/2024, 14:05 - Marilyn: one\r\n12/03/2024, 14:06 - Zee: two\r\n');
  assert.equal(chat.messages.length, 2);
});

// ---- zip handling ----------------------------------------------------------

const media = () => ({
  '00000012-PHOTO-2024-03-13-09-07-00.jpg': new Uint8Array(2000).fill(7),
  '00000013-AUDIO-2024-03-13-09-08-00.opus': new Uint8Array(3000).fill(9),
});

test('zip WITH media: finds _chat.txt, counts media, never extracts it', () => {
  const zip = zipSync({ '_chat.txt': strToU8(IOS_DMY), ...media() });
  const out = parseExport(zip, { filename: 'WhatsApp Chat - Marilyn.zip' });
  assert.equal(out.source.kind, 'zip');
  assert.equal(out.source.chatFile, '_chat.txt');
  assert.equal(out.source.mediaCount, 2);
  assert.equal(out.source.hasMedia, true);
  assert.equal(out.messages.length, 8);
  assert.ok(!out.chatText.includes('\u0007')); // media bytes are nowhere in the text
});

test('zip WITHOUT media', () => {
  const zip = zipSync({ 'WhatsApp Chat with Marilyn.txt': strToU8('12/03/2024, 14:05 - Marilyn: Hi\n13/03/2024, 10:00 - Zee: Hello') });
  const out = parseExport(zip, { filename: 'chat.zip' });
  assert.equal(out.source.mediaCount, 0);
  assert.equal(out.messages.length, 2);
});

test('plain txt', () => {
  const out = parseExport(strToU8(IOS_DMY), { filename: 'WhatsApp Chat with Marilyn.txt' });
  assert.equal(out.source.kind, 'txt');
  assert.equal(out.source.mediaCount, 0);
  assert.equal(out.source.hasMedia, true); // placeholders in the text show media existed even though none was exported
});

test('zip junk entries (__MACOSX, ._files) are ignored and the right txt is chosen', () => {
  const zip = zipSync({
    '__MACOSX/._chat.txt': strToU8('junk'),
    'notes.txt': strToU8('not a chat'),
    '_chat.txt': strToU8('12/03/2024, 14:05 - Marilyn: Hi\n13/03/2024, 10:00 - Zee: Hello'),
  });
  assert.equal(parseExport(zip).source.chatFile, '_chat.txt');
});

test('zip with no txt, a corrupt zip, a fake zip name, and an oversized chat inside a zip are refused', () => {
  assert.throws(() => readExport(zipSync({ 'a.jpg': new Uint8Array(10) })), (e) => e.code === 'no_chat_file');
  const corrupt = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4, 5, 6, 7, 8]);
  assert.throws(() => readExport(corrupt), (e) => e.code === 'bad_zip');
  assert.throws(() => readExport(strToU8('hello'), { filename: 'x.zip' }), (e) => e.code === 'bad_zip');
  const bomb = zipSync({ '_chat.txt': new Uint8Array(51 * 1024 * 1024) }); // compresses to a few KB
  assert.ok(bomb.length < 1024 * 1024);
  assert.throws(() => readExport(bomb), (e) => e.code === 'too_large');
});

test('files above 50 MB are refused before parsing', () => {
  assert.throws(() => readExport(new Uint8Array(50 * 1024 * 1024 + 1).fill(65)), (e) => e.code === 'too_large');
});

test('performance: 100k messages parse in well under a few seconds', () => {
  const lines = [];
  for (let i = 0; i < 100000; i += 1) lines.push(`12/03/2024, 14:${String(i % 60).padStart(2, '0')} - ${i % 2 ? 'Marilyn' : 'Zee'}: message number ${i}`);
  const start = Date.now();
  const chat = parseChat(lines.join('\n'));
  assert.equal(chat.messages.length, 100000);
  assert.ok(Date.now() - start < 5000, `took ${Date.now() - start}ms`);
});
