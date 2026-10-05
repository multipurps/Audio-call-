// Short audio sample of a GPT-Live voice, made by opening a real GPT-Live session with
// audio.output.voice = <voice> and having it say one line. Returns a 24 kHz PCM16 WAV.
// NOTE: written against OpenAI's published GPT-Live event names; tests use a local fake server.
import WebSocket from 'ws';
import { liveVoiceById } from './liveVoices.js';

const SAMPLE_RATE = 24000;
const LINE = "Hi, this is how I'll sound when I call for you.";
const cache = new Map(); // voiceId -> Buffer (per warm instance; the browser caches too)

export function pcmToWav(pcm, rate = SAMPLE_RATE) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

function peak(buf) {
  let m = 0;
  for (let i = 0; i + 1 < buf.length; i += 2) m = Math.max(m, Math.abs(buf.readInt16LE(i)));
  return m;
}

// Speaks `line` in a GPT-Live voice and returns a 24 kHz PCM16 WAV. Used by the preview
// (fixed sample line, cached) and by the in-app Emysa call (any reply, never cached).
export async function liveVoiceSpeak(voiceId, line, { apiKey, url = 'wss://api.openai.com/v1/live/sessions', model = 'gpt-live-1', timeoutMs = 20000, cacheable = false } = {}) {
  const voice = liveVoiceById(voiceId);
  if (!voice) throw Object.assign(new Error('Unknown Live voice'), { statusCode: 400 });
  if (!apiKey) throw Object.assign(new Error('GPT-Live is not configured'), { statusCode: 500 });
  if (cacheable && cache.has(voice.id)) return cache.get(voice.id);

  const chunks = [];
  let heardAt = 0, lastAudible = 0, audibleBytes = 0;
  const wav = await new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${apiKey}` } });
    let silence, finish;
    const done = (err) => {
      clearInterval(silence); clearTimeout(timer); clearInterval(finish);
      try { ws.send(JSON.stringify({ type: 'session.close' })); } catch {}
      setTimeout(() => { try { ws.close(); } catch {} }, 200);
      if (err) return reject(err);
      if (audibleBytes < SAMPLE_RATE) return reject(Object.assign(new Error('GPT-Live returned no audible audio'), { statusCode: 502 }));
      resolve(pcmToWav(Buffer.concat(chunks)));
    };
    const timer = setTimeout(() => done(audibleBytes ? null : Object.assign(new Error('GPT-Live preview timed out'), { statusCode: 504 })), timeoutMs);
    ws.on('error', (e) => done(Object.assign(new Error(`GPT-Live connection failed: ${e.message}`), { statusCode: 502 })));
    ws.on('open', () => ws.send(JSON.stringify({
      type: 'session.start',
      session: { model, instructions: 'You are previewing your voice. Speak naturally and briefly.', audio: { output: { voice: voice.id } } },
    })));
    ws.on('message', (raw) => {
      let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.type === 'session.started') {
        // Input audio must keep flowing (real-time pace) while the session is open.
        silence = setInterval(() => {
          try { ws.send(JSON.stringify({ type: 'session.input_audio.append', audio: Buffer.alloc(SAMPLE_RATE / 25 * 2).toString('base64') })); } catch {}
        }, 40);
        ws.send(JSON.stringify({
          type: 'session.instructions.append', delegation_id: null,
          content: `Immediately say the following exactly and in full, then stop and stay quiet: ${line}`,
        }));
        finish = setInterval(() => {
          if (audibleBytes > SAMPLE_RATE && Date.now() - lastAudible > 1200) done();
        }, 100);
      } else if (msg.type === 'session.output_audio.delta') {
        const pcm = Buffer.from(msg.delta, 'base64');
        if (!heardAt && peak(pcm) < 600) return; // skip leading silence
        heardAt ||= Date.now();
        chunks.push(pcm);
        if (peak(pcm) >= 600) { audibleBytes += pcm.length; lastAudible = Date.now(); }
      } else if (msg.type === 'error') {
        done(Object.assign(new Error(`GPT-Live error: ${msg.error?.message || 'unknown'}`), { statusCode: 502 }));
      }
    });
  });
  if (cacheable) cache.set(voice.id, wav);
  return wav;
}

export function liveVoicePreview(voiceId, opts = {}) {
  return liveVoiceSpeak(voiceId, LINE, { ...opts, cacheable: true });
}
