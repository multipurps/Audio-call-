import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveVoiceChoice, stripSpeechMarkers, agentIsOn } from '../lib/voiceChoice.js';

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
test('a saved Standard (GPT-Live) voice is used', async () => {
  const c = await resolveVoiceChoice(db({ prefs: { live_voice_id: 'tempo' } }), 'u');
  assert.deepEqual([c.mode, c.provider, c.voiceId, c.source], ['live', 'gpt-live', 'tempo', 'user']);
});

test('nothing saved falls back to a GPT-Live default', async () => {
  const c = await resolveVoiceChoice(db(), 'u', {});
  assert.equal(c.provider, 'gpt-live');
  assert.equal(c.source, 'env-default');
});

test('the Custom voice is never returned here; it is the Grok agent', async () => {
  const c = await resolveVoiceChoice(db({ prefs: { live_voice_id: 'tempo', use_custom_voice: true } }), 'u');
  assert.equal(c.mode, 'live');
  assert.equal(c.provider, 'gpt-live');
});

test('lookup failure still yields a GPT-Live voice and reports it', async () => {
  const c = await resolveVoiceChoice(db({ fail: true }), 'u', {});
  assert.equal(c.provider, 'gpt-live');
  assert.ok(c.lookupError);
});

test('speech markers are stripped for GPT-Live', () => {
  assert.equal(stripSpeechMarkers('Hi [laughing] there [[pause]] friend'), 'Hi there friend');
});

test('agentIsOn reads the Custom switch and counts a read problem as off', async () => {
  const on = { from: () => ({ select() { return this; }, eq() { return this; }, maybeSingle: async () => ({ data: { active: true } }) }) };
  const broken = { from: () => ({ select() { return this; }, eq() { return this; }, maybeSingle: async () => { throw new Error('db down'); } }) };
  assert.equal(await agentIsOn(on, 'u'), true);
  assert.equal(await agentIsOn(broken, 'u'), false);
});
