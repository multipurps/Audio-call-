import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveVoiceChoice, stripSpeechMarkers } from '../lib/voiceChoice.js';

function db({ prefs = null, clone = null, fail = false } = {}) {
  return {
    from(table) {
      return {
        select() { return this; },
        eq() { return this; },
        maybeSingle: async () => {
          if (fail) throw new Error('db down');
          return { data: table === 'voice_preferences' ? prefs : clone };
        },
      };
    },
  };
}
const ready = { status: 'ready', provider_voice_id: 'fish-abc1234' };

test('ready clone and no explicit Standard choice uses the clone', async () => {
  const c = await resolveVoiceChoice(db({ clone: ready }), 'u');
  assert.equal(c.mode, 'custom');
  assert.equal(c.voiceId, 'fish-abc1234');
});

test('Standard GPT-Live choice wins over a ready clone', async () => {
  const c = await resolveVoiceChoice(db({ clone: ready, prefs: { live_voice_id: 'tempo', use_custom_voice: false } }), 'u');
  assert.deepEqual([c.mode, c.provider, c.voiceId, c.source], ['live', 'gpt-live', 'tempo', 'user']);
});

test('no clone uses the saved Live voice, never Fish', async () => {
  const c = await resolveVoiceChoice(db({ prefs: { live_voice_id: 'tempo', use_custom_voice: true } }), 'u');
  assert.equal(c.provider, 'gpt-live');
  assert.equal(c.voiceId, 'tempo');
});

test('nothing saved falls back to a GPT-Live default, not Fish', async () => {
  const c = await resolveVoiceChoice(db(), 'u', {});
  assert.equal(c.provider, 'gpt-live');
  assert.equal(c.source, 'env-default');
});

test('lookup failure still yields a GPT-Live voice and reports it', async () => {
  const c = await resolveVoiceChoice(db({ fail: true }), 'u', {});
  assert.equal(c.provider, 'gpt-live');
  assert.ok(c.lookupError);
});

test('speech markers are stripped for GPT-Live', () => {
  assert.equal(stripSpeechMarkers('Hi [laughing] there [[pause]] friend'), 'Hi there friend');
});
