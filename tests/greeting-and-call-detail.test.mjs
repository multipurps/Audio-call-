import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { GREETINGS, greetingForNow, timeBand, firstName } from '../lib/greeting.js';
import { isAppCall, callAgainPlatform, transcriptSpeakerLabel, callTalked } from '../lib/callDetail.js';

const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const at = (h) => new Date(2026, 9, 23, h, 0);

// ---- the chat greeting ----

test('at 3:58 AM the chat does not say "Good night", which is a goodbye', () => {
  const line = greetingForNow('Ariana', { now: at(3) });
  assert.doesNotMatch(line, /good night/i);
  for (let i = 0; i < 20; i++) assert.doesNotMatch(greetingForNow('Ariana', { now: at(3), random: () => i / 20 }), /good night/i);
});

test('no greeting at any hour is "Good night" or the generic "what can I help you with today"', () => {
  for (const [band, lines] of Object.entries(GREETINGS)) {
    assert.ok(lines.length >= 3, `${band} has real variety`);
    for (const l of lines) {
      assert.doesNotMatch(l, /good night/i, l);
      assert.doesNotMatch(l, /what can i help you with/i, l);
    }
  }
});

test('the greeting follows the time of day', () => {
  assert.deepEqual([0, 4, 5, 8, 9, 11, 12, 16, 17, 20, 21, 23].map(timeBand),
    ['lateNight', 'lateNight', 'earlyMorning', 'earlyMorning', 'morning', 'morning', 'afternoon', 'afternoon', 'evening', 'evening', 'night', 'night']);
  assert.match(greetingForNow('Ariana', { now: at(10), random: () => 0.5 }), /morning/i);
  assert.match(greetingForNow('Ariana', { now: at(14), random: () => 0 }), /afternoon/i);
  assert.match(greetingForNow('Ariana', { now: at(18), random: () => 0 }), /evening/i);
  assert.doesNotMatch(greetingForNow('Ariana', { now: at(14), random: () => 0 }), /morning|evening/i);
});

test('it uses the first name, and reads cleanly when there is none', () => {
  assert.match(greetingForNow('ariana smith', { now: at(10), random: () => 0 }), /Ariana/);
  assert.doesNotMatch(greetingForNow('ariana smith', { now: at(10), random: () => 0 }), /Smith/);
  for (const [band, lines] of Object.entries(GREETINGS)) {
    for (let i = 0; i < lines.length; i++) {
      const hour = { lateNight: 2, earlyMorning: 6, morning: 10, afternoon: 14, evening: 18, night: 22 }[band];
      for (const name of ['', null, 'bob@mail.com']) {
        const line = greetingForNow(name, { now: at(hour), random: () => i / lines.length });
        assert.doesNotMatch(line, /\{name\}|\s,|,\s*[.?!]|\s{2,}|undefined|null/, line);
        assert.match(line, /^[A-Z]/, line);
      }
    }
  }
  assert.equal(firstName('bob@mail.com'), '');
  assert.equal(firstName('  mary jane '), 'Mary');
});

test('the same line is not shown twice in a row, and the choice varies', () => {
  const now = at(10);
  const seen = new Set();
  for (let i = 0; i < 30; i++) seen.add(greetingForNow('Ariana', { now, random: () => i / 30 }));
  assert.ok(seen.size >= 3, 'different lines come up');
  for (const last of seen) assert.notEqual(greetingForNow('Ariana', { now, last, random: () => 0 }), last);
});

test('the app uses it, remembers the last line, and the page no longer ships the generic one', () => {
  assert.match(app, /import \{ greetingForNow as pickGreeting \} from '\.\/lib\/greeting\.js';/);
  assert.match(app, /pickGreeting\(name, \{ last \}\)/);
  assert.doesNotMatch(app, /what can I help you with today/);
  assert.doesNotMatch(html, /what can I help you with today/);
});

// ---- the call detail screen ----

const emysaCall = { platform: 'app', to_number: 'Emysa', status: 'failed', duration_seconds: 161, transcript: [{ speaker: 'ai', content: 'Hey' }, { speaker: 'contact', content: 'Hi' }] };

test('"Call Emysa again" opens the Emysa call and never asks for a phone number', () => {
  assert.equal(isAppCall(emysaCall), true);
  assert.equal(callAgainPlatform(emysaCall), 'app');
  assert.equal(callAgainPlatform({ platform: 'whatsapp' }), 'whatsapp');
  assert.equal(callAgainPlatform({ platform: 'telegram' }), 'telegram');
  assert.equal(callAgainPlatform({ platform: 'twilio', to_number: '+14155552671' }), 'phone');
  const fn = app.slice(app.indexOf('async function callAgainFromDetail'), app.indexOf('// A finished call with a transcript but no summary'));
  const appBranch = fn.indexOf("if (isAppCall(c)) { $('callDetailDialog').close(); openAssistantCallScreen(); return; }");
  assert.ok(appBranch > 0, 'the Emysa branch exists');
  // it runs before anything that can build a phone call from the row's "number"
  assert.ok(appBranch < fn.indexOf('prepareCall'));
  assert.ok(appBranch < fn.indexOf("'/api/social-calling?action=call'"));
  assert.ok(appBranch < fn.indexOf('const live ='));
});

test('in a call with Emysa, the person\u2019s own lines are "You", not "Emysa"', () => {
  assert.equal(transcriptSpeakerLabel(emysaCall, { speaker: 'ai' }, 'Emysa'), 'Emysa:');
  assert.equal(transcriptSpeakerLabel(emysaCall, { speaker: 'contact' }, 'Emysa'), 'You:');
  assert.equal(transcriptSpeakerLabel(emysaCall, { role: 'assistant' }, 'Emysa'), 'Emysa:');
  // phone calls keep the contact's name
  assert.equal(transcriptSpeakerLabel({ platform: 'twilio' }, { speaker: 'contact' }, 'Mum'), 'Mum:');
  assert.equal(transcriptSpeakerLabel({ platform: 'twilio' }, { speaker: 'contact' }, ''), 'Caller:');
  assert.match(app, /speakerLabel\.textContent = transcriptSpeakerLabel\(c, turn, name\);/);
});

test('a call that talked is never described as "failed to connect"', () => {
  assert.equal(callTalked(emysaCall), true);
  assert.equal(callTalked({ duration_seconds: 0, transcript: [] }), false);
  assert.equal(callTalked({ duration_seconds: 12 }), true);
  assert.match(app, /case 'failed': return callTalked\(c\) \? `The call with \$\{name\} ended unexpectedly` : `Couldn't reach \$\{name\} — the call failed to connect`;/);
});
