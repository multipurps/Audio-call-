import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveVoiceChoice } from '../lib/voiceChoice.js';

const db = (tables) => ({
  from(name) {
    const q = { select() { return q; }, eq() { return q; }, maybeSingle: async () => ({ data: tables[name] ?? null }) };
    return q;
  },
});
const clone = { status: 'ready', provider_voice_id: 'fishclone12345' };
const testRow = { provider: 'elevenlabs', voice_id: 'VoiceId12345', api_key: 'sk_secret_abcdefgh1234', active: true };

test('a switched-on test voice wins over a selected clone and over GPT-Live', async () => {
  const c = await resolveVoiceChoice(db({ voice_profiles: clone, voice_preferences: { use_custom_voice: true }, voice_test_settings: testRow }), 'u1', {});
  assert.equal(c.mode, 'test');
  assert.equal(c.provider, 'elevenlabs');
  const g = await resolveVoiceChoice(db({ voice_preferences: { live_voice_id: 'gleam' }, voice_test_settings: testRow }), 'u1', {});
  assert.equal(g.mode, 'test');
});

test('switched off, the user is back on their clone or GPT-Live', async () => {
  const off = { ...testRow, active: false };
  assert.equal((await resolveVoiceChoice(db({ voice_profiles: clone, voice_preferences: { use_custom_voice: true }, voice_test_settings: off }), 'u1', {})).mode, 'custom');
  assert.equal((await resolveVoiceChoice(db({ voice_preferences: { live_voice_id: 'gleam', use_custom_voice: false }, voice_test_settings: off }), 'u1', {})).mode, 'live');
});

test('a test voice with no key is ignored, and a missing table does not break normal voices', async () => {
  assert.equal((await resolveVoiceChoice(db({ voice_preferences: { live_voice_id: 'gleam', use_custom_voice: false }, voice_test_settings: { ...testRow, api_key: '' } }), 'u1', {})).mode, 'live');
  const broken = { from(name) { if (name === 'voice_test_settings') throw new Error('relation does not exist'); const q = { select() { return q; }, eq() { return q; }, maybeSingle: async () => ({ data: name === 'voice_profiles' ? clone : { use_custom_voice: true } }) }; return q; } };
  assert.equal((await resolveVoiceChoice(broken, 'u1', {})).mode, 'custom');
});
