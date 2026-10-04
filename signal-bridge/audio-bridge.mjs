// Connects a Signal call's virtual PulseAudio devices to the Pipecat assistant over ACAF v1
// (docs/ACAF-PROTOCOL.md). Call audio from the tunnel is 48 kHz mono s16le; the assistant
// bridge format is 16 kHz mono PCM16, so audio is converted in both directions.
import { spawn } from 'node:child_process';
import WebSocket from 'ws';

// ---------- ACAF frame codec (28-byte header, little-endian) ----------
export const HEADER_SIZE = 28;
export const FRAME = { AUDIO_IN: 1, AUDIO_OUT: 2, PARTIAL_TRANSCRIPT: 3, INTERRUPT: 4, HEARTBEAT: 5 };
const ENCODING_PCM_S16LE = 1;

export function encodeFrame({ type, sampleRate, sequence, timestampMs, payload }) {
  const b = Buffer.alloc(HEADER_SIZE + payload.length);
  b.write('ACAF', 0, 'ascii');
  b.writeUInt8(1, 4); // version
  b.writeUInt8(type, 5);
  b.writeUInt8(ENCODING_PCM_S16LE, 6);
  b.writeUInt8(1, 7); // channels
  b.writeUInt32LE(sampleRate, 8);
  b.writeUInt32LE(sequence >>> 0, 12);
  b.writeBigUInt64LE(BigInt(timestampMs), 16); // must be 64-bit
  b.writeUInt32LE(payload.length, 24);
  payload.copy(b, HEADER_SIZE);
  return b;
}

export function decodeFrame(buf) {
  if (buf.length < HEADER_SIZE || buf.toString('ascii', 0, 4) !== 'ACAF') return null;
  const len = buf.readUInt32LE(24);
  if (len > 65536 || buf.length < HEADER_SIZE + len) return null;
  return {
    version: buf.readUInt8(4),
    type: buf.readUInt8(5),
    encoding: buf.readUInt8(6),
    channels: buf.readUInt8(7),
    sampleRate: buf.readUInt32LE(8),
    sequence: buf.readUInt32LE(12),
    timestampMs: Number(buf.readBigUInt64LE(16)),
    payload: buf.subarray(HEADER_SIZE, HEADER_SIZE + len),
  };
}

// ---------- resampling (mono s16le) ----------
// 48k -> 16k: average each group of 3 samples (a cheap low-pass, fine for speech).
export class Downsampler48to16 {
  constructor() { this.rest = Buffer.alloc(0); }
  push(chunk) {
    const buf = this.rest.length ? Buffer.concat([this.rest, chunk]) : chunk;
    const n = Math.floor(buf.length / 6);
    const out = Buffer.alloc(n * 2);
    for (let i = 0; i < n; i++) {
      const s = (buf.readInt16LE(i * 6) + buf.readInt16LE(i * 6 + 2) + buf.readInt16LE(i * 6 + 4)) / 3;
      out.writeInt16LE(Math.round(s), i * 2);
    }
    this.rest = buf.subarray(n * 6);
    return out;
  }
}

// 16k -> 48k: linear interpolation, carrying the last sample across chunks.
export class Upsampler16to48 {
  constructor() { this.prev = 0; this.rest = Buffer.alloc(0); }
  push(chunk) {
    const buf = this.rest.length ? Buffer.concat([this.rest, chunk]) : chunk;
    const n = Math.floor(buf.length / 2);
    const out = Buffer.alloc(n * 6);
    for (let i = 0; i < n; i++) {
      const x = buf.readInt16LE(i * 2);
      const p = this.prev;
      out.writeInt16LE(Math.round(p + (x - p) / 3), i * 6);
      out.writeInt16LE(Math.round(p + ((x - p) * 2) / 3), i * 6 + 2);
      out.writeInt16LE(x, i * 6 + 4);
      this.prev = x;
    }
    this.rest = buf.subarray(n * 2);
    return out;
  }
}

// One-shot linear resample to 48 kHz for the unusual case where the assistant replies at another rate.
function resampleTo48k(buf, fromRate) {
  const inN = Math.floor(buf.length / 2);
  const outN = Math.floor((inN * 48000) / fromRate);
  const out = Buffer.alloc(outN * 2);
  for (let i = 0; i < outN; i++) {
    const pos = (i * fromRate) / 48000;
    const i0 = Math.min(inN - 1, Math.floor(pos));
    const i1 = Math.min(inN - 1, i0 + 1);
    const f = pos - i0;
    out.writeInt16LE(Math.round(buf.readInt16LE(i0 * 2) * (1 - f) + buf.readInt16LE(i1 * 2) * f), i * 2);
  }
  return out;
}

// ---------- PulseAudio devices for one call ----------
// Device names follow the signal-call-tunnel README (unverified on a live call):
//   we write to sink_for_<inputDeviceName>   -> the person on the call hears it
//   we read from <outputDeviceName>.monitor  -> what the person on the call says
const FMT = ['--rate=48000', '--channels=1', '--format=s16le', '--raw'];

export function attachAudio({ callId, inputDeviceName, outputDeviceName }) {
  if (!inputDeviceName || !outputDeviceName) throw new Error('call event has no audio device names yet');
  const rec = spawn('parecord', [`--device=${outputDeviceName}.monitor`, ...FMT]);
  const play = spawn('pacat', ['--playback', `--device=sink_for_${inputDeviceName}`, ...FMT]);
  const log = (p, d) => console.error(`[audio ${callId} ${p}] ${String(d).trim()}`);
  rec.stderr.on('data', (d) => log('rec', d));
  play.stderr.on('data', (d) => log('play', d));
  rec.on('error', (e) => log('rec', e.message));
  play.on('error', (e) => log('play', e.message));
  play.stdin.on('error', () => {}); // EPIPE once the call is gone
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    rec.kill('SIGTERM');
    play.stdin.end();
    play.kill('SIGTERM');
  };
  rec.on('exit', close);
  play.on('exit', close);
  return { fromCaller: rec.stdout, toCaller: play.stdin, close };
}

// ---------- echo test mode (ASSISTANT_MODE=echo) ----------
// The person on the call hears themselves about 200 ms late. Proves the whole audio path
// (signal-cli -> tunnel -> PulseAudio -> bridge -> back) with no assistant involved.
export function attachEcho(audio) {
  const queue = [];
  audio.fromCaller.on('data', (chunk) => {
    queue.push(chunk);
    if (queue.length > 10) audio.toCaller.write(queue.shift());
  });
  return { close() { queue.length = 0; } };
}

// ---------- ACAF link to the Pipecat assistant ----------
const FRAME_MS = 20;
const BRIDGE_RATE = 16000;
const IN_FRAME_BYTES = (BRIDGE_RATE * FRAME_MS * 2) / 1000; // 640
const OUT_CHUNK_BYTES = (48000 * FRAME_MS * 2) / 1000; // 1920
const MAX_QUEUE_BYTES = 48000 * 2 * 10; // never hold more than 10 s of unplayed speech
const RECONNECT_GRACE_MS = 15_000;

export function connectAssistant({ url, secret, callId, userId, audio, onHangup, onFatal, WebSocketImpl = WebSocket }) {
  const sessionId = `call-${callId}`;
  const log = (...a) => console.log(`[assistant ${sessionId}]`, ...a);
  const down = new Downsampler48to16();
  const up = new Upsampler16to48();
  let ws = null, ready = false, closed = false, seq = 0;
  let inBuf = Buffer.alloc(0);
  let outQueue = Buffer.alloc(0);
  let reconnectSince = 0, reconnectTimer = null;
  let nextTick = 0, pacer = null;

  function send(data, opts) { if (ws && ws.readyState === 1) ws.send(data, opts); }
  function sendControl(obj) { send(JSON.stringify(obj)); }

  function clearPlayout() { outQueue = Buffer.alloc(0); }
  function enqueue48k(pcm) {
    outQueue = Buffer.concat([outQueue, pcm]);
    if (outQueue.length > MAX_QUEUE_BYTES) outQueue = outQueue.subarray(outQueue.length - MAX_QUEUE_BYTES);
  }
  // Pace playback in real time: the assistant may deliver speech faster than it is spoken,
  // and an "interrupt" can only drop audio that has not been written to the call yet.
  function startPacer() {
    nextTick = Date.now() + FRAME_MS;
    const tick = () => {
      if (closed) return;
      if (outQueue.length > 0) {
        const n = Math.min(OUT_CHUNK_BYTES, outQueue.length);
        let chunk = outQueue.subarray(0, n);
        outQueue = outQueue.subarray(n);
        if (n < OUT_CHUNK_BYTES) chunk = Buffer.concat([chunk, Buffer.alloc(OUT_CHUNK_BYTES - n)]);
        try { audio.toCaller.write(chunk); } catch { /* call is ending */ }
      }
      nextTick += FRAME_MS;
      pacer = setTimeout(tick, Math.max(0, nextTick - Date.now()));
    };
    pacer = setTimeout(tick, FRAME_MS);
  }

  function onCallerAudio(chunk) {
    const pcm16k = down.push(chunk);
    if (!ready) return; // before "ready" the assistant is not listening yet
    inBuf = Buffer.concat([inBuf, pcm16k]);
    while (inBuf.length >= IN_FRAME_BYTES) {
      const payload = inBuf.subarray(0, IN_FRAME_BYTES);
      inBuf = inBuf.subarray(IN_FRAME_BYTES);
      send(encodeFrame({ type: FRAME.AUDIO_IN, sampleRate: BRIDGE_RATE, sequence: seq++, timestampMs: Date.now(), payload }), { binary: true });
    }
  }

  function onMessage(data, isBinary) {
    if (isBinary) {
      const f = decodeFrame(Buffer.from(data));
      if (!f) return;
      if (f.type === FRAME.AUDIO_OUT) {
        if (f.encoding !== ENCODING_PCM_S16LE) return;
        enqueue48k(f.sampleRate === BRIDGE_RATE ? up.push(f.payload) : resampleTo48k(f.payload, f.sampleRate));
      } else if (f.type === FRAME.INTERRUPT) {
        clearPlayout();
      } else if (f.type === FRAME.HEARTBEAT) {
        send(encodeFrame({ type: FRAME.HEARTBEAT, sampleRate: BRIDGE_RATE, sequence: seq++, timestampMs: Date.now(), payload: Buffer.alloc(0) }), { binary: true });
      }
      return;
    }
    let msg;
    try { msg = JSON.parse(String(data)); } catch { return; }
    switch (msg.type) {
      case 'ready':
        ready = true; reconnectSince = 0;
        log('ready');
        break;
      case 'ping': sendControl({ type: 'pong' }); break;
      case 'interrupt': clearPlayout(); break;
      case 'hangup': log('assistant ended the call'); onHangup?.('assistant'); break;
      case 'stopped': log('session stopped:', msg.reason); break;
      case 'error': log('error from assistant:', msg.message || msg.error || JSON.stringify(msg)); break;
      default: break; // metrics etc.
    }
  }

  function connect() {
    if (closed) return;
    ready = false;
    const sock = new WebSocketImpl(url, { handshakeTimeout: 10_000 });
    ws = sock;
    sock.on('open', () => {
      sendControl({
        type: 'hello', sessionId, platform: 'signal', sampleRate: BRIDGE_RATE, channels: 1,
        encoding: 'pcm_s16le', secret, ...(userId ? { userId } : {}),
      });
    });
    sock.on('message', onMessage);
    sock.on('error', (e) => log('socket error:', e.message));
    sock.on('close', () => {
      if (closed || ws !== sock) return;
      ready = false;
      // Resume with the SAME sessionId within the grace period (protocol rule 6).
      if (!reconnectSince) reconnectSince = Date.now();
      if (Date.now() - reconnectSince > RECONNECT_GRACE_MS) {
        log('assistant unreachable, giving up');
        onFatal?.('assistant-unreachable');
        return;
      }
      reconnectTimer = setTimeout(connect, 500);
    });
  }

  audio.fromCaller.on('data', onCallerAudio);
  startPacer();
  connect();

  return {
    sessionId,
    close() {
      if (closed) return;
      closed = true;
      clearTimeout(pacer); clearTimeout(reconnectTimer);
      try { sendControl({ type: 'hangup' }); ws?.close(); } catch { /* already closed */ }
    },
    // exposed for tests
    _state: () => ({ ready, queued: outQueue.length, seq }),
  };
}
