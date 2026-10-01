// Twilio Media Streams <-> ACAF bridge.
//
// Lets phone (Twilio) calls run on the Pipecat assistant service instead of
// the old batch relay: same pipeline as WhatsApp/Telegram calls, so phone
// calls get live transcript, listen-in, mid-call notes and the faster,
// interruption-aware turn handling.
//
// Audio never gets transcoded beyond G.711: Twilio sends 8 kHz mu-law, which
// ACAF accepts inbound as-is (encoding MULAW at 8000 Hz). The session is
// declared 8 kHz, so the service answers with 8 kHz PCM16, which this bridge
// only has to mu-law encode. The service resamples to its own pipeline rate.
//
// Enabled by TWILIO_VIA_PIPECAT=true plus ASSISTANT_BRIDGE_URL and
// ASSISTANT_BRIDGE_SECRET. Session id is `call-{calls.id}`; the service
// resolves the calls row from that id.

const MAGIC = Buffer.from('ACAF');
const HEADER_LEN = 28;
const TYPE_AUDIO_IN = 1;
const TYPE_AUDIO_OUT = 2;
const TYPE_INTERRUPT = 4;
const ENC_PCM16 = 1;
const ENC_MULAW = 2;
const SAMPLE_RATE = 8000;

export function bridgeEnabled(env = process.env) {
  return (
    String(env.TWILIO_VIA_PIPECAT || '').toLowerCase() === 'true' &&
    !!env.ASSISTANT_BRIDGE_URL &&
    !!env.ASSISTANT_BRIDGE_SECRET
  );
}

export function packFrame({ type, encoding, sampleRate, sequence, payload, now = Date.now() }) {
  const buf = Buffer.alloc(HEADER_LEN + payload.length);
  MAGIC.copy(buf, 0);
  buf.writeUInt8(1, 4);
  buf.writeUInt8(type, 5);
  buf.writeUInt8(encoding, 6);
  buf.writeUInt8(1, 7);
  buf.writeUInt32LE(sampleRate, 8);
  buf.writeUInt32LE(sequence >>> 0, 12);
  buf.writeBigUInt64LE(BigInt(now), 16);
  buf.writeUInt32LE(payload.length, 24);
  payload.copy(buf, HEADER_LEN);
  return buf;
}

export function parseFrame(buf) {
  if (buf.length < HEADER_LEN || !buf.subarray(0, 4).equals(MAGIC)) return null;
  const len = buf.readUInt32LE(24);
  if (buf.length < HEADER_LEN + len) return null;
  return {
    type: buf.readUInt8(5),
    encoding: buf.readUInt8(6),
    sampleRate: buf.readUInt32LE(8),
    payload: buf.subarray(HEADER_LEN, HEADER_LEN + len),
  };
}

// G.711 mu-law encode of one PCM16 sample.
export function pcm16ToMulawSample(sample) {
  const BIAS = 0x84;
  const CLIP = 32635;
  let s = sample;
  const sign = s < 0 ? 0x80 : 0;
  if (sign) s = -s;
  if (s > CLIP) s = CLIP;
  s += BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (s & mask) === 0 && exponent > 0; exponent--, mask >>= 1);
  const mantissa = (s >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

export function pcm16ToMulaw(pcm) {
  const n = Math.floor(pcm.length / 2);
  const out = Buffer.alloc(n);
  for (let i = 0; i < n; i++) out[i] = pcm16ToMulawSample(pcm.readInt16LE(i * 2));
  return out;
}

export function handleTwilioViaPipecat(ws, req, { WS, env = process.env, log = console } = {}) {
  const url = new URL(req.url, 'http://localhost');
  const callId = url.searchParams.get('callId');
  const sessionId = `call-${callId}`;
  let streamSid = null;
  let callSid = null;
  let seq = 0;
  let upstream = null;
  let ready = false;
  let closed = false;
  const pending = []; // inbound frames received before the service said ready

  const twilioSend = (obj) => {
    if (ws.readyState === 1) ws.send(JSON.stringify(obj));
  };

  const hangupTwilio = async () => {
    const sid = env.TWILIO_ACCOUNT_SID;
    const tok = env.TWILIO_AUTH_TOKEN;
    if (!sid || !tok || !callSid) return;
    try {
      await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Calls/${callSid}.json`, {
        method: 'POST',
        headers: {
          Authorization: 'Basic ' + Buffer.from(`${sid}:${tok}`).toString('base64'),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ Status: 'completed' }),
      });
    } catch { /* non-fatal */ }
  };

  const shutdown = (why) => {
    if (closed) return;
    closed = true;
    log.log?.(`[twilio-bridge ${sessionId}] closing: ${why}`);
    try { upstream?.readyState === 1 && upstream.send(JSON.stringify({ type: 'hangup' })); } catch {}
    try { upstream?.close(); } catch {}
    try { ws.close(); } catch {}
  };

  const connectUpstream = () => {
    const base = env.ASSISTANT_BRIDGE_URL.trim().replace(/\/+$/, '');
    upstream = new WS(base.endsWith('/stream') ? base : `${base}/stream`);
    upstream.on('open', () => {
      upstream.send(JSON.stringify({
        type: 'hello',
        sessionId,
        platform: 'twilio',
        sampleRate: SAMPLE_RATE,
        channels: 1,
        encoding: 'pcm_s16le',
        secret: env.ASSISTANT_BRIDGE_SECRET,
      }));
    });
    upstream.on('message', (data, isBinary) => {
      if (isBinary) {
        const frame = parseFrame(Buffer.from(data));
        if (!frame) return;
        if (frame.type === TYPE_AUDIO_OUT && frame.encoding === ENC_PCM16 && streamSid) {
          twilioSend({ event: 'media', streamSid, media: { payload: pcm16ToMulaw(frame.payload).toString('base64') } });
        } else if (frame.type === TYPE_INTERRUPT && streamSid) {
          twilioSend({ event: 'clear', streamSid });
        }
        return;
      }
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      switch (msg.type) {
        case 'ready':
          ready = true;
          // The Twilio stream only opens after the callee answers.
          upstream.send(JSON.stringify({ type: 'call_active' }));
          for (const f of pending.splice(0)) upstream.send(f);
          break;
        case 'ping': upstream.send(JSON.stringify({ type: 'pong' })); break;
        case 'interrupt': if (streamSid) twilioSend({ event: 'clear', streamSid }); break;
        case 'hangup':
        case 'stopped':
          hangupTwilio().finally(() => shutdown(`service ${msg.type}`));
          break;
        default: break;
      }
    });
    upstream.on('close', () => { hangupTwilio().finally(() => shutdown('service socket closed')); });
    upstream.on('error', (err) => log.error?.(`[twilio-bridge ${sessionId}] upstream error: ${err.message}`));
  };

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.event === 'start') {
      streamSid = msg.start.streamSid;
      callSid = msg.start.callSid || null;
      connectUpstream();
    } else if (msg.event === 'media' && msg.media?.payload) {
      const frame = packFrame({
        type: TYPE_AUDIO_IN,
        encoding: ENC_MULAW,
        sampleRate: SAMPLE_RATE,
        sequence: seq++,
        payload: Buffer.from(msg.media.payload, 'base64'),
      });
      if (ready && upstream?.readyState === 1) upstream.send(frame);
      else if (pending.length < 100) pending.push(frame);
    } else if (msg.event === 'stop') {
      shutdown('twilio stop');
    }
  });
  ws.on('close', () => shutdown('twilio socket closed'));
}
