// Call mood: the floating picker, what it sends, and how it reaches the call record.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeMood, moodFields, moodOfCall, isMissingMoodColumn } from '../lib/callMood.js';
import { MOOD_OPTIONS, DEFAULT_MOOD, selectMood, toggleArgue, argueVisible, moodButtonLabel, moodPayload, moodChipVisible } from '../lib/moodPicker.js';
import { createCallRecord } from '../lib/callSession.js';
import { signPendingCall, verifyPendingCall } from '../lib/pendingCall.js';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const html = read('index.html');
const css = read('styles.css');
const app = read('app.js');
const assistant = read('api/assistant.js');

// ---- server: only a known mood is ever stored --------------------------------------------

test('natural, missing and unknown moods mean "no mood"', () => {
  for (const v of [undefined, null, '', 'natural', 'furious', 'argue', 42, {}]) assert.equal(normalizeMood(v, true), null);
  assert.deepEqual(moodFields(null), {});
  assert.deepEqual(moodFields('natural'), {});
});

test('every real mood is accepted and Argue only ever attaches to Angry', () => {
  assert.equal(normalizeMood('angry'), 'angry');
  assert.equal(normalizeMood('angry', true), 'angry_argue');
  for (const m of ['sweet', 'jovial', 'sad', 'talkative']) {
    assert.equal(normalizeMood(m), m);
    assert.equal(normalizeMood(m, true), m, `argue must be ignored for ${m}`);
  }
  assert.equal(normalizeMood(' ANGRY ', true), 'angry_argue');
  assert.equal(normalizeMood('angry_argue'), 'angry_argue'); // a signed pending call carries the stored form
  assert.equal(normalizeMood('angry', 'yes'), 'angry');      // argue must be literally true
  assert.deepEqual(moodFields('angry_argue'), { mood: 'angry_argue' });
});

// ---- the mood reaches the call record, and a missing column never blocks a call ---------------

function fakeSupabase({ failMoodOnce = false } = {}) {
  const inserts = [];
  return {
    inserts,
    from(table) {
      return {
        insert(row) {
          inserts.push({ table, row: { ...row } });
          const failing = failMoodOnce && 'mood' in row;
          return { select: () => ({ single: async () => failing
            ? { data: null, error: { message: 'column "mood" of relation "calls" does not exist' } }
            : { data: { id: 'call-1' }, error: null } }) };
        },
      };
    },
  };
}

test('a social call record stores the chosen mood', async () => {
  const db = fakeSupabase();
  await createCallRecord(db, 'u1', { platform: 'whatsapp', toNumber: '+2349000000000', objective: 'x', mood: 'angry_argue' });
  assert.equal(db.inserts[0].row.mood, 'angry_argue');
});

test('no mood means no mood column in the insert at all (an un-migrated database is untouched)', async () => {
  const db = fakeSupabase();
  await createCallRecord(db, 'u1', { platform: 'whatsapp', toNumber: '+2349000000000', objective: 'x' });
  assert.ok(!('mood' in db.inserts[0].row));
});

test('if the mood column does not exist yet the call is still placed, without a mood', async () => {
  const db = fakeSupabase({ failMoodOnce: true });
  const res = await createCallRecord(db, 'u1', { platform: 'whatsapp', toNumber: '+2349000000000', objective: 'x', mood: 'sweet' });
  assert.equal(db.inserts.length, 2);
  assert.ok('mood' in db.inserts[0].row && !('mood' in db.inserts[1].row));
  assert.equal(res.id, 'call-1');
  assert.ok(isMissingMoodColumn({ message: 'column "mood" does not exist' }));
  assert.ok(!isMissingMoodColumn({ message: 'duplicate key' }));
});

test('try again keeps the mood of the call being repeated', async () => {
  const db = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { mood: 'angry_argue' }, error: null }) }) }) }) };
  assert.equal(await moodOfCall(db, 'c1'), 'angry_argue');
  const broken = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { message: 'no column' } }) }) }) }) };
  assert.equal(await moodOfCall(broken, 'c1'), null); // best effort, never throws
  assert.equal(await moodOfCall(db, null), null);
});

test('the mood survives the two-phase call (it rides inside the signed pending-call token)', () => {
  const env = { PENDING_CALL_SECRET: 's'.repeat(32) };
  const token = signPendingCall({ uid: 'u1', text: 'tell him no', mood: 'angry_argue' }, { env });
  const payload = verifyPendingCall(token, 'u1', { env });
  assert.equal(normalizeMood(payload.mood), 'angry_argue');
  const tampered = token.replace(/^[^.]+/, (b) => b.slice(0, -2) + 'AA');
  assert.equal(verifyPendingCall(tampered, 'u1', { env }), null);
});

test('assistant.js carries the mood through every call path', () => {
  assert.match(assistant, /let mood = normalizeMood\(body\.mood, body\.argue === true\)/);
  assert.match(assistant, /mood = normalizeMood\(pending\.mood\)/);                 // phase two
  assert.match(assistant, /target: target \|\| null, mood,/);                          // signed into the token
  assert.match(assistant, /sessionId,\n\s+mood,\n\s+\.\.\.\(isRetry/);                 // WhatsApp / Telegram call record
  assert.match(assistant, /label, mood,\n\s+\}\);/);                                    // phone call plan
  assert.match(assistant, /moodOfCall\(supabase, retryPlan\.last\.id\)/);               // retry keeps it
  assert.match(read('lib/callPlans.js'), /mood: plan\.mood \|\| null/);                 // Call Now places it
  assert.match(read('lib/callPlans.js'), /normalizeMood\(req\.body\?\.mood, req\.body\?\.argue === true\)/);
});

// ---- the picker ------------------------------------------------------------------------------

test('there are exactly six moods, Natural first', () => {
  assert.deepEqual(MOOD_OPTIONS.map((o) => o.id), ['natural', 'angry', 'sweet', 'jovial', 'sad', 'talkative']);
  assert.equal(MOOD_OPTIONS.find((o) => o.id === 'jovial').sub, 'funny');
  assert.equal(MOOD_OPTIONS.find((o) => o.id === 'sad').sub, 'emotional');
});

test('Argue is offered only for Angry, defaults off, and clears when another mood is picked', () => {
  let s = { ...DEFAULT_MOOD };
  assert.equal(argueVisible(s), false);
  assert.deepEqual(toggleArgue(s), s);                       // cannot be switched on without Angry
  s = selectMood(s, 'angry');
  assert.equal(argueVisible(s), true);
  assert.equal(s.argue, false);
  s = toggleArgue(s);
  assert.equal(s.argue, true);
  assert.equal(selectMood(s, 'angry').argue, true);          // re-tapping Angry keeps it
  s = selectMood(s, 'sweet');
  assert.deepEqual(s, { mood: 'sweet', argue: false });
  assert.equal(argueVisible(s), false);
  assert.deepEqual(selectMood(s, 'bogus'), s);               // unknown pick is ignored
});

test('the message carries the mood only when one is chosen', () => {
  assert.deepEqual(moodPayload(DEFAULT_MOOD), {});
  assert.deepEqual(moodPayload({ mood: 'angry', argue: false }), { mood: 'angry', argue: false });
  assert.deepEqual(moodPayload({ mood: 'angry', argue: true }), { mood: 'angry', argue: true });
  assert.deepEqual(moodPayload({ mood: 'jovial', argue: true }), { mood: 'jovial' });
  assert.deepEqual(moodPayload({ mood: 'nope', argue: false }), {});
});

test('the floating button label shows what is chosen', () => {
  assert.equal(moodButtonLabel(DEFAULT_MOOD), 'Mood');
  assert.equal(moodButtonLabel({ mood: 'sweet', argue: false }), 'Sweet');
  assert.equal(moodButtonLabel({ mood: 'angry', argue: false }), 'Angry');
  assert.equal(moodButtonLabel({ mood: 'angry', argue: true }), 'Angry · Argue');
});

test('the button appears while typing and goes away when the box is empty and unfocused', () => {
  assert.equal(moodChipVisible({}), false);
  assert.equal(moodChipVisible({ focused: true }), true);
  assert.equal(moodChipVisible({ hasText: true }), true);
  assert.equal(moodChipVisible({ menuOpen: true }), true);
});

// ---- the production markup and wiring ------------------------------------------------------------

test('the menu in the page has the same six moods, the Argue switch is hidden until Angry, and it floats on the composer', () => {
  const bar = html.slice(html.indexOf('id="homeInputBar"'), html.indexOf('id="sendBtn"'));
  assert.ok(bar.includes('id="moodFloat"'), 'the mood button lives inside the floating composer bar');
  const ids = [...bar.matchAll(/class="moodItem"[^>]*data-mood="(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual(ids, MOOD_OPTIONS.map((o) => o.id));
  assert.match(bar, /id="moodArgueRow"[^>]*role="switch"[^>]*hidden/);
  assert.match(css, /\.moodFloat\{[^}]*position:absolute[^}]*bottom:100%/);
});

test('the picker uses theme tokens only (no hard-coded colours)', () => {
  const block = css.slice(css.indexOf('/* ---------- call mood'), css.indexOf('.homeHeaderTitle'));
  assert.ok(block.length > 200);
  assert.doesNotMatch(block, /#[0-9a-fA-F]{3,8}\b/);
  assert.match(block, /var\(--accent\)/);
});

test('typed messages send the mood; spoken in-call messages never do; it resets after a send', () => {
  assert.match(app, /\.\.\.\(isCall \? \{\} : moodPayload\(moodState\)\)/);
  assert.match(app, /await sendChatMessage\(text, null, 'text', currentCallChannel\(\)\);\n\s+resetMood\(\);/);
  assert.match(app, /\['moodBtn', 'moodMenu'\]\.forEach\(\(id\) => \$\(id\)\.addEventListener\('pointerdown', \(e\) => e\.preventDefault\(\)\)\)/);
});
