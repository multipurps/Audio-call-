import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CLIP_ACCEPT, CLIP_MAX_SECONDS, CLIP_RATE, bytesToBase64, encodeWav, fileToWavBase64, firstSpeech, looksLikeAudio, mixToMono, prepareClip, resample,
} from '../lib/voiceClip.js';

const tone = (seconds, rate, amp = 0.4, hz = 220) => Float32Array.from({ length: Math.floor(seconds * rate) }, (_, i) => amp * Math.sin((2 * Math.PI * hz * i) / rate));

test('the picker lets through the files iPhones really have: mp3, m4a, caf, wav, and audio inside mp4/mov', () => {
  for (const name of ['2nd version ElevenLabs_v4.mp3', 'Voice Memo.m4a', 'note.caf', 'a.wav', 'screen recording.mov', 'clip.mp4', 'x.aac', 'x.flac']) assert.ok(looksLikeAudio({ name, type: '' }), name);
  assert.ok(looksLikeAudio({ name: 'noext', type: 'audio/x-m4a' }));
  assert.ok(looksLikeAudio({ name: 'noext', type: 'video/quicktime' }));
  for (const name of ['notes.txt', 'data.json', 'photo.jpg', 'files.zip']) assert.ok(!looksLikeAudio({ name, type: '' }), name);
  for (const token of ['audio/*', '.mp3', '.m4a', '.caf', '.wav', '.mp4', '.mov']) assert.ok(CLIP_ACCEPT.split(',').includes(token), token);
});

test('the markup the phone reads is the same list as the module', async () => {
  const { readFileSync } = await import('node:fs');
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const accept = html.match(/id="cloneFile" accept="([^"]+)"/)[1].split(',');
  assert.deepEqual(accept.sort(), CLIP_ACCEPT.split(',').sort());
});

test('stereo is averaged and resampling keeps the duration', () => {
  const m = mixToMono([Float32Array.from([1, 1]), Float32Array.from([0, 0])]);
  assert.deepEqual(Array.from(m), [0.5, 0.5]);
  const out = resample(tone(1, 44100), 44100, 24000);
  assert.ok(Math.abs(out.length - 24000) <= 1);
});

test('a long clip is cut to 15 seconds starting at the first speech, and stays small', () => {
  const silence = new Float32Array(CLIP_RATE * 2);
  const speech = tone(40, CLIP_RATE);
  const all = new Float32Array(silence.length + speech.length);
  all.set(silence); all.set(speech, silence.length);
  const { wav, seconds } = prepareClip([all], CLIP_RATE);
  assert.ok(seconds <= CLIP_MAX_SECONDS + 0.001 && seconds > CLIP_MAX_SECONDS - 0.001);
  assert.equal(wav.length, 44 + Math.round(seconds * CLIP_RATE) * 2);
  assert.ok(wav.length < 4 * 1024 * 1024, 'well under the 4 MB limit');
  assert.ok(firstSpeech(all, CLIP_RATE) > 0 && firstSpeech(all, CLIP_RATE) < silence.length + 100);
});

test('silent and too-short clips are refused with a message the user can act on', () => {
  assert.throws(() => prepareClip([new Float32Array(CLIP_RATE * 10)], CLIP_RATE), /silent/);
  assert.throws(() => prepareClip([tone(1, CLIP_RATE)], CLIP_RATE), /only 1\.0 seconds/);
});

test('the WAV is a valid 16-bit mono file that a real decoder reads back at the right length', () => {
  const { wav } = prepareClip([tone(6, 44100)], 44100);
  assert.equal(String.fromCharCode(...wav.subarray(0, 4)), 'RIFF');
  assert.equal(String.fromCharCode(...wav.subarray(8, 12)), 'WAVE');
  const dir = mkdtempSync(join(tmpdir(), 'clip-'));
  const path = join(dir, 'clip.wav');
  writeFileSync(path, wav);
  const py = spawnSync('python3', ['-c', `import wave,sys;w=wave.open(sys.argv[1]);print(w.getnchannels(),w.getsampwidth(),w.getframerate(),w.getnframes())`, path], { encoding: 'utf8' });
  assert.equal(py.status, 0, py.stderr);
  const [ch, width, rate, frames] = py.stdout.trim().split(' ').map(Number);
  assert.deepEqual([ch, width, rate], [1, 2, CLIP_RATE]);
  assert.ok(Math.abs(frames / rate - 6) < 0.6, `about 6 seconds, got ${frames / rate}`);
});

test('base64 of the clip round-trips', () => {
  const bytes = encodeWav(tone(1, CLIP_RATE), CLIP_RATE);
  assert.deepEqual(new Uint8Array(Buffer.from(bytesToBase64(bytes), 'base64')), bytes);
});

test('fileToWavBase64 decodes with the browser decoder and reports trimming; undecodable files get a clear message', async () => {
  class Ctx {
    async decodeAudioData() {
      const data = tone(30, 44100);
      return { numberOfChannels: 1, sampleRate: 44100, duration: 30, getChannelData: () => data };
    }
    close() {}
  }
  const file = { size: 1000, arrayBuffer: async () => new ArrayBuffer(8) };
  const out = await fileToWavBase64(file, Ctx);
  assert.equal(out.trimmed, true);
  assert.ok(out.seconds <= 15.001);
  assert.ok(Buffer.from(out.base64, 'base64').subarray(0, 4).toString() === 'RIFF');

  class Bad { async decodeAudioData() { throw new Error('EncodingError'); } close() {} }
  await assert.rejects(fileToWavBase64(file, Bad), /could not read that file/);
  await assert.rejects(fileToWavBase64({ size: 70 * 1024 * 1024, arrayBuffer: async () => new ArrayBuffer(1) }, Ctx), /too large/);
  await assert.rejects(fileToWavBase64(file, null), /cannot read audio clips/);
});
