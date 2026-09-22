// w-okada/voice-changer integration layer.
//
// This is the only file in the repo that knows how to talk to a VCClient
// server (github.com/w-okada/voice-changer). RVC is the conversion engine —
// the w-okada server hosts the RVC model in a "slot" and this file just
// selects a slot and streams PCM through it.
//
// Transport: the server's REST conversion route, `POST /test`
// (server/restapi/MMVC_Rest_VoiceChanger.py). Request body is
//   { "timestamp": <int>, "buffer": <base64 of little-endian int16 PCM> }
// and the response is
//   { "timestamp": <int>, "changedVoiceBase64": <base64 of int16 PCM> }
// which is the same call the upstream client lib makes when its protocol is
// set to "rest".
//
// Why REST and not the Socket.IO `/test` namespace:
//   * no new dependency in server/package.json;
//   * request/response matches one-in-one-out chunk conversion exactly, so a
//     slow chunk can be dropped instead of queued behind a persistent socket;
//   * the upstream Socket.IO handler keeps a single process-wide `sid`, so a
//     persistent connection doesn't buy isolation between concurrent calls
//     either.
// With keep-alive on, the per-chunk HTTP overhead is ~1-2 ms against an
// inference budget of tens of ms, so nothing meaningful is lost.
//
// Sample format is int16 PCM at VOICE_CHANGER_SAMPLE_RATE (48000 by default,
// matching VoiceChangerSettings.inputSampleRate upstream). The server
// resamples to the model's own processing rate internally.
//
// Why this runs in the relay rather than in the browser: the VC server's
// TrustedOriginMiddleware returns HTTP 400 "Invalid origin header" for any
// browser origin it wasn't started with --allowed-origins for, and it usually
// serves self-signed HTTPS on a LAN address the user's phone can't reach
// anyway. Server-to-server calls from Node send no Origin header, so they
// pass. It also keeps the mic audio off a second network path.

import http from 'node:http';
import https from 'node:https';

const VC_URL = (process.env.VOICE_CHANGER_URL || '').replace(/\/+$/, '');
const VC_SAMPLE_RATE = Number(process.env.VOICE_CHANGER_SAMPLE_RATE || 48000);
const VC_TIMEOUT_MS = Number(process.env.VOICE_CHANGER_TIMEOUT_MS || 2500);
const VC_MAX_PENDING = Number(process.env.VOICE_CHANGER_MAX_PENDING || 2);
// w-okada's `--https true` mints a self-signed cert. Operators who point at
// one of those (or an ngrok/Cloudflare tunnel they don't want to re-issue for)
// can opt out of verification explicitly — it's the relay talking to their own
// GPU box, not a public endpoint.
const VC_TLS_INSECURE = /^(1|true|yes)$/i.test(process.env.VOICE_CHANGER_TLS_INSECURE || '');

// Keep-alive matters: a fresh TLS handshake per 100 ms audio chunk would cost
// more than the inference itself.
const agents = {
  http: new http.Agent({ keepAlive: true, maxSockets: 32 }),
  https: new https.Agent({ keepAlive: true, maxSockets: 32, rejectUnauthorized: !VC_TLS_INSECURE }),
};

export function isConfigured() {
  return Boolean(VC_URL);
}

export function configuredUrl() {
  return VC_URL;
}

export function sampleRate() {
  return VC_SAMPLE_RATE;
}

/**
 * Minimal JSON request/response helper over node:http(s).
 *
 * Used instead of global fetch so `rejectUnauthorized` is controllable per
 * request (Node's fetch has no option for it without pulling in undici's
 * Agent, which isn't exposed as a builtin) and so keep-alive is explicit.
 */
function vcRequest(path, { method = 'GET', body, headers: extraHeaders, timeoutMs = VC_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(VC_URL + path);
    } catch (err) {
      return reject(new Error(`VOICE_CHANGER_URL is not a valid URL: ${VC_URL}`));
    }
    const isHttp = url.protocol === 'http:';
    const transport = isHttp ? http : https;
    const payload = body == null ? undefined : typeof body === 'string' ? body : String(body);
    const req = transport.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (isHttp ? 80 : 443),
        path: `${url.pathname}${url.search}`,
        method,
        agent: agents[isHttp ? 'http' : 'https'],
        headers: {
          Accept: 'application/json',
          ...(payload != null
            ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
            : {}),
          // Deliberately no Origin header anywhere in this file:
          // TrustedOriginMiddleware 400s any origin it wasn't started with.
          ...extraHeaders,
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new Error(`voice changer ${method} ${path} -> HTTP ${res.statusCode}: ${text.slice(0, 200)}`));
          }
          try {
            resolve(JSON.parse(text));
          } catch {
            reject(new Error(`voice changer ${path} returned non-JSON: ${text.slice(0, 200)}`));
          }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error(`voice changer ${path} timed out after ${timeoutMs}ms`)));
    req.on('error', reject);
    if (payload != null) req.write(payload);
    req.end();
  });
}

/** Raw `GET /info` payload from the VC server. */
export async function getInfo() {
  return vcRequest('/info');
}

/**
 * Normalised list of voices the VC server can currently speak with.
 *
 * `modelSlots` entries are the w-okada slot metadata objects (snake_case:
 * slot_index / name / voice_changer_type / icon_file / sample_rate). Empty
 * slots are placeholders with no model file, so they're filtered out — a user
 * picking one would just get silence back.
 */
export async function listModels() {
  const info = await getInfo();
  const slots = Array.isArray(info?.modelSlots) ? info.modelSlots : [];
  const models = slots
    .filter((s) => s && (s.model_file || s.modelFile))
    .map((s) => ({
      slot: s.slot_index ?? s.slotIndex ?? null,
      name: s.name || s.model_file || s.modelFile || `Slot ${s.slot_index}`,
      type: s.voice_changer_type || s.voiceChangerType || 'unknown',
      icon: s.icon_file || s.iconFile || null,
      sampleRate: s.sample_rate || s.sampleRate || null,
      isOnnx: Boolean(s.is_onnx ?? s.isOnnx),
    }))
    .filter((m) => m.slot !== null);
  return {
    models,
    activeSlot: info?.modelSlotIndex ?? null,
    inputSampleRate: info?.inputSampleRate ?? null,
    outputSampleRate: info?.outputSampleRate ?? null,
    passThrough: Boolean(info?.passThrough),
  };
}

/**
 * Load an RVC model into the active slot. `POST /update_settings` is
 * form-encoded (FastAPI `Form(...)` params), not JSON — sending JSON here
 * fails with a 422.
 */
export async function setModelSlot(slot) {
  const body = new URLSearchParams({ key: 'modelSlotIndex', val: String(slot) });
  return vcRequest('/update_settings', {
    method: 'POST',
    body,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeoutMs: 30_000, // first load of a model pulls weights into VRAM
  });
}

/** Server-side bypass: `changeVoice()` returns the input untouched. */
export async function setPassThrough(enabled) {
  const body = new URLSearchParams({ key: 'passThrough', val: enabled ? 'true' : 'false' });
  return vcRequest('/update_settings', {
    method: 'POST',
    body,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
}

/**
 * Streams PCM through the VC server, one chunk at a time.
 *
 * `push()` never blocks and never rejects — a call in progress can't be
 * allowed to crash because the GPU hiccuped. Instead it bounds the backlog
 * and drops the *oldest* queued chunk when the converter falls behind, which
 * trades a small audio gap for keeping latency flat. Dropping the newest
 * instead would make the delay grow without limit.
 */
export class RealtimeConverter {
  constructor({ onAudio, onError, onStats, maxPending = VC_MAX_PENDING, timeoutMs = VC_TIMEOUT_MS } = {}) {
    this.onAudio = onAudio || (() => {});
    this.onError = onError || (() => {});
    this.onStats = onStats || (() => {});
    this.maxPending = Math.max(1, maxPending);
    this.timeoutMs = timeoutMs;
    this.queue = [];
    this.busy = false;
    this.closed = false;
    this.stats = { sent: 0, received: 0, dropped: 0, errors: 0, lastRttMs: 0 };
  }

  /** @param {Buffer} pcm16 - little-endian int16 PCM at VC_SAMPLE_RATE */
  push(pcm16) {
    if (this.closed || !pcm16 || pcm16.length === 0) return;
    this.queue.push(pcm16);
    while (this.queue.length > this.maxPending) {
      this.queue.shift();
      this.stats.dropped++;
    }
    this._drain();
  }

  async _drain() {
    if (this.busy || this.closed) return;
    this.busy = true;
    try {
      while (this.queue.length && !this.closed) {
        const chunk = this.queue.shift();
        const started = Date.now();
        try {
          const data = await vcRequest('/test', {
            method: 'POST',
            body: JSON.stringify({ timestamp: started, buffer: chunk.toString('base64') }),
            timeoutMs: this.timeoutMs,
          });
          this.stats.lastRttMs = Date.now() - started;
          const b64 = data?.changedVoiceBase64;
          if (b64) {
            this.stats.received++;
            this.onAudio(Buffer.from(b64, 'base64'));
          }
        } catch (err) {
          this.stats.errors++;
          this.onError(err);
          // Don't spin: if the VC server is down, back off a beat so a dead
          // endpoint doesn't turn into a tight retry loop burning CPU on a
          // live call.
          await new Promise((r) => setTimeout(r, 250));
        }
        this.stats.sent++;
        this.onStats(this.stats);
      }
    } finally {
      this.busy = false;
    }
  }

  close() {
    this.closed = true;
    this.queue.length = 0;
  }
}
