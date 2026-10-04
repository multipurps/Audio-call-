import { test } from 'node:test';
import assert from 'node:assert';
import { PassThrough } from 'node:stream';
import { WebSocketServer } from 'ws';
import {
  encodeFrame, decodeFrame, FRAME, HEADER_SIZE, Downsampler48to16, Upsampler16to48, connectAssistant,
} from '../signal-bridge/audio-bridge.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pcm = (n, v = 1000) => { const b = Buffer.alloc(n * 2); for (let i = 0; i < n; i++) b.writeInt16LE(v, i * 2); return b; };

test('ACAF frame round-trips with the 28-byte header and 64-bit timestamp', () => {
  const ts = Date.now(); // exceeds uint32
  const f = encodeFrame({ type: FRAME.AUDIO_IN, sampleRate: 16000, sequence: 7, timestampMs: ts, payload: pcm(320) });
  assert.equal(f.length, HEADER_SIZE + 640);
  assert.equal(f.toString('ascii', 0, 4), 'ACAF');
  const d = decodeFrame(f);
  assert.deepEqual([d.version, d.type, d.encoding, d.channels, d.sampleRate, d.sequence, d.timestampMs, d.payload.length],
    [1, 1, 1, 1, 16000, 7, ts, 640]);
  assert.equal(decodeFrame(Buffer.from('nope')), null);
});

test('resamplers keep length ratios across odd chunk sizes', () => {
  const down = new Downsampler48to16(); let out = 0;
  for (const n of [1000, 7, 2, 3001, 5]) out += down.push(Buffer.alloc(n)).length;
  assert.equal(out + 0, Math.floor((1000 + 7 + 2 + 3001 + 5) / 6) * 2);
  const up = new Upsampler16to48();
  assert.equal(up.push(pcm(320)).length, 320 * 6);
  assert.equal(new Downsampler48to16().push(pcm(960, 3000)).readInt16LE(0), 3000); // DC level preserved
});

function startMock({ onHello } = {}) {
  const wss = new WebSocketServer({ port: 0 });
  const seen = { hellos: [], audioIn: [], controls: [], conns: [] };
  wss.on('connection', (ws) => {
    seen.conns.push(ws);
    ws.on('message', (data, isBinary) => {
      if (isBinary) { seen.audioIn.push(decodeFrame(Buffer.from(data))); return; }
      const m = JSON.parse(String(data));
      if (m.type === 'hello') { seen.hellos.push(m); ws.send(JSON.stringify({ type: 'ready', sessionId: m.sessionId, platform: m.platform })); onHello?.(ws, m); }
      else seen.controls.push(m);
    });
  });
  return { wss, seen, url: `ws://127.0.0.1:${wss.address().port}/stream` };
}
const fakeAudio = () => ({ fromCaller: new PassThrough(), toCaller: new PassThrough(), close() {} });

test('assistant link: hello, caller audio up, speech down (paced), interrupt, ping, hangup', async () => {
  const mock = startMock();
  const audio = fakeAudio();
  let hung = null;
  const link = connectAssistant({ url: mock.url, secret: 's3', callId: '4242', userId: 'user-1', audio, onHangup: (w) => { hung = w; } });
  await sleep(300);
  assert.equal(mock.seen.hellos.length, 1);
  const h = mock.seen.hellos[0];
  assert.deepEqual([h.type, h.sessionId, h.platform, h.sampleRate, h.channels, h.encoding, h.secret, h.userId],
    ['hello', 'call-4242', 'signal', 16000, 1, 'pcm_s16le', 's3', 'user-1']);
  assert.equal(link._state().ready, true);

  // 100 ms of caller audio at 48k -> five 20 ms frames of 640 bytes at 16k
  audio.fromCaller.write(pcm(4800));
  await sleep(100);
  assert.equal(mock.seen.audioIn.length, 5);
  assert.deepEqual(mock.seen.audioIn.map((f) => f.sequence), [0, 1, 2, 3, 4]);
  assert.ok(mock.seen.audioIn.every((f) => f.type === FRAME.AUDIO_IN && f.sampleRate === 16000 && f.payload.length === 640));

  // assistant speaks 200 ms (3200 samples @16k): arrives as 3x samples @48k, paced out in 20 ms chunks
  const ws = mock.seen.conns[0];
  const got = []; audio.toCaller.on('data', (c) => got.push(c));
  ws.send(encodeFrame({ type: FRAME.AUDIO_OUT, sampleRate: 16000, sequence: 0, timestampMs: Date.now(), payload: pcm(3200, 500) }));
  await sleep(120);
  const early = Buffer.concat(got).length;
  assert.ok(early > 0 && early < 3200 * 6, `paced, not dumped at once (got ${early})`);

  // interrupt drops what is still queued
  ws.send(JSON.stringify({ type: 'interrupt' }));
  await sleep(60);
  const afterInterrupt = Buffer.concat(got).length;
  await sleep(200);
  assert.equal(Buffer.concat(got).length, afterInterrupt, 'nothing more plays after interrupt');
  assert.ok(afterInterrupt < 3200 * 6);

  // heartbeat + hangup
  ws.send(JSON.stringify({ type: 'ping' }));
  await sleep(50);
  assert.ok(mock.seen.controls.some((m) => m.type === 'pong'));
  ws.send(JSON.stringify({ type: 'hangup' }));
  await sleep(50);
  assert.equal(hung, 'assistant');
  link.close(); mock.wss.close();
});

test('reconnects with the SAME sessionId after the socket drops', async () => {
  const mock = startMock();
  const link = connectAssistant({ url: mock.url, secret: 's', callId: '9', audio: fakeAudio() });
  await sleep(250);
  mock.seen.conns[0].terminate();
  await sleep(1200);
  assert.equal(mock.seen.hellos.length, 2);
  assert.equal(mock.seen.hellos[1].sessionId, 'call-9');
  assert.equal(link._state().ready, true);
  link.close(); mock.wss.close();
});
