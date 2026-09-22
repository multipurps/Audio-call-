// Direct Caller Mode bridge.
//
// Joins a browser's microphone to a live Twilio call, with an optional
// real-time voice conversion step in between:
//
//   mic -> [voice changer] -> mulaw/8000 -> Twilio media stream -> caller
//   caller -> Twilio media stream -> mulaw decode -> browser speaker (untouched)
//
// This is deliberately *not* the AI path. When a session is in 'direct' mode
// there is no STT, no LLM, no TTS and no transcript: server/relay.js checks
// isDirect() before it buffers caller audio for Whisper, and never calls
// speak(). Switching back to 'ai' mode restores the original pipeline
// exactly as it was — see server/AUDIO-PATH.md.
//
// Two WebSockets meet here, matched by callId:
//   * Twilio's media stream (opened by <Connect><Stream> in api/calls-twiml.js)
//   * the browser's mic stream (opened by lib/directCallAudio.js)
// Either can arrive first, so both are stored on a session record and the
// audio only starts flowing once both exist.

import crypto from 'node:crypto';
import * as vc from './voiceChanger.js';
import {
  mulawToPcm16,
  pcm16ToMulaw,
  pcm16ToFloat,
  floatToPcm16,
  mulawFrames,
  LinearResampler,
} from './audioCodec.js';

export const TWILIO_FRAME_SIZE = 160; // 20 ms of 8 kHz mulaw — what Twilio expects
const SILENCE_FRAME = Buffer.alloc(TWILIO_FRAME_SIZE); // mulaw 0x00 decodes to ~-8031; see note below

// Silence in mu-law is not 0x00 (that's a loud negative sample) — 0xFF is the
// μ-law encoding of ~0. Filling gaps with 0x00 would put a 50 Hz buzz in the
// caller's ear for the whole call.
SILENCE_FRAME.fill(0xff);

// Uplink is sent at the voice changer's rate (48 kHz by default) so the relay
// can hand it straight to the VC server without resampling twice. Downlink
// goes back at Twilio's native 8 kHz: the caller's audio is decoded and
// forwarded with no processing at all, which is the "incoming audio
// untouched" requirement taken literally.
export function streamRate() {
  return vc.sampleRate();
}
export const playRate = 8000;

/** Max queued outgoing frames before we start dropping (20 ms each). */
const MAX_PACER_QUEUE = 40; // ~800 ms
const HEARTBEAT_MS = 25_000;
const HEARTBEAT_TIMEOUT_MS = 20_000;

// Signing key for the browser->relay WebSocket. DIRECT_BRIDGE_SECRET is the
// explicit knob; falling back to the service-role key means the feature works
// on an existing deploy without a new env var, since both Vercel and the relay
// already hold that key.
function signingKey() {
  return process.env.DIRECT_BRIDGE_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
}

function hmac(payload) {
  return crypto.createHmac('sha256', signingKey()).update(payload).digest('base64url');
}

/** Short-lived ticket the browser presents when it opens the direct socket. */
export function createBridgeToken(callId, userId, ttlSeconds = 300) {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const payload = `${callId}.${userId}.${exp}`;
  return { token: `${payload}.${hmac(payload)}`, exp };
}

export function verifyBridgeToken(callId, userId, exp, token) {
  const key = signingKey();
  if (!key) return false;
  const payload = `${callId}.${userId}.${exp}`;
  const expected = `${payload}.${hmac(payload)}`;
  if (typeof token !== 'string' || token.length !== expected.length) return false;
  if (!crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected))) return false;
  return Number(exp) * 1000 > Date.now();
}

// ---------------------------------------------------------------------------
// Session registry
// ---------------------------------------------------------------------------

const sessions = new Map(); // callId -> session

function createSession({ callId, userId, mode = 'ai', vcEnabled = true, modelSlot = null }) {
  const session = {
    callId,
    userId: userId || null,
    twilioWs: null,
    streamSid: null,
    browserWs: null,
    mode: mode === 'direct' ? 'direct' : 'ai',
    vcEnabled: vcEnabled !== false,
    modelSlot,
    monitor: true, // whether the browser plays the caller's audio back locally
    // converted (or passthrough) mic audio, at VC rate -> telephony rate
    down: new LinearResampler(streamRate(), playRate),
    converter: null,
    pacerQueue: [],
    pacerTimer: null,
    heartbeat: null,
    vcErrors: 0,
    onModeChange: null, // set by relay.js so mode flips reach Supabase + the AI path
    sendToTwilio: null, // set by relay.js
    closed: false,
  };
  sessions.set(callId, session);
  return session;
}

export function getSession(callId) {
  return sessions.get(callId);
}

/** True while this call is carrying live microphone audio instead of the AI. */
export function isDirect(callId) {
  const s = sessions.get(callId);
  return Boolean(s && s.mode === 'direct' && s.twilioWs && s.browserWs);
}

/** Called by relay.js on Twilio's `start` event. */
export function attachTwilio({ callId, userId, ws, streamSid, mode, vcEnabled, modelSlot, onModeChange, sendToTwilio }) {
  const session = sessions.get(callId) || createSession({ callId, userId, mode, vcEnabled, modelSlot });
  session.twilioWs = ws;
  session.streamSid = streamSid;
  session.userId = userId || session.userId;
  session.onModeChange = onModeChange || null;
  session.sendToTwilio = sendToTwilio || null;
  if (mode) session.mode = mode === 'direct' ? 'direct' : 'ai';
  if (typeof vcEnabled === 'boolean') session.vcEnabled = vcEnabled;
  if (modelSlot != null) session.modelSlot = modelSlot;
  if (session.mode === 'direct') syncConverter(session);
  return session;
}

export function detachTwilio(callId) {
  const session = sessions.get(callId);
  if (!session) return;
  // Twilio's stop event means the phone call is over, not merely that the
  // Twilio socket is idle. Close the browser socket too so the phone stops
  // capturing the microphone and the UI can leave Direct Voice cleanly.
  destroySession(callId);
}

function destroySession(callId) {
  const session = sessions.get(callId);
  if (!session) return;
  session.closed = true;
  stopPacer(session);
  clearInterval(session.heartbeat);
  session.converter?.close();
  session.converter = null;
  try {
    session.browserWs?.close();
  } catch {
    /* already gone */
  }
  sessions.delete(callId);
}

/** Called by relay.js when Twilio sends the call's audio (`media` event). */
export function onCallerAudio(callId, mulawBuffer) {
  const session = sessions.get(callId);
  if (!session || session.mode !== 'direct' || !session.browserWs || !session.monitor) return;
  if (session.browserWs.readyState !== 1) return;
  // Decode to PCM16 and forward raw. No conversion, no gain, no resampling —
  // the requirement is that the incoming side is untouched, and the browser
  // does the 8 kHz -> device-rate resampling in its playback worklet.
  const pcm = mulawToPcm16(mulawBuffer);
  session.browserWs.send(Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength));
}

// ---------------------------------------------------------------------------
// Browser socket
// ---------------------------------------------------------------------------

export function attachBrowser(ws, { callId, userId, exp, token }) {
  if (!verifyBridgeToken(callId, userId, exp, token)) {
    ws.send(JSON.stringify({ type: 'error', message: 'Direct-call ticket rejected', fatal: true }));
    ws.close(4401, 'unauthorized');
    return null;
  }

  const session = sessions.get(callId) || createSession({ callId, userId });
  if (session.browserWs && session.browserWs !== ws && session.browserWs.readyState === 1) {
    // A second tab/device took over this call — the old one gets told so it
    // can stop capturing the mic instead of silently competing with it.
    try {
      session.browserWs.send(JSON.stringify({ type: 'error', message: 'Direct call taken over elsewhere', fatal: true }));
      session.browserWs.close(4409, 'replaced');
    } catch {
      /* ignore */
    }
  }

  session.browserWs = ws;
  session.userId = userId || session.userId;

  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });
  clearInterval(session.heartbeat);
  session.heartbeat = setInterval(() => {
    if (ws.isAlive === false) {
      ws.terminate();
      return;
    }
    ws.isAlive = false;
    try {
      ws.ping();
    } catch {
      ws.terminate();
    }
  }, HEARTBEAT_MS);

  ws.on('message', (raw, isBinary) => {
    // ws hands both kinds over as a Buffer, so `Buffer.isBuffer` is not a
    // usable test here — only the isBinary flag distinguishes microphone PCM
    // from a JSON control message.
    if (isBinary) return handleMicAudio(session, raw);
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    handleControl(session, msg);
  });

  ws.on('close', () => {
    clearInterval(session.heartbeat);
    if (session.browserWs === ws) {
      session.browserWs = null;
      stopPacer(session);
      session.converter?.close();
      session.converter = null;
      // If the browser goes away mid-conversation the caller would otherwise
      // be left talking to a dead line. Fall back to the AI, which is the
      // pre-existing behaviour for this call, and say so in the transcript so
      // the user can see why Emysa picked the phone back up.
      if (session.mode === 'direct' && session.twilioWs && !session.closed) {
        session.mode = 'ai';
        session.onModeChange?.('ai', 'Direct call dropped — switched back to AI Voice.');
      }
      if (!session.twilioWs) destroySession(callId);
    }
  });

  ws.on('error', () => {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  });

  send(ws, {
    type: 'ready',
    callId,
    mode: session.mode,
    streamRate: streamRate(),
    playRate,
    vc: vcState(session),
  });

  if (session.mode === 'direct') syncConverter(session);
  return session;
}

function send(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function vcState(session) {
  return {
    configured: vc.isConfigured(),
    enabled: session.vcEnabled,
    modelSlot: session.modelSlot,
  };
}

function handleControl(session, msg) {
  if (msg?.type === 'vc') {
    if (typeof msg.enabled === 'boolean') session.vcEnabled = msg.enabled;
    if (msg.slot != null) {
      session.modelSlot = msg.slot;
      // Loading a model is a server-wide operation on the VC box (one active
      // slot), so await it and report the result rather than optimistically
      // claiming the voice changed.
      vc
        .setModelSlot(msg.slot)
        .then(() => send(session.browserWs, { type: 'status', vc: vcState(session) }))
        .catch((err) => send(session.browserWs, { type: 'error', message: `Could not load voice: ${err.message}` }));
    }
    syncConverter(session);
    send(session.browserWs, { type: 'status', vc: vcState(session) });
    return;
  }

  if (msg?.type === 'mode') {
    const next = msg.mode === 'direct' ? 'direct' : 'ai';
    if (next === session.mode) return;
    session.mode = next;
    syncConverter(session);
    if (next === 'ai') stopPacer(session);
    send(session.browserWs, { type: 'mode', mode: next });
    session.onModeChange?.(next, null);
    return;
  }

  if (msg?.type === 'monitor') {
    session.monitor = msg.on !== false;
    send(session.browserWs, { type: 'status', vc: vcState(session), monitor: session.monitor });
  }
}

/**
 * Mic PCM16 at streamRate, straight from the browser's capture worklet.
 *
 * This is the only place outgoing user audio enters the call. With the voice
 * changer on it goes through w-okada first; with it off the same samples are
 * resampled and sent as-is.
 */
function handleMicAudio(session, raw) {
  if (session.mode !== 'direct' || !session.twilioWs || session.closed) return;
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  if (buf.length < 2) return;
  // Trim to an even byte count — a half-sample at the end would shift every
  // following sample by 8 bits.
  const pcm = buf.subarray(0, buf.length - (buf.length % 2));
  if (session.converter) session.converter.push(pcm);
  else forwardMicAudio(session, pcm);
}

/** Converted-or-passthrough PCM16 at streamRate -> telephony frames to Twilio. */
function forwardMicAudio(session, pcm16) {
  if (session.mode !== 'direct' || !session.twilioWs) return;
  const telephony = session.down.process(pcm16ToFloat(new Int16Array(toArrayBuffer(pcm16))));
  if (telephony.length === 0) return;
  const mulaw = pcm16ToMulaw(floatToPcm16(telephony));
  for (const frame of mulawFrames(mulaw, TWILIO_FRAME_SIZE)) {
    if (session.pacerQueue.length >= MAX_PACER_QUEUE) session.pacerQueue.shift();
    session.pacerQueue.push(frame);
  }
  startPacer(session);
}

function toArrayBuffer(buf) {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

// ---------------------------------------------------------------------------
// Outbound pacing
// ---------------------------------------------------------------------------
//
// Conversion returns audio in bursts (one chunk every ~100 ms) while Twilio
// wants a continuous stream. Dripping one 20 ms frame at a time and filling
// the gaps with mu-law silence keeps the far end's playback smooth instead of
// stuttering, and costs 20 ms of latency.

function startPacer(session) {
  if (session.pacerTimer) return;
  session.pacerTimer = setInterval(() => pumpPacer(session), 20);
}

function stopPacer(session) {
  clearInterval(session.pacerTimer);
  session.pacerTimer = null;
  session.pacerQueue.length = 0;
}

function pumpPacer(session) {
  if (!session.twilioWs || session.mode !== 'direct' || session.twilioWs.readyState !== 1) {
    stopPacer(session);
    return;
  }
  const frame = session.pacerQueue.length ? session.pacerQueue.shift() : SILENCE_FRAME;
  session.twilioWs.send(
    JSON.stringify({
      event: 'media',
      streamSid: session.streamSid,
      media: { payload: frame.toString('base64') },
    })
  );
}

// ---------------------------------------------------------------------------
// Voice changer wiring
// ---------------------------------------------------------------------------

/**
 * Bring the converter in line with (mode, vcEnabled). Idempotent — called on
 * connect and on every control message.
 */
function syncConverter(session) {
  const wanted = session.mode === 'direct' && session.vcEnabled && vc.isConfigured();
  if (wanted && !session.converter) {
    session.down.reset();
    session.converter = new vc.RealtimeConverter({
      onAudio: (pcm16) => forwardMicAudio(session, pcm16),
      onError: (err) => {
        session.vcErrors++;
        send(session.browserWs, { type: 'error', message: `Voice changer: ${err.message}` });
        // After repeated failure, stop pretending: drop to passthrough so the
        // caller at least hears the user's own voice rather than silence.
        if (session.vcErrors === 3) {
          session.converter?.close();
          session.converter = null;
          send(session.browserWs, {
            type: 'status',
            vc: { ...vcState(session), enabled: false, failedOver: true },
          });
        }
      },
      onStats: (stats) => send(session.browserWs, { type: 'stats', ...stats }),
    });
  } else if (!wanted) {
    // Switching the changer off must not let already-converted buffered audio
    // leak out after the UI says "off". Clear both the converter backlog and
    // the Twilio pacer queue; the next raw mic chunk will restart pacing.
    session.converter?.close();
    session.converter = null;
    session.down.reset();
    stopPacer(session);
  }
  if (wanted) {
    session.vcErrors = 0;
    if (session.modelSlot != null) {
      vc.setModelSlot(session.modelSlot).catch(() => {
        /* reported through the /vc endpoints and the UI status line */
      });
    }
  }
}

// ---------------------------------------------------------------------------
// HTTP surface for api/calls.js (Vercel can't reach the VC box directly)
// ---------------------------------------------------------------------------

function authorized(req) {
  const secret = process.env.SOCIAL_RELAY_INTERNAL_SECRET || process.env.DIRECT_BRIDGE_SECRET || '';
  const given = req.headers['x-internal-secret'] || '';
  if (!secret || !given || given.length !== secret.length) return false;
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(secret));
}

function readJson(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        resolve({});
      }
    });
  });
}

function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(body));
}

/**
 * Plain-HTTP routes served by the relay:
 *   GET  /healthz     -> { ok: true }                        (Render health check)
 *   GET  /vc/state    -> { configured, models, activeSlot, sampleRate }
 *   POST /vc/model    -> { ok, activeSlot }                  (body: { slot })
 * The /vc/* routes require X-Internal-Secret.
 */
export async function handleHttp(req, res) {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/healthz') return json(res, 200, { ok: true });

  // Minted here rather than in api/calls.js so the signing key lives in
  // exactly one process — Vercel and Render can't drift apart on it.
  if (url.pathname === '/direct/ticket' && req.method === 'POST') {
    if (!authorized(req)) return json(res, 401, { error: 'Unauthorized' });
    const body = await readJson(req);
    if (!body.callId || !body.userId) return json(res, 400, { error: 'callId and userId required' });
    const { token, exp } = createBridgeToken(body.callId, body.userId);
    return json(res, 200, { token, exp, streamRate: streamRate(), playRate });
  }

  if (url.pathname.startsWith('/vc/')) {
    if (!authorized(req)) return json(res, 401, { error: 'Unauthorized' });

    if (!vc.isConfigured()) {
      return json(res, 200, { configured: false, models: [], activeSlot: null, sampleRate: streamRate() });
    }

    if (url.pathname === '/vc/state') {
      try {
        const info = await vc.listModels();
        return json(res, 200, { configured: true, sampleRate: streamRate(), ...info });
      } catch (err) {
        return json(res, 502, { configured: true, error: err.message });
      }
    }

    if (url.pathname === '/vc/model' && req.method === 'POST') {
      const body = await readJson(req);
      const slot = Number(body.slot);
      if (!Number.isFinite(slot)) return json(res, 400, { error: 'slot required' });
      try {
        await vc.setModelSlot(slot);
        return json(res, 200, { ok: true, activeSlot: slot });
      } catch (err) {
        return json(res, 502, { error: err.message });
      }
    }

    return json(res, 404, { error: 'Not found' });
  }

  return json(res, 404, { error: 'Not found' });
}

export function activeCallIds() {
  return [...sessions.keys()];
}
