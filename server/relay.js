// Audio Call — realtime relay server
//
// Twilio's <Connect><Stream> opens a WebSocket to this process and streams
// the call's audio both ways as base64 mulaw/8000 frames. This has to be a
// long-lived process (not a Vercel serverless function) because the
// connection stays open for the whole call. Deploy this on Render, same as
// the other single-file apps' backends.
//
// Per call this does, in a loop:
//   caller speaks -> buffered -> flushed to Groq Whisper (STT)
//   -> transcript fed into the call's Groq chat brain (system prompt =
//      caller's objective/instructions, memory of the conversation so far)
//   -> Groq's reply text -> Fish Audio TTS -> mulaw/8000 audio
//   -> streamed back to Twilio as 'media' frames
//
// This is the skeleton: the wiring is real and the API calls are correct,
// but buffering thresholds (how much silence = "they're done talking") and
// the call-objective/IVR-navigation logic in buildSystemPrompt() need
// tuning against real calls before this is production-ready.

import { WebSocketServer } from 'ws';
import { createClient } from '@supabase/supabase-js';

const PORT = process.env.PORT || 8080;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const FISH_API_KEY = process.env.FISH_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const wss = new WebSocketServer({ port: PORT });
console.log(`relay listening on :${PORT}`);

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const callId = url.searchParams.get('callId');
  const state = {
    callId,
    streamSid: null,
    objective: '',
    instructions: '',
    voiceId: null,
    history: [], // [{role:'user'|'assistant', content}]
    audioChunks: [],
    silenceTimer: null,
  };

  ws.on('message', async (raw) => {
    const msg = JSON.parse(raw.toString());

    if (msg.event === 'start') {
      state.streamSid = msg.start.streamSid;
      await loadCallContext(state);
      // Open with a natural greeting rather than dumping the objective —
      // matches the "exchange pleasantries first" requirement.
      await speak(ws, state, "Hi, good afternoon.");
      return;
    }

    if (msg.event === 'media') {
      state.audioChunks.push(Buffer.from(msg.media.payload, 'base64'));
      resetSilenceTimer(ws, state);
      return;
    }

    if (msg.event === 'stop') {
      clearTimeout(state.silenceTimer);
      await finalizeCall(state);
      ws.close();
      return;
    }
  });

  ws.on('close', () => clearTimeout(state.silenceTimer));
});

function resetSilenceTimer(ws, state) {
  clearTimeout(state.silenceTimer);
  // ~700ms of no new audio = the other person stopped talking. Tune this
  // against real call recordings; too short cuts people off, too long
  // makes the AI feel slow to respond.
  state.silenceTimer = setTimeout(() => handleTurn(ws, state), 700);
}

async function loadCallContext(state) {
  const { data: call } = await supabase.from('calls').select('*').eq('id', state.callId).maybeSingle();
  if (!call) return;
  state.objective = call.objective;

  if (call.caller_id) {
    const { data: caller } = await supabase.from('ai_callers').select('*').eq('id', call.caller_id).maybeSingle();
    if (caller) {
      state.instructions = caller.instructions || '';
      state.personality = caller.personality || 'natural';
    }
    const { data: voice } = await supabase.from('voice_profiles').select('*').eq('user_id', call.user_id).maybeSingle();
    if (voice?.status === 'ready') state.voiceId = voice.provider_voice_id;
  }
}

async function handleTurn(ws, state) {
  if (state.audioChunks.length === 0) return;
  const audio = Buffer.concat(state.audioChunks);
  state.audioChunks = [];

  const transcript = await transcribe(audio);
  if (!transcript || !transcript.trim()) return;

  state.history.push({ role: 'user', content: transcript });
  const reply = await think(state);
  state.history.push({ role: 'assistant', content: reply });

  await speak(ws, state, reply);
}

async function transcribe(mulawAudio) {
  // Groq Whisper expects a standard audio container, not raw mulaw/8000 —
  // wrap it in a WAV header before sending. Left as a named step so it's
  // obvious where that conversion belongs; see mulawToWav() below.
  const wav = mulawToWav(mulawAudio);
  const form = new FormData();
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'chunk.wav');
  form.append('model', 'whisper-large-v3-turbo');

  const resp = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${GROQ_API_KEY}` },
    body: form,
  });
  if (!resp.ok) return '';
  const data = await resp.json();
  return data.text || '';
}

async function think(state) {
  const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'system', content: buildSystemPrompt(state) }, ...state.history],
      temperature: 0.6,
      max_tokens: 150,
    }),
  });
  if (!resp.ok) return "Sorry, could you repeat that?";
  const data = await resp.json();
  return data.choices?.[0]?.message?.content?.trim() || "Sorry, could you repeat that?";
}

function buildSystemPrompt(state) {
  return [
    `You are a phone-calling assistant making a real call on behalf of a user.`,
    `Objective for this call: ${state.objective}`,
    state.instructions ? `Caller instructions: ${state.instructions}` : '',
    `Speak naturally and briefly, like a real person on the phone — one or two`,
    `sentences per turn. Exchange normal greetings before stating the purpose`,
    `of the call. Never sound like you are reading a script. Track whether the`,
    `objective has been achieved; once it has, wrap up and end the call politely.`,
  ].filter(Boolean).join('\n');
}

async function speak(ws, state, text) {
  const resp = await fetch('https://api.fish.audio/v1/tts', {
    method: 'POST',
    headers: { Authorization: `Bearer ${FISH_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text,
      reference_id: state.voiceId || undefined,
      format: 'mulaw', // 8kHz mulaw so it can be forwarded to Twilio unmodified
    }),
  });
  if (!resp.ok) return;
  const audioBuf = Buffer.from(await resp.arrayBuffer());

  // Twilio expects base64 mulaw in ~20ms (160-byte) frames.
  const frameSize = 160;
  for (let i = 0; i < audioBuf.length; i += frameSize) {
    const frame = audioBuf.subarray(i, i + frameSize);
    ws.send(JSON.stringify({
      event: 'media',
      streamSid: state.streamSid,
      media: { payload: frame.toString('base64') },
    }));
  }
}

async function finalizeCall(state) {
  const summaryPrompt = `Summarize this call outcome in 1-2 sentences for the user who requested it. Objective was: ${state.objective}`;
  let summary = '';
  try {
    const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'system', content: summaryPrompt }, ...state.history],
        max_tokens: 120,
      }),
    });
    const data = await resp.json();
    summary = data.choices?.[0]?.message?.content?.trim() || '';
  } catch {
    // non-fatal — calls-status.js still records duration/status from Twilio
  }
  if (summary) {
    await supabase.from('calls').update({ outcome_summary: summary, transcript: state.history }).eq('id', state.callId);
  }
}

// Placeholder — wire up a real mulaw-to-WAV header writer (or swap Groq
// Whisper for a provider that accepts raw mulaw) before going live.
function mulawToWav(mulawBuffer) {
  return mulawBuffer;
}
