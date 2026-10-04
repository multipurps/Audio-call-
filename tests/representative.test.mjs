// One identity model for EVERY call: the person who set the call up is the
// speaker; Emysa is infrastructure. The WhatsApp/Telegram service carries these
// rules in Python (pipecat-service/app/pipeline.py); the Twilio relays carry them
// from server/representative.js. These tests fail if either side drifts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  briefLines, loadSpeakerProfile, representativeRules, speakerSituation, whereYouAreLine,
} from '../server/representative.js';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const flat = (s) => s.replace(/\\\n/g, '').replace(/\s+/g, ' ');

test('the speaker is the person, never the product', () => {
  const s = speakerSituation({ userName: 'Ada' });
  assert.match(s, /speaking as Ada: first person/);
  assert.match(s, /If they ask who this is, say your name plainly/);
  assert.match(s, /never the speaker, never a topic/);
  assert.doesNotMatch(s, /Emysa/);
  assert.match(speakerSituation({ userName: '' }), /speaking as the person who set this call up/);
  assert.match(speakerSituation({ userName: 'Ada', direction: 'inbound' }), /just came in, answering as Ada/);
});

test('the objective is a private brief, not a request or a script', () => {
  const lines = briefLines({ objective: 'Ask John about the Arsenal match', instructions: 'keep it light' }).join('\n');
  assert.match(lines, /private brief .* not a message to relay or a script to read\): Ask John/);
  assert.match(lines, /More private detail for your brief: keep it light/);
  assert.doesNotMatch(lines, /from the user|What this call is for/);
});

test('country is never presented as the current location, and nothing is invented', () => {
  assert.match(whereYouAreLine('Nigeria'), /not where you are right now/);
  assert.match(whereYouAreLine(''), /do not know where you are right now/);
  assert.doesNotMatch(whereYouAreLine(''), /Nigeria/);
});

test('rules: no relay phrasing, no assistant openers, honest only if sincerely asked', () => {
  const rules = representativeRules().join('\n');
  assert.match(rules, /Never say or hint at "I was asked to", "the user", "on behalf of"/);
  assert.match(rules, /Banned: .*"What's on your mind"/);
  assert.match(rules, /do not claim to be human and do not deny it/);
  assert.match(rules, /do not invent a place, a plan or a story, and never explain how the call works/);
  assert.match(rules, /Do not introduce yourself unless your brief says to/);
  assert.doesNotMatch(rules, /Emysa/);
});

test('Python and Node carry the same identity sentences', () => {
  const py = flat(read('pipecat-service/app/pipeline.py'));
  const node = flat(representativeRules().join(' ') + ' ' + speakerSituation({ userName: 'Ada' }));
  for (const phrase of [
    'not a message to relay, not a script, and not a request made to you',
    'Tell Sarah I\'m running late',
    'Hey Sarah, I\'m running a little late.',
    'Never say or hint at "I was asked to", "the user", "on behalf of"',
    'do not invent a place, a plan or a story, and never explain how the call works',
    'do not claim to be human and do not deny it',
    'Do not introduce yourself unless your brief says to',
    'it is never the speaker, never a topic, and you never name it, describe it or apologise for it',
  ]) {
    assert.ok(py.includes(phrase), `Python prompt lost: ${phrase}`);
    assert.ok(node.includes(phrase), `Node rules lost: ${phrase}`);
  }
});

test('both Twilio relays use the shared rules; only the callback kind keeps the assistant', () => {
  for (const file of ['server/relay.js', 'server/patter-relay.js']) {
    const src = read(file);
    assert.match(src, /from '\.\/representative\.js'/, file);
    assert.match(src, /representativeRules\(\)/, file);
    assert.match(src, /loadSpeakerProfile\(supabase, call\.user_id\)/, file);
    assert.doesNotMatch(src, /don't confirm it and don't deny it/, `${file} still evades a sincere question`);
    assert.doesNotMatch(src, /Stay in character for the whole call/, file);
  }
});

test('profile load keeps the name when the country column is not migrated yet', async () => {
  const seen = [];
  const supabase = {
    from: () => ({
      select: (cols) => {
        seen.push(cols);
        const q = { eq: () => q, maybeSingle: async () => (cols.includes('country')
          ? { data: null, error: { message: 'column profiles.country does not exist' } }
          : { data: { name: ' Ada ' }, error: null }) };
        return q;
      },
    }),
  };
  assert.deepEqual(await loadSpeakerProfile(supabase, 'u1'), { name: 'Ada', country: '' });
  assert.deepEqual(seen, ['name,country', 'name']);
  assert.deepEqual(await loadSpeakerProfile(null, 'u1'), { name: '', country: '' });
});
