import { assistantCallIdentity } from './callIdentity.js';
import { briefLines, loadSpeakerProfile, representativeRules, speakerSituation, whereYouAreLine } from './representative.js';
import {
  createInitialEmotionState,
  appraiseTurn,
  formatEmotionStateBlock,
  extractAndStripControlTags,
  shouldEndCall,
} from '../lib/emotionEngine.js';
import {
  retrieveRelevantMemories,
  referencesPriorCall,
} from '../lib/memoryManager.js';
import { maybeGenerateCallSummary } from '../lib/callSession.js';
import { transcribeAudioBuffer, DEFAULT_STT_MODEL } from '../lib/sttClient.js';
import { isSpeechLikePcm16, resolvePatterLlmConfig } from './audioUtils.js';
import { Patter, Twilio, CustomLLM } from 'getpatter';
import { createClient } from '@supabase/supabase-js';

const FISH_API_KEY = process.env.FISH_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
    : null;

// Per-call state keyed by callId
const callState = new Map();

// OpenAI batch transcription for one utterance of PCM16 audio. Named for what
// it replaced (GroqWhisperSTT) only in git history: Groq support is gone —
// see lib/sttClient.js for the verified model ids and endpoint.
export class OpenAIWhisperSTT {
  constructor({ apiKey, sampleRate = 8000, model } = {}) {
    this.apiKey = apiKey;
    this.sampleRate = sampleRate;
    this.model = model;
    this.chunks = [];
    this.callbacks = new Set();
  }

  async connect() {}

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

  async finalize() {
    if (this.chunks.length === 0) return;
    const pcm = Buffer.concat(this.chunks);
    this.chunks = [];

    // Speech gate: Patter hands us audio after its own silence detection, but
    // a fan/generator still produces a "finished utterance" of steady noise.
    // Skip it before it costs an API call or invents a turn.
    if (!isSpeechLikePcm16(pcm, this.sampleRate)) return;

    const wav = wrapPcm16InWav(pcm, this.sampleRate);
    const result = await transcribeAudioBuffer({
      bytes: wav,
      filename: 'chunk.wav',
      mimeType: 'audio/wav',
      model: this.model || process.env.ASSISTANT_STT_MODEL || DEFAULT_STT_MODEL,
      // The relay passes the key at construction (kept for parity with the
      // old class); otherwise fall back to the shared resolver.
      env: this.apiKey ? { ...process.env, OPENAI_API_KEY: this.apiKey } : process.env,
    });
    const text = result.text;
    if (!text) return;
    for (const cb of this.callbacks) {
      await cb({ text, isFinal: true, confidence: 1 });
    }
  }
}

export function wrapPcm16InWav(pcm, sampleRate = 8000, channels = 1, bitsPerSample = 16) {
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

export class FishAudioTelephonyTTS {
  constructor({ apiKey, voiceId } = {}) {
    this.apiKey = apiKey;
    this.defaultVoiceId = voiceId || undefined;
    this.carrier = null;
    this._callVoices = new Map();
    this._currentCallId = null;
  }

  setTelephonyCarrier(carrier) {
    this.carrier = carrier;
  }

  sourceAudioFormat() {
    return { encoding: 'mulaw', sampleRate: 8000 };
  }

  setVoiceForCall(callId, voiceId) {
    if (callId) {
      if (voiceId) this._callVoices.set(callId, voiceId);
      else this._callVoices.delete(callId);
      this._currentCallId = callId;
    }
  }

  clearCall(callId) {
    if (callId) this._callVoices.delete(callId);
    if (this._currentCallId === callId) this._currentCallId = null;
  }

  setVoice(voiceId) {
    this.defaultVoiceId = voiceId || undefined;
  }

  resolveVoiceId(callId) {
    if (callId && this._callVoices.has(callId)) return this._callVoices.get(callId);
    if (this._currentCallId && this._callVoices.has(this._currentCallId)) {
      return this._callVoices.get(this._currentCallId);
    }
    return this.defaultVoiceId;
  }

  async *synthesizeStream(text, opts = {}) {
    const callId = opts?.callId || this._currentCallId;
    if (callId && supabase) {
      const { data: call } = await supabase.from('calls').select('ai_muted').eq('id', callId).maybeSingle();
      if (call?.ai_muted) return;
    }

    const { cleanText } = extractAndStripControlTags(text);
    if (!cleanText) return;

    const voiceId = this.resolveVoiceId(callId);
    const resp = await fetch('https://api.fish.audio/v1/tts', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json', model: 's1' },
      body: JSON.stringify({
        text: cleanText,
        reference_id: voiceId || undefined,
        format: 'mulaw', // 8kHz mulaw, forwarded to Twilio unmodified
      }),
    });
    if (!resp.ok) return;
    yield Buffer.from(await resp.arrayBuffer());
  }
}

const SYSTEM_PROMPT_TEMPLATE = [
  `{situation}`,
  ``,
  `{objective}`,
  `{instructions_line}`,
  `{personality_line}`,
  `{memories_line}`,
  `{emotion_block}`,
  ``,
  `Sound like an actual human on the phone, not a script:`,
  `- Keep turns short — a sentence, maybe two. Real phone conversations are back-and-forth, not monologues.`,
  `- Write the way people actually talk, not the way people write: natural contractions, the occasional "um," "uh," "you know," a thought you start and then correct or trail off, a beat before answering something you're not 100% sure about.`,
  `- Every so often — sparingly — let a small human sound come through using these exact bracket tags: [pause], [short pause], [sigh], [clear throat], [chuckle], [laughing]. One per turn at most, and plenty of turns should have none at all.`,
  `- Never repeat the same phrase twice in a call, and avoid stock lines like "I understand," "Great question."`,
  `{identity_line}`,
  ``,
  `Track whether the objective's been accomplished. Once it has, wrap up naturally.`,
  `When your closing line is the actual end of the call, append the exact text [[END_CALL]] to the very end of that line, with nothing after it. Never append [[END_CALL]] if the other person just asked a question, and never mention it out loud.`,
].join('\n');

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

async function loadCallContext(callId) {
  if (!supabase || !callId) return null;
  const { data: call } = await supabase.from('calls').select('*').eq('id', callId).maybeSingle();
  if (!call) return null;

  const ctx = {
    objective: call.objective || '',
    instructions: '',
    personality: '',
    userId: call.user_id,
    contactId: call.contact_id || null,
    direction: call.direction || 'outbound',
    callKind: call.call_kind || 'contact',
    twilioCallSid: call.twilio_call_sid,
    voiceId: null,
    userName: '',
    userCountry: '',
    memories: [],
    memoryBlock: '',
    emotionState: createInitialEmotionState(),
    greetingOverride: assistantCallIdentity(call.call_kind)?.greeting || '',
  };

  if (ctx.direction === 'inbound') {
    const { data: answering } = await supabase
      .from('call_answering_settings')
      .select('greeting')
      .eq('user_id', call.user_id)
      .maybeSingle();
    ctx.greetingOverride = answering?.greeting || '';
  }

  const { data: voice } = await supabase.from('voice_profiles').select('*').eq('user_id', call.user_id).maybeSingle();
  if (voice?.status === 'ready') ctx.voiceId = voice.provider_voice_id;

  const profile = await loadSpeakerProfile(supabase, call.user_id);
  ctx.userName = profile.name;
  ctx.userCountry = profile.country;

  const memBundle = await retrieveRelevantMemories({
    supabase,
    userId: call.user_id,
    contactId: call.contact_id || null,
    queryText: call.objective || '',
    includeEpisodic: referencesPriorCall(call.objective),
    limit: 8,
  });
  ctx.memories = memBundle.memories.map((m) => m.content);
  ctx.memoryBlock = memBundle.promptBlock;

  if (call.caller_id) {
    const { data: caller } = await supabase.from('ai_callers').select('*').eq('id', call.caller_id).maybeSingle();
    if (caller) {
      ctx.instructions = caller.instructions || '';
      ctx.personality = caller.personality || 'natural';
    }
  }

  return ctx;
}

export function contextToVariables(ctx) {
  // Callback TO the app user: the assistant really is the speaker. Every other
  // call is the person who set it up, speaking as themselves.
  const identity = assistantCallIdentity(ctx.callKind);
  const situation = identity?.situation || `${speakerSituation({ userName: ctx.userName, direction: ctx.direction })}\n${whereYouAreLine(ctx.userCountry)}`;
  const brief = identity ? [] : briefLines({ instructions: ctx.instructions });
  return {
    situation,
    identity_line: identity?.guidance || representativeRules().join('\n'),
    // The label differs by identity: a callback TO the app user has a purpose; every
    // other call has the speaker's own private brief.
    objective: identity ? `What this call is for: ${ctx.objective}` : briefLines({ objective: ctx.objective }).join('\n'),
    instructions_line: identity ? (ctx.instructions ? `How to go about it: ${ctx.instructions}` : '') : brief.join('\n'),
    personality_line: ctx.personality ? `General manner: ${ctx.personality}` : '',
    memories_line: ctx.memoryBlock
      ? ctx.memoryBlock
      : ctx.memories?.length
        ? `Things worth remembering from past conversations: ${ctx.memories.join('; ')}`
        : '',
    emotion_block: formatEmotionStateBlock(ctx.emotionState),
  };
}

async function hangupTwilioCall(twilioCallSid) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!accountSid || !authToken || !twilioCallSid) return;
  try {
    await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls/${twilioCallSid}.json`, {
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

// Persist one turn: transcript always, status promoted to in_progress only
// from pre-connected states (a completed row must never be resurrected by a
// late turn racing the status webhook).
async function persistTurn(callId, transcript) {
  if (!supabase || !callId) return;
  await supabase.from('calls').update({ transcript }).eq('id', callId);
  await supabase
    .from('calls')
    .update({ status: 'in_progress' })
    .eq('id', callId)
    .in('status', ['queued', 'ringing']);
}

async function finalizeCall(callId, ctx, transcript) {
  if (!supabase || !callId) return;
  // Transcript is persisted turn-by-turn by onTranscript; flush once more,
  // then hand off to the SHARED summariser used by every platform
  // (structured summary + durable-memory extraction, idempotent claim).
  // If the call row is not terminal yet (status webhook still in flight),
  // maybeGenerateCallSummary no-ops and api/calls-status.js triggers it
  // when it marks the call completed.
  try {
    await supabase.from('calls').update({ transcript }).eq('id', callId);
  } catch {
    // non-fatal: turns were already written as they arrived
  }
  await maybeGenerateCallSummary(supabase, callId);
}

// Shared, OpenAI-only CustomLLM configuration (was Groq when no Luna key;
// that fallback was removed with the rest of the Groq integration).
export { resolvePatterLlmConfig };

if (process.env.NODE_ENV !== 'test') {
  const phone = new Twilio();
  const patter = new Patter({
    carrier: phone,
    phoneNumber: process.env.TWILIO_FROM_NUMBER,
    webhookUrl: process.env.RENDER_EXTERNAL_URL || 'https://audio-call-relay.onrender.com',
  });

  const ttsAdapter = new FishAudioTelephonyTTS({ apiKey: FISH_API_KEY });
  const agent = patter.agent({
    systemPrompt: SYSTEM_PROMPT_TEMPLATE,
    stt: new OpenAIWhisperSTT({ model: process.env.ASSISTANT_STT_MODEL }),
    llm: new CustomLLM(resolvePatterLlmConfig(process.env)),
    tts: ttsAdapter,
  });

  await patter.serve({
    agent,
    port: Number(process.env.PORT) || 8080,

    onCallStart: async (data) => {
      const callId = data.callId || data.call_id;
      const ctx = await loadCallContext(callId);
      if (!ctx) return;
      callState.set(callId, { ctx, transcript: [], lastCallerText: '' });
      ttsAdapter.setVoiceForCall(callId, ctx.voiceId);
      return {
        variables: contextToVariables(ctx),
        first_message: ctx.greetingOverride || greeting(),
      };
    },

    onTranscript: async (data) => {
      const callId = data.callId || data.call_id;
      const entry = callState.get(callId);
      if (!entry) return;
      const speaker = data.role === 'assistant' ? 'ai' : 'contact';
      const rawText = String(data.text || '').trim();
      if (!rawText) return;

      if (speaker === 'contact') {
        entry.lastCallerText = rawText;
        entry.ctx.emotionState = appraiseTurn(entry.ctx.emotionState, rawText, { isVoiceCall: true });
        entry.transcript.push({ speaker, content: rawText });
        await persistTurn(callId, entry.transcript);
      } else {
        const { endCall, cleanText } = shouldEndCall(rawText, entry.lastCallerText);
        if (cleanText) {
          entry.transcript.push({ speaker, content: cleanText });
          await persistTurn(callId, entry.transcript);
        }
        if (endCall && entry.ctx.twilioCallSid) {
          setTimeout(() => hangupTwilioCall(entry.ctx.twilioCallSid), 1500);
        }
      }
    },

    onCallEnd: async (data) => {
      const callId = data.callId || data.call_id;
      ttsAdapter.clearCall(callId);
      const entry = callState.get(callId);
      if (!entry) return;
      await finalizeCall(callId, entry.ctx, entry.transcript);
      callState.delete(callId);
    },
  });
}
