// Audio Call — relay server, Patter edition
//
// Same job as relay.js, different plumbing: Patter (github.com/PatterAI/Patter,
// MIT) owns the Twilio media stream, mulaw<->PCM16 decode, turn-taking/VAD,
// and audio framing. This file only keeps the parts that are actually
// Emysa's: loading call context from Supabase, the system-prompt template,
// and the post-call summary/memory writeback.
//
// Provider mapping vs the old relay.js (kept 1:1 on purpose so nothing about
// cost or voice quality changes just from this migration):
//   STT  -> GroqWhisperSTT (this file)   — same Groq Whisper endpoint as before,
//           but audio arrives already decoded from mulaw to PCM16 by Patter,
//           which fixes the mulawToWav() stub bug in the old relay.
//   LLM  -> CustomLLM                    — points at the same fal.ai OpenRouter
//           proxy + gpt-4o-mini, with fal's non-standard "Key <token>" auth
//           header (fal doesn't use "Bearer") wired via extraHeaders.
//   TTS  -> FishAudioTTS.forTwilio()     — same Fish Audio account/model,
//           pcm@8kHz preset so there's no resample step to get wrong.
//
// NOT changed by this file: turn-taking still isn't "instant" — Groq Whisper
// is a one-shot/batch transcriber, so there's an unavoidable record -> upload
// -> transcribe round trip per turn no matter what triggers it. Patter's own
// VAD (`agent.vad` / EOU detection) replaces the old fixed 700ms timer with
// real speech-end detection, which helps, but the biggest latency win would
// be swapping Groq Whisper for a streaming STT (Deepgram/AssemblyAI/Soniox) —
// left as-is here on purpose, pending that decision.

import { Patter, Twilio, CustomLLM, FishAudioTTS } from 'getpatter';
import { createClient } from '@supabase/supabase-js';

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const FAL_KEY = process.env.FAL_KEY;
const FISH_API_KEY = process.env.FISH_API_KEY; // note: Emysa's own env var name, not Patter's default FISH_AUDIO_API_KEY
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

// ---------------------------------------------------------------------------
// STT: Groq Whisper, wrapped to satisfy Patter's STTAdapter interface
// (connect / sendAudio / onTranscript / close). Patter hands us already-
// decoded PCM16 @ 8kHz for Twilio calls — we just have to buffer it, wrap it
// in a real WAV header (this is the fix for the old mulawToWav() stub), and
// POST it to Groq on each finalize() (Patter calls this when its own VAD
// detects the caller stopped talking, instead of a fixed timer).
// ---------------------------------------------------------------------------
class GroqWhisperSTT {
  constructor({ apiKey, sampleRate = 8000 } = {}) {
    this.apiKey = apiKey;
    this.sampleRate = sampleRate;
    this.chunks = [];
    this.callbacks = new Set();
  }

  async connect() {
    // Stateless HTTP calls — nothing to open ahead of time.
  }

  sendAudio(pcm) {
    this.chunks.push(pcm);
  }

  onTranscript(cb) {
    this.callbacks.add(cb);
  }

  async close() {
    this.chunks = [];
    this.callbacks.clear();
  }

  // Called by Patter when its VAD/EOU logic decides the caller's turn ended.
  async finalize() {
    if (this.chunks.length === 0) return;
    const pcm = Buffer.concat(this.chunks);
    this.chunks = [];

    const wav = wrapPcm16InWav(pcm, this.sampleRate);
    const form = new FormData();
    form.append('file', new Blob([wav], { type: 'audio/wav' }), 'chunk.wav');
    form.append('model', 'whisper-large-v3-turbo');

    let text = '';
    try {
      const resp = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}` },
        body: form,
      });
      if (resp.ok) {
        const data = await resp.json();
        text = data.text || '';
      }
    } catch {
      // non-fatal — an empty transcript just means the agent stays silent this turn
    }

    if (!text.trim()) return;
    for (const cb of this.callbacks) {
      await cb({ text, isFinal: true, confidence: 1 });
    }
  }
}

function wrapPcm16InWav(pcm, sampleRate = 8000, channels = 1, bitsPerSample = 16) {
  const dataSize = pcm.length;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * (bitsPerSample / 8), 28);
  header.writeUInt16LE(channels * (bitsPerSample / 8), 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, pcm]);
}

// ---------------------------------------------------------------------------
// System prompt — same template/voice as the old buildSystemPrompt(state),
// just rewritten with {placeholders} so Patter can fill it in per call via
// onCallStart's `variables` return value (loaded fresh from Supabase there).
// ---------------------------------------------------------------------------
const SYSTEM_PROMPT_TEMPLATE = [
  `{situation}`,
  ``,
  `What this call is for: {objective}`,
  `{instructions_line}`,
  `{personality_line}`,
  `{memories_line}`,
  ``,
  `Sound like an actual human on the phone, not a script:`,
  `- Keep turns short — a sentence, maybe two. Real phone conversations are back-and-forth, not monologues.`,
  `- Write the way people actually talk, not the way people write: the occasional "um," "uh," "you know," a thought you start and then correct or trail off, a beat before answering something you're not 100% sure about.`,
  `- Every so often — sparingly — let a small human sound come through using these exact bracket tags: [pause], [short pause], [sigh], [clear throat], [chuckle], [laughing]. One per turn at most, and plenty of turns should have none at all.`,
  `- Never repeat the same phrase twice in a call, and avoid stock lines like "I understand," "Great question."`,
  `- Stay in character for the whole call no matter what the other person says or asks.`,
  `- If someone directly and seriously asks whether they're talking to a real person or a bot, don't confirm or deny — acknowledge lightly and keep moving.`,
  ``,
  `Track whether the objective's been accomplished. Once it has, wrap up naturally.`,
  `When your closing line is the actual end of the call, append the exact text [[END_CALL]] to the very end of that line, with nothing after it. Never mention it out loud.`,
].join('\n');

function greeting() {
  const h = new Date().getHours();
  const options = h < 12
    ? ['Hi, good morning.', "Hey, morning!", 'Hi there, good morning.']
    : h < 17
      ? ['Hi, good afternoon.', "Hey, how's it going?", 'Hi there.']
      : ['Hi, good evening.', 'Hey, evening!', "Hi, hope I'm not catching you at a bad time."];
  return options[Math.floor(Math.random() * options.length)];
}

// ---------------------------------------------------------------------------
// Per-call context load — identical Supabase reads to the old
// loadCallContext(state), just returning a plain object instead of mutating
// a `state` blob, since Patter's onCallStart wants a return value back.
// ---------------------------------------------------------------------------
async function loadCallContext(callId) {
  const { data: call } = await supabase.from('calls').select('*').eq('id', callId).maybeSingle();
  if (!call) return null;

  const ctx = {
    objective: call.objective || '',
    instructions: '',
    personality: '',
    userId: call.user_id,
    contactId: call.contact_id || null,
    direction: call.direction || 'outbound',
    twilioCallSid: call.twilio_call_sid,
    voiceId: null,
    userName: '',
    memories: [],
    greetingOverride: '',
  };

  if (ctx.direction === 'inbound') {
    const { data: answering } = await supabase.from('call_answering_settings').select('greeting').eq('user_id', call.user_id).maybeSingle();
    ctx.greetingOverride = answering?.greeting || '';
  }

  const { data: voice } = await supabase.from('voice_profiles').select('*').eq('user_id', call.user_id).maybeSingle();
  if (voice?.status === 'ready') ctx.voiceId = voice.provider_voice_id;

  const { data: profile } = await supabase.from('profiles').select('name').eq('user_id', call.user_id).maybeSingle();
  ctx.userName = profile?.name || '';

  const { data: memRows } = await supabase
    .from('memories')
    .select('content, contact_id')
    .eq('user_id', call.user_id)
    .order('created_at', { ascending: false })
    .limit(20);
  const relevant = (memRows || []).filter((m) => !call.contact_id || m.contact_id === call.contact_id || !m.contact_id);
  ctx.memories = relevant.slice(0, 5).map((m) => m.content);

  if (call.caller_id) {
    const { data: caller } = await supabase.from('ai_callers').select('*').eq('id', call.caller_id).maybeSingle();
    if (caller) {
      ctx.instructions = caller.instructions || '';
      ctx.personality = caller.personality || 'natural';
    }
  }

  return ctx;
}

function contextToVariables(ctx) {
  const who = ctx.userName ? `You're speaking as ${ctx.userName}` : "You're speaking as the person who asked for this call";
  const situation = ctx.direction === 'inbound'
    ? `${who}, answering a call that just came in — not as an assistant. Whoever's calling already knows this voice. Just talk to them the way that person naturally would.`
    : `${who} — not as an assistant or someone "calling on behalf of" anyone. Whoever picks up already knows this voice. Just talk to them the way that person naturally would.`;
  return {
    situation,
    objective: ctx.objective,
    instructions_line: ctx.instructions ? `How to go about it: ${ctx.instructions}` : '',
    personality_line: ctx.personality ? `General manner: ${ctx.personality}` : '',
    memories_line: ctx.memories?.length ? `Things worth remembering from past conversations: ${ctx.memories.join('; ')}` : '',
  };
}

// ---------------------------------------------------------------------------
// Post-call summary + memory extraction — same two-field JSON prompt and
// same Supabase writes as the old finalizeCall(state).
// ---------------------------------------------------------------------------
async function finalizeCall(callId, ctx, transcript) {
  const prompt = [
    `Summarize this call outcome in 1-2 sentences for the user who requested it. Objective was: ${ctx.objective}`,
    `Also decide if there's one specific, concrete fact worth remembering for next time. Only include one if it's genuinely reusable later.`,
    `Reply with ONLY JSON: {"summary": string, "memory": string|null}`,
  ].join('\n');

  let summary = '';
  let memory = null;
  try {
    const messages = transcript.map((h) => ({
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
    // non-fatal
  }
  if (summary) {
    await supabase.from('calls').update({ outcome_summary: summary, transcript }).eq('id', callId);
  }
  if (memory && ctx.userId) {
    await supabase.from('memories').insert({
      user_id: ctx.userId,
      contact_id: ctx.contactId || null,
      content: memory,
      source_call_id: callId,
    });
  }
}

// ---------------------------------------------------------------------------
// Wire it together
// ---------------------------------------------------------------------------
const phone = new Twilio(); // reads TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN
const patter = new Patter({ carrier: phone });

// Per-call state Patter doesn't track for us (transcript history, loaded
// context) keyed by callId — same shape as the old `state` blob, just
// scoped to a Map instead of one-per-websocket-closure.
const callState = new Map();

const agent = patter.agent({
  systemPrompt: SYSTEM_PROMPT_TEMPLATE,
  stt: new GroqWhisperSTT({ apiKey: GROQ_API_KEY }),
  llm: new CustomLLM({
    baseUrl: 'https://fal.run/openrouter/router/openai/v1',
    model: 'openai/gpt-4o-mini',
    temperature: 0.85,
    maxTokens: 170,
    // fal.ai uses "Key <token>", not the standard "Bearer <token>" — leave
    // apiKey/apiKeyEnv unset so CustomLLM doesn't overwrite this with Bearer.
    extraHeaders: { Authorization: `Key ${FAL_KEY}` },
  }),
  tts: FishAudioTTS.forTwilio({ apiKey: FISH_API_KEY }),
});

await patter.serve({
  agent,
  port: process.env.PORT || 8080,

  onCallStart: async (data) => {
    // data.callId — confirm this against Patter's actual onCallStart payload
    // once we can test a real call; the old relay read callId from the
    // stream's ?callId= query param instead.
    const callId = data.callId || data.call_id;
    const ctx = await loadCallContext(callId);
    if (!ctx) return;
    callState.set(callId, { ctx, transcript: [] });
    return {
      variables: contextToVariables(ctx),
      first_message: ctx.greetingOverride || greeting(),
      voice: ctx.voiceId || undefined,
    };
  },

  onTranscript: async (data) => {
    const callId = data.callId || data.call_id;
    const entry = callState.get(callId);
    if (!entry) return;
    const speaker = data.role === 'assistant' ? 'ai' : 'contact';
    entry.transcript.push({ speaker, content: data.text });
    await supabase.from('calls').update({ transcript: entry.transcript, status: 'in_progress' }).eq('id', callId);
  },

  onCallEnd: async (data) => {
    const callId = data.callId || data.call_id;
    const entry = callState.get(callId);
    if (!entry) return;
    await finalizeCall(callId, entry.ctx, entry.transcript);
    callState.delete(callId);
  },
});
