// Audio Call — realtime relay server
//
// Twilio's <Connect><Stream> opens a WebSocket to this process and streams
// the call's audio both ways as base64 mulaw/8000 frames. This has to be a
// long-lived process (not a Vercel serverless function) because the
// connection stays open for the whole call. Deploy this on Render, same as
// the other single-file apps' backends.
//
// A call runs in one of two modes (calls.call_mode, switchable mid-call from
// the app's call screen). Everything below describes AI mode, which is the
// original and unchanged behaviour:
//
// Per call this does, in a loop:
//   caller speaks -> buffered -> flushed to Groq Whisper (STT)
//   -> transcript fed into the call's chat brain via fal.ai's OpenRouter
//      proxy, openai/gpt-4o-mini (system prompt = caller's objective/
//      instructions, memory of the conversation so far)
//   -> reply text -> Fish Audio TTS -> mulaw/8000 audio
//   -> streamed back to Twilio as 'media' frames
//
// Direct Caller Mode (calls.call_mode = 'direct') replaces the loop above
// with a straight pipe and none of its steps:
//
//   user's mic (browser) -> w-okada/RVC voice conversion -> mulaw -> Twilio
//   caller                -> Twilio -> mulaw decode      -> browser speaker
//
// No STT, no LLM, no TTS, no transcript. The browser's microphone socket
// lands on /direct and is joined to this call's Twilio socket by
// server/directBridge.js; the conversion itself is server/voiceChanger.js.
// See server/AUDIO-PATH.md for the audio path this replaced and where the
// single outgoing track actually is.
//
// This is the skeleton: the wiring is real and the API calls are correct,
// but buffering thresholds (how much silence = "they're done talking") and
// the call-objective/IVR-navigation logic in buildSystemPrompt() need
// tuning against real calls before this is production-ready.

import http from 'node:http';
import { WebSocketServer } from 'ws';
import { createClient } from '@supabase/supabase-js';
import * as bridge from './directBridge.js';

const PORT = process.env.PORT || 8080;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const FAL_KEY = process.env.FAL_KEY;
const FISH_API_KEY = process.env.FISH_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

// Two different clients connect to this process:
//   * Twilio's media stream, on whatever path RELAY_WS_URL points at
//     (api/calls-twiml.js builds `?callId=…` onto it) — the AI call audio.
//   * the browser's microphone, on /direct — Direct Caller Mode.
// Both are `ws`, so the upgrades are routed by pathname here rather than
// giving the second client its own port. Any path that isn't /direct keeps
// the original behaviour, so an existing RELAY_WS_URL still works unchanged.
const httpServer = http.createServer(bridge.handleHttp);
const twilioWss = new WebSocketServer({ noServer: true });
const directWss = new WebSocketServer({ noServer: true });

httpServer.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (pathname === '/direct') {
    directWss.handleUpgrade(req, socket, head, (ws) => directWss.emit('connection', ws, req));
    return;
  }
  twilioWss.handleUpgrade(req, socket, head, (ws) => twilioWss.emit('connection', ws, req));
});

httpServer.listen(PORT, () => console.log(`relay listening on :${PORT}`));

// Browser microphone sockets. Auth is a short-lived HMAC ticket minted by
// api/calls.js?action=directBridge — without it, anyone who learned a callId
// could inject audio into a live call.
directWss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  bridge.attachBrowser(ws, {
    callId: url.searchParams.get('callId'),
    userId: url.searchParams.get('userId'),
    exp: url.searchParams.get('exp'),
    token: url.searchParams.get('token'),
  });
});

twilioWss.on('connection', (ws, req) => {
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
    userId: null,
    callMode: 'ai', // 'ai' | 'direct' — see server/directBridge.js
    vcEnabled: true,
    vcModelSlot: null,
  };

  ws.on('message', async (raw) => {
    const msg = JSON.parse(raw.toString());

    if (msg.event === 'start') {
      state.streamSid = msg.start?.streamSid || msg.streamSid;
      try {
        await loadCallContextWithTimeout(state);
      } catch (err) {
        // Existing deployments should have Supabase available; this guard is
        // here so a transient metadata read failure doesn't kill the media
        // WebSocket and leave the far end on a silent line. Defaults preserve
        // the original AI mode, and Direct Mode can still be entered from the
        // browser socket because the bridge matches by callId.
        console.error(`relay: could not load call context for ${state.callId}:`, err.message);
      }
      // Register with the direct-call bridge before deciding whether to
      // greet: in Direct Caller Mode there is no Emysa on this call, so a
      // greeting would be the AI talking over the person who just picked up.
      attachDirectBridge(ws, state);
      if (state.callMode === 'direct') return;
      // Open with a natural greeting rather than dumping the objective —
      // matches the "exchange pleasantries first" requirement.
      await speak(ws, state, state.greetingOverride || greeting());
      return;
    }

    if (msg.event === 'media') {
      const callerAudio = Buffer.from(msg.media.payload, 'base64');
      // Direct Caller Mode: the caller's audio goes to the user's ear, not
      // to Whisper. Nothing below this line runs — no STT, no LLM, no TTS.
      if (state.callMode === 'direct') {
        bridge.onCallerAudio(state.callId, callerAudio);
        return;
      }
      state.audioChunks.push(callerAudio);
      resetSilenceTimer(ws, state);
      return;
    }

    if (msg.event === 'stop') {
      clearTimeout(state.silenceTimer);
      bridge.detachTwilio(state.callId);
      // A direct call has no transcript to summarise and no objective the AI
      // was working on — running finalizeCall() on one would ask the model to
      // summarise an empty conversation and overwrite the record with noise.
      if (state.callMode !== 'direct') await finalizeCall(state);
      ws.close();
      return;
    }
  });

  ws.on('close', () => {
    clearTimeout(state.silenceTimer);
    bridge.detachTwilio(state.callId);
  });
});

// Wires this call's Twilio socket into the direct-call bridge. The two
// callbacks are how Direct Caller Mode reaches back into the rest of the
// process without the bridge importing the relay:
//   * sendToTwilio is the same media-frame writer speak() uses, so converted
//     microphone audio and AI speech go out on one identical code path.
//   * onModeChange persists a mid-call mode flip and, when falling back to
//     AI, notes it in the transcript the user is already watching.
function attachDirectBridge(ws, state) {
  bridge.attachTwilio({
    callId: state.callId,
    userId: state.userId,
    ws,
    streamSid: state.streamSid,
    mode: state.callMode,
    vcEnabled: state.vcEnabled,
    modelSlot: state.vcModelSlot,
    sendToTwilio: (mulawBuffer) => sendMulaw(ws, state, mulawBuffer),
    onModeChange: async (mode, note) => {
      // The in-memory switch happens first and unconditionally. The Supabase
      // write is bookkeeping (it's what a later reconnect reads) and must not
      // be able to take the call down: this callback is invoked without an
      // await from the bridge, so a rejection here would surface as an
      // unhandled rejection and kill the whole relay process.
      state.callMode = mode;
      state.audioChunks = [];
      clearTimeout(state.silenceTimer);
      try {
        const patch = { call_mode: mode };
        if (note) {
          state.history.push({ speaker: 'ai', content: note });
          patch.transcript = state.history;
        }
        await supabase.from('calls').update(patch).eq('id', state.callId);
      } catch (err) {
        console.error(`relay: could not persist call_mode for ${state.callId}:`, err.message);
      }
      // Coming back from direct mode with buffered audio from before the
      // switch would feed stale caller speech into Whisper, which is why the
      // two resets above run before the await rather than after it.
    },
  });
}

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

async function loadCallContextWithTimeout(state) {
  const timeoutMs = Number(process.env.CALL_CONTEXT_TIMEOUT_MS || 1500);
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`call context timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([loadCallContext(state), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function loadCallContext(state) {
  const { data: call } = await supabase.from('calls').select('*').eq('id', state.callId).maybeSingle();
  if (!call) return;
  state.objective = call.objective;
  state.twilioCallSid = call.twilio_call_sid;
  state.userId = call.user_id;
  state.contactId = call.contact_id || null;
  state.direction = call.direction || 'outbound';

  // Direct Caller Mode (sql/013_direct_mode.sql): the call is handed to the
  // user's own microphone instead of the AI. Falls back to 'ai' for any call
  // row written before the column existed, so existing calls behave exactly
  // as they did.
  state.callMode = call.call_mode === 'direct' ? 'direct' : 'ai';
  state.vcEnabled = call.vc_enabled !== false;
  state.vcModelSlot = call.vc_model_slot ?? null;

  if (state.direction === 'inbound') {
    const { data: answering } = await supabase.from('call_answering_settings').select('greeting').eq('user_id', call.user_id).maybeSingle();
    state.greetingOverride = answering?.greeting || '';
  }

  // Voice cloning is tied to the user's account (Profile -> Voice), not to
  // the old ai_callers concept — fetch it unconditionally so calls actually
  // use the user's own cloned voice regardless of whether caller_id is set.
  const { data: voice } = await supabase.from('voice_profiles').select('*').eq('user_id', call.user_id).maybeSingle();
  if (voice?.status === 'ready') state.voiceId = voice.provider_voice_id;

  const { data: profile } = await supabase.from('profiles').select('name, vc_model_slot').eq('user_id', call.user_id).maybeSingle();
  state.userName = profile?.name || '';
  // No voice picked for this specific call -> use the account's default.
  if (state.vcModelSlot == null && profile?.vc_model_slot != null) state.vcModelSlot = profile.vc_model_slot;

  // Recent memories (Profile -> Memories) — contact-specific ones first,
  // since those are the most likely to actually be relevant to this call.
  const { data: memRows } = await supabase
    .from('memories')
    .select('content, contact_id')
    .eq('user_id', call.user_id)
    .order('created_at', { ascending: false })
    .limit(20);
  const relevant = (memRows || []).filter((m) => !call.contact_id || m.contact_id === call.contact_id || !m.contact_id);
  state.memories = relevant.slice(0, 5).map((m) => m.content);

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
  // The mode can flip to Direct Caller Mode at any moment, including while a
  // turn is in flight — the STT/LLM awaits below span seconds. Bail out at
  // the top and again right before speaking so a mid-turn switch can't have
  // the AI answer over the top of the user talking to the caller.
  if (state.callMode === 'direct') return;
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

  if (state.callMode === 'direct') return; // switched mid-turn — see the guard at the top
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
  const situation = state.direction === 'inbound'
    ? `${who}, answering a call that just came in — not as an assistant, not as a "representative." Whoever's calling already knows this voice. Just talk to them the way that person naturally would.`
    : `${who} — not as an assistant, not as a "representative calling on behalf of" anyone. Whoever picks up already knows this voice. Just talk to them the way that person naturally would, continuing an ordinary conversation.`;
  return [
    situation,
    ``,
    `What this call is for: ${state.objective}`,
    state.instructions ? `How to go about it: ${state.instructions}` : '',
    state.personality ? `General manner: ${state.personality}` : '',
    state.memories?.length ? `Things worth remembering from past conversations: ${state.memories.join('; ')}` : '',
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
  sendMulaw(ws, state, audioBuf);
}

// The single writer for everything the person on the other end of the line
// hears. Was inlined in speak() until Direct Caller Mode needed to put
// converted microphone audio out on the exact same wire — both now frame and
// send through here, so there is one definition of "audio leaving this call"
// (base64 mulaw, ~20 ms / 160-byte frames, as Twilio Media Streams expects).
function sendMulaw(ws, state, mulawBuffer) {
  if (!mulawBuffer || mulawBuffer.length === 0) return;
  const frameSize = 160;
  for (let i = 0; i < mulawBuffer.length; i += frameSize) {
    const frame = mulawBuffer.subarray(i, i + frameSize);
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
  const prompt = [
    `Summarize this call outcome in 1-2 sentences for the user who requested it. Objective was: ${state.objective}`,
    `Also decide if there's one specific, concrete fact worth remembering for next time — a preference, a detail about the person called, a recurring circumstance. Only include one if it's genuinely reusable later; most calls won't have one, and a restatement of the summary doesn't count.`,
    `Reply with ONLY JSON: {"summary": string, "memory": string|null}`,
  ].join('\n');

  let summary = '';
  let memory = null;
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
        messages: [{ role: 'system', content: prompt }, ...messages],
        max_tokens: 150,
        response_format: { type: 'json_object' },
      }),
    });
    const data = await resp.json();
    const parsed = JSON.parse(data.choices?.[0]?.message?.content || '{}');
    summary = parsed.summary || '';
    memory = parsed.memory || null;
  } catch {
    // non-fatal — calls-status.js still records duration/status from Twilio
  }
  if (summary) {
    await supabase.from('calls').update({ outcome_summary: summary, transcript: state.history }).eq('id', state.callId);
  }
  if (memory && state.userId) {
    await supabase.from('memories').insert({
      user_id: state.userId,
      contact_id: state.contactId || null,
      content: memory,
      source_call_id: state.callId,
    });
  }
}

// Placeholder — wire up a real mulaw-to-WAV header writer (or swap Groq
// Whisper for a provider that accepts raw mulaw) before going live.
function mulawToWav(mulawBuffer) {
  return mulawBuffer;
}
