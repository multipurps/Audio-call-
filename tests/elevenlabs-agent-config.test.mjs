import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAgentConfig, validateCloneInput, DEFAULT_AGENT_VOICE_ID, CLONE_NAME_MAX } from '../lib/elevenlabsAgentConfig.js';

test('agent config uses 16 kHz PCM both ways and the given or default voice', () => {
  const c = buildAgentConfig({ voiceId: 'my-voice' });
  assert.equal(c.asr.user_input_audio_format, 'pcm_16000');
  assert.equal(c.tts.agent_output_audio_format, 'pcm_16000');
  assert.equal(c.tts.voice_id, 'my-voice');
  assert.equal(buildAgentConfig({}).tts.voice_id, DEFAULT_AGENT_VOICE_ID);
  assert.equal(c.agent.prompt.tools[0].name, 'end_call');
});

const sample = (bytes = 100) => ({ name: 'a.wav', type: 'audio/wav', data: Buffer.alloc(bytes).toString('base64') });

test('clone input: accepts a named, consented, audio sample', () => {
  assert.equal(validateCloneInput({ name: 'My voice', consent: true, files: [sample()] }), null);
});

test('clone input: refuses each bad case with a clear message', () => {
  assert.match(validateCloneInput({ name: '', consent: true, files: [sample()] }), /name/);
  assert.match(validateCloneInput({ name: 'x'.repeat(CLONE_NAME_MAX + 1), consent: true, files: [sample()] }), /under/);
  assert.match(validateCloneInput({ name: 'v', consent: false, files: [sample()] }), /right/);
  assert.match(validateCloneInput({ name: 'v', consent: true, files: [] }), /at least one/);
  assert.match(validateCloneInput({ name: 'v', consent: true, files: [{ ...sample(), type: 'text/plain' }] }), /audio/);
  assert.match(validateCloneInput({ name: 'v', consent: true, files: [sample(11 * 1024 * 1024)] }), /10 MB/);
  assert.match(validateCloneInput({ name: 'v', consent: true, files: [sample(2 * 1024 * 1024), sample(2 * 1024 * 1024)] }), /too large/);
});
