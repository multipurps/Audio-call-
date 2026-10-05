import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { LIVE_VOICES } from '../lib/liveVoices.js';
import { liveVoicePreview } from '../lib/liveVoicePreview.js';
import { database, loadApi, request } from './helpers.mjs';

const GUIDE_IDS = ['quartz', 'ripple', 'vesper', 'willow', 'stone', 'gleam', 'meridian', 'bossa', 'tempo', 'beacon', 'delta', 'cinder'];

test('Live voice catalog is exactly the documented GPT-Live list and matches the call service', async () => {
  assert.deepEqual(LIVE_VOICES.map((v) => v.id), GUIDE_IDS);
  const py = await readFile('pipecat-service/app/config.py', 'utf8');
  const block = py.slice(py.indexOf('LIVE_VOICES = ('), py.indexOf('LIVE_VOICE_IDS'));
  const rows = [...block.matchAll(/"id": "(\w+)", "name": "(\w+)", "language": "([^"]+)", "accent": "([^"]+)", "gender": "(\w+)"/g)]
    .map((m) => ({ id: m[1], name: m[2], language: m[3], accent: m[4], gender: m[5] }));
  assert.deepEqual(rows, LIVE_VOICES, 'lib/liveVoices.js and pipecat-service/app/config.py must list the same voices');
});

async function prefsApi(seed = {}) {
  const db = database(seed);
  const { default: handler } = await loadApi('api/voice-clone.js', db, async () => { throw new Error('no network'); });
  return { db, handler };
}
const ready = [{ user_id: 'user-1', provider: 'fish', status: 'ready', provider_voice_id: 'cloneVoice12345' }];

test('saving a Live voice stores it separately from the cloned voice id', async () => {
  const { db, handler } = await prefsApi({ voice_profiles: structuredClone(ready) });
  const r = await request(handler, 'prefs', { liveVoiceId: 'meridian' }, { method: 'PUT' });
  assert.equal(r.code, 200, JSON.stringify(r.data));
  assert.equal(r.data.liveVoiceId, 'meridian');
  assert.equal(r.data.liveVoiceName, 'Meridian');
  assert.equal(r.data.liveVoiceGender, 'masculine');
  const row = db.tables.voice_preferences[0];
  assert.equal(row.live_voice_id, 'meridian');
  assert.equal(db.tables.voice_profiles[0].provider_voice_id, 'cloneVoice12345', 'the Fish id is untouched');
  assert.equal(JSON.stringify(row).includes('cloneVoice12345'), false, 'the clone id is never written into live_voice_*');
});

test('unknown Live voices are rejected, including the old marin default', async () => {
  const { handler } = await prefsApi();
  for (const bad of ['marin', 'GPT-Live', '', 'x'.repeat(40)]) {
    const r = await request(handler, 'prefs', { liveVoiceId: bad }, { method: 'PUT' });
    assert.equal(r.code, 400, bad);
  }
});

test('custom voice can only be selected when a clone is ready; selecting Standard turns it off', async () => {
  const none = await prefsApi();
  assert.equal((await request(none.handler, 'prefs', { useCustomVoice: true }, { method: 'PUT' })).code, 400);

  const { db, handler } = await prefsApi({ voice_profiles: structuredClone(ready) });
  let r = await request(handler, 'prefs', {}, { method: 'GET' });
  assert.equal(r.data.useCustomVoice, true, 'existing cloners keep their clone until they pick a Standard voice');
  r = await request(handler, 'prefs', { liveVoiceId: 'gleam', useCustomVoice: false }, { method: 'PUT' });
  assert.equal(r.data.useCustomVoice, false);
  assert.equal(db.tables.voice_preferences[0].use_custom_voice, false);
  r = await request(handler, 'prefs', { useCustomVoice: true }, { method: 'PUT' });
  assert.equal(r.data.useCustomVoice, true);
  assert.equal(r.data.liveVoiceId, 'gleam', 'switching back keeps the saved Live voice');
});

test('prefs require sign-in', async () => {
  const { handler } = await prefsApi();
  assert.equal((await request(handler, 'prefs', {}, { method: 'GET', auth: false })).code, 401);
});

test('live preview opens a GPT-Live session with the requested voice and returns a WAV', async () => {
  const http = createServer();
  const wss = new WebSocketServer({ server: http });
  const seen = [];
  wss.on('connection', (ws, req) => {
    seen.push({ auth: req.headers.authorization });
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type !== 'session.input_audio.append') seen.push(m);
      if (m.type === 'session.start') ws.send(JSON.stringify({ type: 'session.started', session: { id: 'sess_1' } }));
      if (m.type === 'session.instructions.append') {
        const loud = Buffer.alloc(24000 * 2); for (let i = 0; i < loud.length; i += 2) loud.writeInt16LE(8000, i);
        ws.send(JSON.stringify({ type: 'session.output_audio.delta', delta: loud.toString('base64') }));
        ws.send(JSON.stringify({ type: 'session.output_audio.delta', delta: loud.toString('base64') }));
      }
    });
  });
  await new Promise((r) => http.listen(0, r));
  try {
    const wav = await liveVoicePreview('tempo', { apiKey: 'sk-test', url: `ws://127.0.0.1:${http.address().port}`, timeoutMs: 8000 });
    assert.equal(wav.subarray(0, 4).toString(), 'RIFF');
    const start = seen.find((m) => m.type === 'session.start');
    assert.equal(start.session.audio.output.voice, 'tempo');
    assert.equal(start.session.model, 'gpt-live-1');
    assert.equal(seen[0].auth, 'Bearer sk-test');
    await assert.rejects(() => liveVoicePreview('marin', { apiKey: 'sk-test' }), /Unknown Live voice/);
  } finally { wss.close(); http.close(); }
});
