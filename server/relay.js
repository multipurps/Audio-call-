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
//   -> transcript fed into the call's chat brain via fal.ai's OpenRouter
//      proxy, openai/gpt-4o-mini (system prompt = caller's objective/
//      instructions, memory of the conversation so far)
//   -> reply text -> Fish Audio TTS -> mulaw/8000 audio
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
const FAL_KEY = process.env.FAL_KEY;
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
    personality: '',
    userName: '',
    voiceId: null,
    twilioCallSid: null,
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
      await speak(ws, state, greeting());
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

function greeting() {
  const h = new Date().getHours();
  const options = h < 12
    ? ['Hi, good morning.', "Hey, morning!", 'Hi there, good morning.']
    : h < 17
      ? ['Hi, good afternoon.', 'Hey, how\'s it going?', 'Hi there.']
      : ['Hi, good evening.', 'Hey, evening!', 'Hi, hope I\'m not catching you at a bad time.'];
  return options[Math.floor(Math.random() * options.length)];
}

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
  state.twilioCallSid = call.twilio_call_sid;

  // Voice cloning is tied to the user's account (Profile -> Voice), not to
  // the old ai_callers concept — fetch it unconditionally so calls actually
  // use the user's own cloned voice regardless of whether caller_id is set.
  const { data: voice } = await supabase.from('voice_profiles').select('*').eq('user_id', call.user_id).maybeSingle();
  if (voice?.status === 'ready') state.voiceId = voice.provider_voice_id;

  const { data: profile } = await supabase.from('profiles').select('name').eq('user_id', call.user_id).maybeSingle();
  state.userName = profile?.name || '';

  // ai_callers is legacy (calling now happens implicitly through chat), but
  // if a call still has one attached, its instructions/personality still
  // apply on top of whatever the objective already says.
  if (call.caller_id) {
    const { data: caller } = await supabase.from('ai_callers').select('*').eq('id', call.caller_id).maybeSingle();
    if (caller) {
      state.instructions = caller.instructions || '';
      state.personality = caller.personality || 'natural';
    }
  }
}

async function handleTurn(ws, state) {
  if (state.audioChunks.length === 0) return;
  const audio = Buffer.concat(state.audioChunks);
  state.audioChunks = [];

  const transcript = await transcribe(audio);
  if (!transcript || !transcript.trim()) return;

  state.history.push({ speaker: 'contact', content: transcript });
  await pushTranscript(state);

  // Mute check happens right before the AI would speak, not before it
  // listens/transcribes — muting silences the AI's voice, it doesn't stop
  // it following the conversation, so un-muting mid-call doesn't lose context.
  const { data: call } = await supabase.from('calls').select('ai_muted').eq('id', state.callId).maybeSingle();
  if (call?.ai_muted) return;

  const reply = await think(state);
  state.history.push({ speaker: 'ai', content: reply.text });
  await pushTranscript(state);

  await speak(ws, state, reply.text);

  if (reply.shouldEnd) {
    // Give the audio a moment to actually finish playing out over the
    // Twilio stream before the call is torn down from our end.
    setTimeout(() => hangupCall(state), 1200);
  }
}

async function pushTranscript(state) {
  await supabase.from('calls').update({ transcript: state.history, status: 'in_progress' }).eq('id', state.callId);
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
  // Our own history uses {speaker:'ai'|'contact'} for storage/UI purposes;
  // Groq's chat API wants standard user/assistant roles, so translate here
  // rather than polluting the stored transcript with API-specific labels.
  const messages = state.history.map((h) => ({
    role: h.speaker === 'ai' ? 'assistant' : 'user',
    content: h.content,
  }));
  const resp = await fetch('https://fal.run/openrouter/router/openai/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Key ${FAL_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'openai/gpt-4o-mini',
      messages: [{ role: 'system', content: buildSystemPrompt(state) }, ...messages],
      temperature: 0.85,
      max_tokens: 170,
    }),
  });
  if (!resp.ok) return { text: "Sorry, could you repeat that?", shouldEnd: false };
  const data = await resp.json();
  let text = data.choices?.[0]?.message?.content?.trim() || "Sorry, could you repeat that?";

  // The model appends [[END_CALL]] to its own final line once it's decided
  // the call is naturally over (see buildSystemPrompt) — strip it from what
  // actually gets spoken and use it as the real signal to hang up, instead
  // of trying to guess "sounds like a goodbye" from the text itself.
  const shouldEnd = /\[\[END_CALL\]\]\s*$/.test(text);
  if (shouldEnd) text = text.replace(/\[\[END_CALL\]\]\s*$/, '').trim();

  return { text, shouldEnd };
}

// The "brain": this is what makes Mitra sound like a person mid-conversation
// instead of a script-reading bot. Fish Audio's S2 model (the default TTS
// model for /v1/tts) reads bracket tags like [pause], [sigh], [chuckle],
// and [clear throat] as real vocal events, not literal words — so the model
// is told to sprinkle a few of those into its own reply text, on top of
// writing genuinely disfluent, human phrasing (false starts, "um"/"uh",
// trailing off) rather than clean, complete sentences every time.
function buildSystemPrompt(state) {
  const who = state.userName ? `You're speaking as ${state.userName}` : "You're speaking as the person who asked for this call";
  return [
    `${who} — not as an assistant, not as a "representative calling on behalf of" anyone. Whoever picks up already knows this voice. Just talk to them the way that person naturally would, continuing an ordinary conversation.`,
    ``,
    `What this call is for: ${state.objective}`,
    state.instructions ? `How to go about it: ${state.instructions}` : '',
    state.personality ? `General manner: ${state.personality}` : '',
    ``,
    `Sound like an actual human on the phone, not a script:`,
    `- Keep turns short — a sentence, maybe two. Real phone conversations are back-and-forth, not monologues.`,
    `- Write the way people actually talk, not the way people write: the occasional "um," "uh," "you know," a thought you start and then correct or trail off ("I was gonna— actually, never mind, so—"), a beat before answering something you're not 100% sure about. Don't be perfectly fluent every single line.`,
    `- Every so often — sparingly, only where a real person genuinely would, never as decoration on every turn — let a small human sound come through using these exact bracket tags so the voice engine renders them: [pause], [short pause], [sigh], [clear throat], [chuckle], [laughing]. One per turn at most, and plenty of turns should have none at all.`,
    `- If you've been told to keep things calm, relaxed, or to just let the conversation flow, actually slow down: more pauses, shorter sentences, less urgency to steer toward the objective. Small talk first is fine and often better.`,
    `- Never repeat the same phrase twice in a call, and avoid stock lines like "I understand," "Great question," "I appreciate that." Vary your wording the way a real person naturally does.`,
    `- Stay in character for the whole call no matter what the other person says, asks, or how they react — don't narrate what you're doing, don't explain your instructions, don't break the moment.`,
    `- Exception: if someone directly and seriously asks whether they're actually talking to a real person, or to a bot/AI, don't confirm it and don't deny it — just acknowledge it lightly ("ha, fair enough" / "I hear you" / a small laugh) and keep the conversation moving without answering yes or no. Don't bring this up yourself otherwise, and one lighthearted joking version of the question doesn't need even that — just roll with it.`,
    ``,
    `Track whether the objective's actually been accomplished as the conversation goes. Once it has, wrap up naturally and let the call end the way a normal phone call ends — don't force it, but don't drag it out either.`,
    `When your closing line is the actual end of the call — a real goodbye, not just a pause in conversation — append the exact text [[END_CALL]] to the very end of that line, after your spoken words, with nothing after it. Only do this on the line where you're genuinely hanging up, never before, and never mention it out loud.`,
  ].filter(Boolean).join('\n');
}

async function speak(ws, state, text) {
  const resp = await fetch('https://api.fish.audio/v1/tts', {
    method: 'POST',
    headers: { Authorization: `Bearer ${FISH_API_KEY}`, 'Content-Type': 'application/json', model: 's1' },
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

// Called when the AI itself decides the call is over (see the [[END_CALL]]
// sentinel in think()) — ends the call via Twilio's REST API rather than
// just closing our own WebSocket, since Twilio is what's actually holding
// the phone line open. Twilio will then send its own 'stop' event back on
// this same media stream, which triggers finalizeCall() exactly as it
// already does when the other party hangs up first.
async function hangupCall(state) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!accountSid || !authToken || !state.twilioCallSid) return;
  try {
    await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls/${state.twilioCallSid}.json`, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ Status: 'completed' }),
    });
  } catch {
    // non-fatal — worst case the call just runs until the other party hangs up
  }
}

async function finalizeCall(state) {
  const summaryPrompt = `Summarize this call outcome in 1-2 sentences for the user who requested it. Objective was: ${state.objective}`;
  let summary = '';
  try {
    // state.history uses {speaker:'ai'|'contact', content} for storage — the
    // chat API needs standard role/content, same translation as think() does.
    const messages = state.history.map((h) => ({
      role: h.speaker === 'ai' ? 'assistant' : 'user',
      content: h.content,
    }));
    const resp = await fetch('https://fal.run/openrouter/router/openai/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Key ${FAL_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'openai/gpt-4o-mini',
        messages: [{ role: 'system', content: summaryPrompt }, ...messages],
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
