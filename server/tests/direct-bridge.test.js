// End-to-end test of Direct Caller Mode against the real relay.
//
// This drives server/relay.js itself — not a re-implementation of it — over
// real WebSockets, with a stub w-okada server standing in for the GPU box.
// Two things are being pinned down, both of them requirements rather than
// implementation details:
//
//   1. In Direct Voice, microphone audio reaches Twilio *converted*, and
//      caller audio reaches the browser untouched.
//   2. In Direct Voice, none of the AI pipeline runs: no Whisper, no LLM, no
//      Fish TTS. That's asserted by watching every outbound fetch the relay
//      makes, which is the only way to prove a negative like that.
//
// The AI path is exercised in the same run (the greeting goes out before the
// mode switch) so the test would also fail if direct mode were wired in by
// breaking it.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { mulawToPcm16, pcm16ToMulaw, mulawFrames } from '../audioCodec.js';

// directBridge.js (and voiceChanger.js behind it) read their config from
// process.env at import time, so both have to be imported *after* the env
// block in before() below — a static import here would resolve first and pin
// VOICE_CHANGER_URL to empty for the whole run.
let createBridgeToken;

const PORT = 8391;
const VC_PORT = 8392;
const SECRET = 'test-internal-secret';
const CALL_ID = '11111111-2222-3333-4444-555555555555';
const USER_ID = '99999999-8888-7777-6666-555555555555';
const STREAM_RATE = 48000;

// The stub VC negates every sample. That makes "converted" and "not
// converted" trivially distinguishable in the mu-law the caller receives,
// without needing to reproduce RVC.
const vcHits = [];
let vcServer;

function startVcServer() {
  vcServer = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      vcHits.push({ path: req.url, method: req.method, body });

      if (req.url === '/info') {
        return json(res, {
          status: 'OK',
          modelSlotIndex: 2,
          inputSampleRate: 48000,
          outputSampleRate: 48000,
          passThrough: false,
          modelSlots: [
            { slot_index: 0 }, // empty placeholder — must be filtered out
            { slot_index: 2, name: 'Test Voice', voice_changer_type: 'RVC', model_file: 'test.pth' },
            { slot_index: 5, name: 'Second', voice_changer_type: 'RVC', model_file: 's.onnx', is_onnx: true },
          ],
        });
      }
      if (req.url === '/update_settings') return json(res, { status: 'OK', modelSlotIndex: 2 });
      if (req.url === '/test' && req.method === 'POST') {
        const parsed = JSON.parse(body);
        const pcm = new Int16Array(Buffer.from(parsed.buffer, 'base64').buffer);
        const out = new Int16Array(pcm.length);
        for (let i = 0; i < pcm.length; i++) out[i] = -pcm[i];
        return json(res, { timestamp: parsed.timestamp, changedVoiceBase64: Buffer.from(out.buffer).toString('base64') });
      }
      res.writeHead(404);
      res.end('{}');
    });
  });
  vcServer.listen(VC_PORT);
  return once(vcServer, 'listening');
}

function json(res, obj) {
  const payload = JSON.stringify(obj);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(payload);
}

// Every outbound HTTP call the relay makes, so "the AI pipeline did not run"
// is an observation rather than an assumption.
const fetchLog = [];
const realFetch = globalThis.fetch;
function installFetchStub() {
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    // Pass loopback traffic straight through: the test asserts against the
    // relay's own HTTP routes, and stubbing those would make every one of
    // those assertions test the stub.
    if (url.startsWith('http://127.0.0.1') || url.startsWith('http://localhost')) {
      return realFetch(url, init);
    }
    fetchLog.push(url);
    if (url.includes('api.fish.audio')) {
      // speak() reads this as raw mulaw; 320 bytes = two Twilio frames.
      return new Response(new Uint8Array(320).fill(0xff));
    }
    if (url.includes('api.groq.com')) return new Response(JSON.stringify({ text: 'stub transcript' }), { headers: { 'Content-Type': 'application/json' } });
    if (url.includes('fal.run')) {
      return new Response(JSON.stringify({ choices: [{ message: { content: 'stub reply' } }] }), { headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ data: null }), { headers: { 'Content-Type': 'application/json' } });
  };
}

function aiFetches() {
  return fetchLog.filter((u) => u.includes('api.fish.audio') || u.includes('api.groq.com') || u.includes('fal.run'));
}

let twilio;
let browser;
const twilioMedia = []; // decoded PCM16 samples the caller would hear
const browserAudio = []; // decoded PCM16 samples the user would hear
const browserMessages = [];

function collectTwilio(ws) {
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.event !== 'media') return;
    const pcm = mulawToPcm16(Buffer.from(msg.media.payload, 'base64'));
    for (const s of pcm) twilioMedia.push(s);
  });
}

function collectBrowser(ws) {
  ws.on('message', (raw, isBinary) => {
    if (isBinary) {
      const pcm = new Int16Array(raw.buffer, raw.byteOffset, raw.byteLength / 2);
      for (const s of pcm) browserAudio.push(s);
      return;
    }
    try {
      browserMessages.push(JSON.parse(raw.toString()));
    } catch {
      /* ignore */
    }
  });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeoutMs = 4000, stepMs = 25) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true; // awaited so sync and async predicates both work
    await wait(stepMs);
  }
  return await fn();
}

/** 128 ms of a steady +12000 tone at the voice changer's sample rate. */
function micChunk() {
  const n = Math.round((STREAM_RATE * 128) / 1000);
  const pcm = new Int16Array(n).fill(12000);
  return Buffer.from(pcm.buffer);
}

before(async () => {
  await startVcServer();
  installFetchStub();
  // relay.js and voiceChanger.js both read their config at import time, so
  // these have to be set before the dynamic import below.
  process.env.PORT = String(PORT);
  process.env.VOICE_CHANGER_URL = `http://127.0.0.1:${VC_PORT}`;
  process.env.VOICE_CHANGER_SAMPLE_RATE = String(STREAM_RATE);
  process.env.DIRECT_BRIDGE_SECRET = SECRET;
  process.env.SOCIAL_RELAY_INTERNAL_SECRET = SECRET;
  process.env.SUPABASE_URL = 'http://127.0.0.1:1';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key';
  process.env.FISH_API_KEY = 'test';
  process.env.GROQ_API_KEY = 'test';
  process.env.FAL_KEY = 'test';
  ({ createBridgeToken } = await import('../directBridge.js'));
  await import('../relay.js');
  // Wait for the relay to actually be accepting connections rather than
  // sleeping a fixed amount — a slow CI box shouldn't make this flaky.
  const up = await waitFor(async () => {
    try {
      await fetch(`http://127.0.0.1:${PORT}/healthz`);
      return true;
    } catch {
      return false;
    }
  }, 5000);
  assert.ok(up, 'relay did not start listening');
});

after(async () => {
  try { twilio?.close(); } catch { /* ignore */ }
  try { browser?.close(); } catch { /* ignore */ }
  vcServer?.close();
  // The relay's own HTTP server keeps the event loop alive by design; the
  // test script runs with --test-force-exit rather than killing the process
  // from in here.
});

test('the relay exposes a health route', async () => {
  const resp = await fetch(`http://127.0.0.1:${PORT}/healthz`);
  assert.equal(resp.status, 200);
  assert.deepEqual(await resp.json(), { ok: true });
});

test('/vc/state lists installed voices and skips empty slots', async () => {
  const resp = await fetch(`http://127.0.0.1:${PORT}/vc/state`, { headers: { 'X-Internal-Secret': SECRET } });
  assert.equal(resp.status, 200);
  const data = await resp.json();
  assert.equal(data.configured, true);
  assert.equal(data.sampleRate, STREAM_RATE);
  assert.equal(data.models.length, 2, 'the slot with no model file must not be offered');
  assert.deepEqual(data.models.map((m) => m.slot), [2, 5]);
  assert.equal(data.models[0].name, 'Test Voice');
  assert.equal(data.models[0].type, 'RVC');
  assert.equal(data.activeSlot, 2);
});

test('/vc/* rejects requests without the internal secret', async () => {
  const noHeader = await fetch(`http://127.0.0.1:${PORT}/vc/state`);
  assert.equal(noHeader.status, 401);
  const wrongHeader = await fetch(`http://127.0.0.1:${PORT}/vc/state`, { headers: { 'X-Internal-Secret': 'nope' } });
  assert.equal(wrongHeader.status, 401);
});

test('/vc/model loads a slot on the voice changer', async () => {
  const resp = await fetch(`http://127.0.0.1:${PORT}/vc/model`, {
    method: 'POST',
    headers: { 'X-Internal-Secret': SECRET, 'Content-Type': 'application/json' },
    body: JSON.stringify({ slot: 5 }),
  });
  assert.equal(resp.status, 200);
  assert.deepEqual(await resp.json(), { ok: true, activeSlot: 5 });
  const sent = vcHits.filter((h) => h.path === '/update_settings').pop();
  // update_settings is form-encoded, not JSON — a JSON body 422s upstream.
  assert.equal(sent.method, 'POST');
  assert.match(sent.body, /key=modelSlotIndex/);
  assert.match(sent.body, /val=5/);
});

test('AI mode still greets the caller through the existing pipeline', async () => {
  twilio = new WebSocket(`ws://127.0.0.1:${PORT}/stream?callId=${CALL_ID}`);
  collectTwilio(twilio);
  await once(twilio, 'open');
  // Twilio's real start event carries streamSid twice: top-level for the
  // stream, and nested under `start` alongside the call metadata. relay.js
  // reads the nested one, so send it the way Twilio actually does.
  twilio.send(JSON.stringify({
    event: 'start',
    sequenceNumber: '1',
    streamSid: 'SM-test',
    start: {
      streamSid: 'SM-test',
      callSid: 'CA-test',
      accountSid: 'AC-test',
      tracks: ['inbound'],
      mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 },
    },
  }));

  // The greeting is Fish TTS -> mulaw frames, exactly as before this change.
  const ok = await waitFor(() => twilioMedia.length > 0);
  assert.ok(ok, 'AI mode should still send a greeting to the caller');
  assert.ok(aiFetches().some((u) => u.includes('api.fish.audio')), 'greeting should come from Fish TTS');
});

test('a direct socket without a valid ticket is refused', async () => {
  const bad = new WebSocket(
    `ws://127.0.0.1:${PORT}/direct?callId=${CALL_ID}&userId=${USER_ID}&exp=9999999999&token=forged`
  );
  const msgs = [];
  bad.on('message', (raw) => msgs.push(JSON.parse(raw.toString())));
  await once(bad, 'open');
  const ok = await waitFor(() => msgs.some((m) => m.fatal));
  assert.ok(ok, 'forged ticket must be rejected');
  assert.match(msgs.find((m) => m.fatal).message, /rejected/i);
});

test('switching to Direct Voice hands the call to the microphone', async () => {
  const { token, exp } = createBridgeToken(CALL_ID, USER_ID);
  browser = new WebSocket(
    `ws://127.0.0.1:${PORT}/direct?callId=${CALL_ID}&userId=${USER_ID}&exp=${exp}&token=${token}`
  );
  browser.binaryType = 'nodebuffer';
  collectBrowser(browser);
  await once(browser, 'open');

  const ready = await waitFor(() => browserMessages.some((m) => m.type === 'ready'));
  assert.ok(ready, 'browser should get a ready message');
  const readyMsg = browserMessages.find((m) => m.type === 'ready');
  assert.equal(readyMsg.streamRate, STREAM_RATE);
  assert.equal(readyMsg.playRate, 8000);
  assert.equal(readyMsg.mode, 'ai', 'the call starts in AI mode until asked otherwise');

  browser.send(JSON.stringify({ type: 'mode', mode: 'direct' }));
  const switched = await waitFor(() => browserMessages.some((m) => m.type === 'mode' && m.mode === 'direct'));
  assert.ok(switched, 'relay should confirm the mode switch');
});

test('caller audio reaches the browser untouched', async () => {
  // A recognisable pattern, sent the way Twilio actually sends it.
  const pcm = new Int16Array(320);
  for (let i = 0; i < pcm.length; i++) pcm[i] = i % 2 === 0 ? 6000 : -6000;
  const mulaw = pcm16ToMulaw(pcm);
  const expected = mulawToPcm16(mulaw);
  for (const frame of mulawFrames(mulaw, 160)) {
    twilio.send(JSON.stringify({ event: 'media', streamSid: 'SM-test', media: { payload: frame.toString('base64') } }));
  }

  const ok = await waitFor(() => browserAudio.length >= 320);
  assert.ok(ok, `browser should receive the caller's audio, got ${browserAudio.length} samples`);
  // "Untouched" means whatever Twilio sent after μ-law decoding, with no
  // voice conversion, no gain, no resampling and no assistant involvement.
  for (let i = 0; i < 320; i++) {
    assert.equal(browserAudio[i], expected[i], `sample ${i}`);
  }
});

test('Direct Voice runs no STT, no LLM and no TTS', async () => {
  // Caller audio has been arriving, and the AI pipeline's own silence timer
  // is 700ms — wait well past it. In AI mode this is where Whisper would fire.
  const before = aiFetches().length;
  const pcm = new Int16Array(160).fill(3000);
  const mulaw = pcm16ToMulaw(pcm);
  twilio.send(JSON.stringify({ event: 'media', streamSid: 'SM-test', media: { payload: mulaw.toString('base64') } }));
  await wait(1600);
  assert.equal(aiFetches().length, before, 'no speech-to-text, LLM or TTS calls in Direct Voice');
});

test('the caller hears the converted microphone', async () => {
  twilioMedia.length = 0;
  for (let i = 0; i < 3; i++) browser.send(micChunk());

  const ok = await waitFor(() => twilioMedia.some((s) => s < -8000));
  assert.ok(ok, 'converted (negated) microphone audio should reach the caller');
  assert.ok(
    !twilioMedia.some((s) => s > 8000),
    'unconverted microphone audio must not leak through while the changer is on'
  );
  assert.ok(vcHits.some((h) => h.path === '/test'), 'conversion should go through the voice changer');
});

test('turning the changer off sends the raw microphone instead', async () => {
  browser.send(JSON.stringify({ type: 'vc', enabled: false }));
  const off = await waitFor(() => browserMessages.some((m) => m.type === 'status' && m.vc.enabled === false));
  assert.ok(off, 'relay should confirm the changer is off');

  twilioMedia.length = 0;
  await wait(200);
  for (let i = 0; i < 3; i++) browser.send(micChunk());

  const ok = await waitFor(() => twilioMedia.some((s) => s > 8000));
  assert.ok(ok, 'raw microphone audio should reach the caller when the changer is off');
  assert.ok(!twilioMedia.some((s) => s < -8000), 'nothing should still be converted');
});

test('muting is the browser\'s job, and stops audio leaving the phone', async () => {
  // The client drops muted audio before it hits the socket; the relay side
  // has nothing to receive. Verified by the absence of new non-silence frames.
  // The relay is allowed to send no frames at all while idle, or mu-law
  // silence if its pacer is already running — both are valid phone-call
  // behaviour as long as stale speech is not repeated.
  twilioMedia.length = 0;
  // Give the previous test's paced raw-audio queue time to drain. A few
  // hundred ms of already-sent audio after releasing the mic is acceptable;
  // repeating it forever would not be. Then observe a fresh idle window.
  await wait(1000);
  twilioMedia.length = 0;
  await wait(250);
  assert.ok(
    twilioMedia.every((s) => Math.abs(s) < 1000),
    'with no microphone input the caller should hear silence, not stale audio'
  );
});

test('hanging up tears down the direct session', async () => {
  twilio.send(JSON.stringify({ event: 'stop' }));
  const closed = await waitFor(() => browser.readyState !== WebSocket.OPEN, 3000);
  assert.ok(closed, 'the browser socket should close when the call ends');
});
