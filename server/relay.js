import { assistantCallIdentity } from './callIdentity.js';
import {
  createInitialEmotionState,
  appraiseTurn,
  formatEmotionStateBlock,
  shouldEndCall,
} from '../lib/emotionEngine.js';
import { createChatCompletion } from '../lib/llmClient.js';
import {
  retrieveRelevantMemories,
  consolidateAndStoreMemories,
  inferMemoryType,
} from '../lib/memoryManager.js';
import { WebSocketServer } from 'ws';
import { createClient } from '@supabase/supabase-js';

const PORT = process.env.PORT || 8080;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const FISH_API_KEY = process.env.FISH_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
    : null;

if (process.env.NODE_ENV !== 'test') {
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
      emotionState: createInitialEmotionState(),
      memoryBlock: '',
      memories: [],
      history: [], // [{speaker:'ai'|'contact', content}]
      audioChunks: [],
      silenceTimer: null,
    };

    ws.on('message', async (raw) => {
      const msg = JSON.parse(raw.toString());

      if (msg.event === 'start') {
        state.streamSid = msg.start.streamSid;
        await loadCallContext(state);
        const initialGreeting = state.greetingOverride || greeting();
        state.history.push({ speaker: 'ai', content: initialGreeting });
        await pushTranscript(state);
        await speak(ws, state, initialGreeting);
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
}

function greeting() {
  const h = new Date().getHours();
  const options =
    h < 12
      ? ['Hi, good morning.', 'Hey, morning!', 'Hi there, good morning.']
      : h < 17
        ? ['Hi, good afternoon.', "Hey, how's it going?", 'Hi there.']
        : ['Hi, good evening.', 'Hey, evening!', "Hi, hope I'm not catching you at a bad time."];
  return options[Math.floor(Math.random() * options.length)];
}

function resetSilenceTimer(ws, state) {
  clearTimeout(state.silenceTimer);
  state.silenceTimer = setTimeout(() => handleTurn(ws, state), 700);
}

async function loadCallContext(state) {
  if (!supabase || !state.callId) return;
  const { data: call } = await supabase.from('calls').select('*').eq('id', state.callId).maybeSingle();
  if (!call) return;
  state.objective = call.objective;
  state.callKind = call.call_kind || 'contact';
  if (state.callKind === 'emysa') state.greetingOverride = assistantCallIdentity(state.callKind).greeting;
  state.twilioCallSid = call.twilio_call_sid;
  state.userId = call.user_id;
  state.contactId = call.contact_id || null;
  state.direction = call.direction || 'outbound';

  if (state.direction === 'inbound') {
    const { data: answering } = await supabase
      .from('call_answering_settings')
      .select('greeting')
      .eq('user_id', call.user_id)
      .maybeSingle();
    state.greetingOverride = answering?.greeting || '';
  }

  const { data: voice } = await supabase.from('voice_profiles').select('*').eq('user_id', call.user_id).maybeSingle();
  if (voice?.status === 'ready') state.voiceId = voice.provider_voice_id;

  const { data: profile } = await supabase.from('profiles').select('name').eq('user_id', call.user_id).maybeSingle();
  state.userName = profile?.name || '';

  const memBundle = await retrieveRelevantMemories({
    supabase,
    userId: call.user_id,
    contactId: call.contact_id || null,
    queryText: call.objective || '',
    limit: 8,
  });
  state.memories = memBundle.memories.map((m) => m.content);
  state.memoryBlock = memBundle.promptBlock;

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

  const cleanCallerText = transcript.trim();
  state.emotionState = appraiseTurn(state.emotionState, cleanCallerText, { isVoiceCall: true });
  state.history.push({ speaker: 'contact', content: cleanCallerText });
  await pushTranscript(state);

  if (supabase && state.callId) {
    const { data: call } = await supabase.from('calls').select('ai_muted').eq('id', state.callId).maybeSingle();
    if (call?.ai_muted) return;
  }

  const reply = await think(state, cleanCallerText);
  state.history.push({ speaker: 'ai', content: reply.text });
  await pushTranscript(state);

  await speak(ws, state, reply.text);

  if (reply.shouldEnd) {
    setTimeout(() => hangupCall(state), 1400);
  }
}

async function pushTranscript(state) {
  if (!supabase || !state.callId) return;
  await supabase.from('calls').update({ transcript: state.history, status: 'in_progress' }).eq('id', state.callId);
}

async function transcribe(mulawAudio) {
  if (!GROQ_API_KEY || !mulawAudio?.length) return '';
  const wav = mulawToWav(mulawAudio, 8000);
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

async function think(state, latestCallerText = '') {
  const messages = state.history.map((h) => ({
    role: h.speaker === 'ai' ? 'assistant' : 'user',
    content: h.content,
  }));

  const llmResult = await createChatCompletion({
    messages: [{ role: 'system', content: buildSystemPrompt(state) }, ...messages],
    temperature: 0.75,
    max_tokens: 170,
  });

  if (!llmResult.ok) return { text: 'Sorry, could you say that one more time?', shouldEnd: false };
  const rawText = llmResult.data?.choices?.[0]?.message?.content?.trim() || 'Sorry, could you say that one more time?';
  const { endCall, cleanText } = shouldEndCall(rawText, latestCallerText);

  return { text: cleanText || 'Take care, bye!', shouldEnd: endCall };
}

export function buildSystemPrompt(state) {
  const who = state.userName ? `You're speaking as ${state.userName}` : "You're speaking as the person who asked for this call";
  const identity = assistantCallIdentity(state.callKind);
  const situation =
    identity?.situation ||
    (state.direction === 'inbound'
      ? `${who}, answering a call that just came in — not as an assistant, not as a "representative." Whoever's calling already knows this voice. Just talk to them the way that person naturally would.`
      : `${who} — not as an assistant, not as a "representative calling on behalf of" anyone. Whoever picks up already knows this voice. Just talk to them the way that person naturally would, continuing an ordinary conversation.`);
  const emotionXml = formatEmotionStateBlock(state.emotionState);
  return [
    situation,
    ``,
    `What this call is for: ${state.objective}`,
    state.instructions ? `How to go about it: ${state.instructions}` : '',
    state.personality ? `General manner: ${state.personality}` : '',
    state.memoryBlock
      ? state.memoryBlock
      : state.memories?.length
        ? `Things worth remembering from past conversations: ${state.memories.join('; ')}`
        : '',
    emotionXml,
    ``,
    `Sound like an actual human on the phone, not a script:`,
    `- Keep turns short — a sentence, maybe two. Real phone conversations are back-and-forth, not monologues.`,
    `- Write the way people actually talk, not the way people write: natural contractions, the occasional "um," "uh," "you know," or a brief pause.`,
    `- Every so often — sparingly, only where a real person genuinely would — let a small human sound come through using these exact bracket tags so the voice engine renders them: [pause], [short pause], [sigh], [clear throat], [chuckle], [laughing]. One per turn at most, and plenty of turns should have none at all.`,
    `- Never repeat the same phrase twice in a call, and avoid stock lines like "I understand," "Great question," "I appreciate that."`,
    `- Stay in character for the whole call no matter what the other person says, asks, or how they react.`,
    identity?.guidance ||
      `- Exception: if someone directly and seriously asks whether they're actually talking to a real person, or to a bot/AI, don't confirm it and don't deny it — just acknowledge it lightly and keep the conversation moving.`,
    ``,
    `Track whether the objective's actually been accomplished as the conversation goes. Once it has, wrap up naturally and let the call end the way a normal phone call ends.`,
    `When your closing line is the actual end of the call — a real goodbye, not just a pause in conversation — append the exact text [[END_CALL]] to the very end of that line, after your spoken words, with nothing after it. Never append [[END_CALL]] if the other person just asked a question.`,
  ]
    .filter(Boolean)
    .join('\n');
}

async function speak(ws, state, text) {
  if (!FISH_API_KEY || !text) return;
  const { cleanText } = shouldEndCall(text, '');
  if (!cleanText) return;
  const resp = await fetch('https://api.fish.audio/v1/tts', {
    method: 'POST',
    headers: { Authorization: `Bearer ${FISH_API_KEY}`, 'Content-Type': 'application/json', model: 's1' },
    body: JSON.stringify({
      text: cleanText,
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
    ws.send(
      JSON.stringify({
        event: 'media',
        streamSid: state.streamSid,
        media: { payload: frame.toString('base64') },
      })
    );
  }
}

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
    // non-fatal
  }
}

async function finalizeCall(state) {
  if (!supabase || !state.callId) return;
  const prompt = [
    `Summarize this call outcome in 1-2 sentences for the user who requested it. Objective was: ${state.objective}`,
    `Also decide if there are 1-2 specific, concrete facts worth remembering for next time (preferences, details about the person called, or key outcomes).`,
    `Reply with ONLY JSON: {"summary": string, "memory": string|null, "memories": string[]}`,
  ].join('\n');

  let summary = '';
  let extracted = [];
  try {
    const messages = state.history.map((h) => ({
      role: h.speaker === 'ai' ? 'assistant' : 'user',
      content: h.content,
    }));
    const llmResult = await createChatCompletion({
      messages: [{ role: 'system', content: prompt }, ...messages],
      max_tokens: 180,
      temperature: 0.3,
      response_format: { type: 'json_object' },
    });
    if (llmResult.ok) {
      const parsed = JSON.parse(llmResult.data?.choices?.[0]?.message?.content || '{}');
      summary = parsed.summary || '';
      if (parsed.memory) extracted.push(parsed.memory);
      if (Array.isArray(parsed.memories)) extracted.push(...parsed.memories);
    }
  } catch {
    // non-fatal
  }
  if (summary) {
    await supabase.from('calls').update({ outcome_summary: summary, transcript: state.history }).eq('id', state.callId);
  }
  if (extracted.length > 0 && state.userId) {
    await consolidateAndStoreMemories({
      supabase,
      userId: state.userId,
      contactId: state.contactId || null,
      sourceCallId: state.callId,
      candidates: extracted.map((m) => ({
        content: String(m),
        memory_type: inferMemoryType(String(m), state.callId),
      })),
    });
  }
}

// ITU-T G.711 mu-law byte -> 16-bit signed linear PCM sample
const MULAW_BIAS = 0x84;
export function decodeMulawSample(uByte) {
  const u = ~uByte & 0xff;
  const sign = u & 0x80;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;
  let sample = ((mantissa << 3) + MULAW_BIAS) << exponent;
  sample -= MULAW_BIAS;
  return sign ? -sample : sample;
}

/**
 * Decode 8 kHz G.711 mu-law buffer into signed 16-bit little-endian PCM and
 * wrap it in a standard 44-byte RIFF/WAVE header so Whisper STT accepts it.
 */
export function mulawToWav(mulawBuffer, sampleRate = 8000) {
  const input = Buffer.isBuffer(mulawBuffer) ? mulawBuffer : Buffer.from(mulawBuffer || []);
  const pcm = Buffer.alloc(input.length * 2);
  for (let i = 0; i < input.length; i++) {
    pcm.writeInt16LE(decodeMulawSample(input[i]), i * 2);
  }
  const channels = 1;
  const bitsPerSample = 16;
  const dataSize = pcm.length;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM format
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * (bitsPerSample / 8), 28);
  header.writeUInt16LE(channels * (bitsPerSample / 8), 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, pcm]);
}
