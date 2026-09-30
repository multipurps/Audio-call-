import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { database, loadApi, response } from './helpers.mjs';

function authedReq({ method = 'GET', query = {}, body = {}, headers = {} } = {}) {
  return {
    method,
    query,
    body,
    headers: { authorization: 'Bearer test', ...headers },
  };
}

import {
  resolveLlmProviders,
  generateChatCompletion,
  redactSecrets,
} from '../lib/llmClient.js';

import {
  createInitialEmotionState,
  decayEmotionalState,
  appraiseTurn,
  deriveDiscreteEmotions,
  extractAndStripControlTags,
  shouldEndCall,
  formatEmotionStateBlock,
} from '../lib/emotionEngine.js';

import {
  containsSensitiveSecret,
  sanitizeMemoryContent,
  detectUserMemoryOperations,
  consolidateAndStoreMemories,
  retrieveRelevantMemories,
  formatMemoryBlockForPrompt,
  loadEmotionalState,
  saveEmotionalState,
} from '../lib/memoryManager.js';

import {
  mulawToWav,
  decodeMulawSample,
  setVoiceForCall,
  clearCall,
  resolveVoiceId,
  resolvePatterLlmConfig,
} from '../server/audioUtils.js';

test('LLM client defaults to GPT Luna (gpt-6-luna); Groq endpoints are gone', async () => {
  const providers = resolveLlmProviders({
    LLM_PROVIDER: 'luna',
    LUNA_API_KEY: 'sk-luna-test-secret-123456',
    GROQ_API_KEY: 'gsk-groq-fallback-654321',
  });
  assert.equal(providers.length, 1);
  assert.equal(providers[0].provider, 'luna');
  assert.equal(providers[0].model, 'gpt-6-luna');
  assert.ok(!providers.some((p) => p.provider === 'groq'));
  assert.ok(providers.every((p) => p.url.includes('api.openai.com')));

  // A legacy LLM_PROVIDER=groq resolves to the OpenAI primary, never Groq.
  const legacy = resolveLlmProviders({
    LLM_PROVIDER: 'groq',
    LUNA_API_KEY: 'sk-luna-test-secret-123456',
  });
  assert.equal(legacy.length, 1);
  assert.equal(legacy[0].provider, 'luna');

  // Primary failure falls back to the fal OpenRouter proxy when FAL_KEY set.
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    if (calls.length === 1) {
      return { ok: false, status: 503, text: async () => 'Luna temporary overload' };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: 'Hey there, I am right here with you.' } }],
      }),
    };
  };

  const result = await generateChatCompletion({
    messages: [{ role: 'user', content: 'Hello Emysa' }],
    env: {
      LLM_PROVIDER: 'luna',
      LUNA_API_KEY: 'sk-luna-test-secret-123456',
      FAL_KEY: 'fal-test-key-123456',
    },
    fetchImpl: fakeFetch,
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].body.model, 'gpt-6-luna');
  assert.ok(calls[0].url.includes('api.openai.com'));
  assert.equal(calls[1].body.model, 'openai/gpt-4o-mini');
  assert.equal(result.provider, 'fal');
  assert.equal(result.content, 'Hey there, I am right here with you.');

  // No fallback configured: the primary failure is returned as-is.
  // There is no silent Groq retry to hide a broken OpenAI configuration.
  const lone = await generateChatCompletion({
    messages: [{ role: 'user', content: 'Hello Emysa' }],
    env: { LUNA_API_KEY: 'sk-luna-test-secret-123456' },
    fetchImpl: async () => ({ ok: false, status: 500, text: async () => 'boom' }),
  });
  assert.equal(lone.ok, false);
  assert.equal(lone.provider, 'luna');
  assert.ok(!String(lone.provider).includes('groq'));

  const redacted = redactSecrets(
    'Failed with key sk-luna-test-secret-123456',
    ['sk-luna-test-secret-123456'],
  );
  assert.ok(!redacted.includes('sk-luna-test-secret-123456'));
  assert.ok(redacted.includes('[REDACTED]'));
});

test('OpenFeelz emotion engine updates PAD state, decays exponentially, and ruminates on intense stimuli', () => {
  const t0 = Date.parse('2026-09-29T10:00:00Z');
  const initial = createInitialEmotionState(undefined, t0);
  assert.ok(initial.dimensions.pleasure > 0);
  assert.equal(initial.rumination.length, 0);

  // Distressed user turn triggers empathetic appraisal and rumination
  const stressed = appraiseTurn(
    initial,
    'I am so stressed, scared, and overwhelmed right now after a terrible hospital visit.',
    {},
    t0,
  );
  assert.equal(stressed.primaryEmotion, 'empathetic');
  assert.ok(stressed.dimensions.connection > initial.dimensions.connection);
  assert.ok(stressed.rumination.length >= 1);

  // Advance rumination across 4 neutral turns until it clears
  let stepped = stressed;
  for (let i = 0; i < 4; i++) {
    stepped = appraiseTurn(stepped, 'Okay.', {}, t0 + (i + 1) * 1000);
  }
  assert.equal(stepped.rumination.length, 0);

  // Exponential decay over 12 hours moves PAD dimensions back toward baseline
  const decayed = decayEmotionalState(stressed, Date.parse('2026-09-29T22:00:00Z'));
  assert.ok(
    Math.abs(decayed.dimensions.pleasure - initial.dimensions.pleasure) <
      Math.abs(stressed.dimensions.pleasure - initial.dimensions.pleasure),
  );

  const discrete = deriveDiscreteEmotions(decayed.dimensions);
  assert.ok(discrete.primary);
  const block = formatEmotionStateBlock(decayed);
  assert.match(block, /<emotion_state>/);
});

test('Emotion control tags are stripped before TTS and false-positive hangups are blocked', () => {
  const tagged = extractAndStripControlTags('Alright, I have confirmed that for you. Take care, bye! [[MOOD:warm:0.8]] [[END_CALL]]');
  assert.equal(tagged.hasEndCallTag, true);
  assert.equal(tagged.moodTag.emotion, 'warm');
  assert.equal(tagged.cleanText, 'Alright, I have confirmed that for you. Take care, bye!');

  // False-positive guard: caller asked a question -> must NOT end call even if tag or bye appears
  const blockedQuestion = shouldEndCall('Okay, bye! [[END_CALL]]', 'Wait, what time did they say they open tomorrow?');
  assert.equal(blockedQuestion.endCall, false);

  // False-positive guard: caller said "don't hang up"
  const blockedHold = shouldEndCall('Got it, goodbye [[END_CALL]]', "Hold on, don't hang up yet, let me check my calendar");
  assert.equal(blockedHold.endCall, false);

  // Genuine goodbye after completed exchange -> allowed
  const genuine = shouldEndCall('You are all set for 7pm. Have a wonderful evening, goodbye! [[END_CALL]]', 'Thanks so much, bye!');
  assert.equal(genuine.endCall, true);
  assert.ok(!genuine.cleanText.includes('[[END_CALL]]'));
});

test('Letta-inspired 4-tier memory manager scrubs secrets, resolves contradictions, and retrieves relevant memories', async () => {
  assert.equal(containsSensitiveSecret('My OpenAI key is sk-proj-1234567890abcdefghijklmnop'), true);
  assert.equal(containsSensitiveSecret('My password is: superSecret99'), true);
  assert.equal(containsSensitiveSecret('I prefer oat milk lattes in the morning'), false);
  assert.equal(sanitizeMemoryContent('My API key is sk-proj-1234567890abcdefghijklmnop'), null);

  const ops = detectUserMemoryOperations(
    'Please remember that I am allergic to peanuts. Actually, I live in Seattle now.',
  );
  assert.ok(ops.newFacts.length >= 1);
  assert.ok(ops.corrections.length >= 1);

  const db = database({ memories: [], user_emotional_states: [] });
  const r1 = await consolidateAndStoreMemories({
    supabase: db,
    userId: 'user-1',
    candidates: [
      { content: 'User lives in Austin, Texas', memory_type: 'semantic', subject_key: 'user_location' },
    ],
  });
  assert.equal(r1.inserted, 1);

  // Contradicting/correcting location with same subject_key updates existing row instead of duplicating
  const r2 = await consolidateAndStoreMemories({
    supabase: db,
    userId: 'user-1',
    candidates: [
      { content: 'User lives in Seattle, Washington', memory_type: 'semantic', subject_key: 'user_location' },
    ],
  });
  assert.equal(r2.updated, 1);
  assert.equal(db.tables.memories.length, 1);
  assert.match(db.tables.memories[0].content, /Seattle/);

  // Secret is rejected from storage
  const secretAttempt = await consolidateAndStoreMemories({
    supabase: db,
    userId: 'user-1',
    candidates: [{ content: 'My API key is sk-1234567890abcdefghijklmnop', memory_type: 'semantic' }],
  });
  assert.equal(secretAttempt.inserted, 0);
  assert.equal(db.tables.memories.length, 1);

  // Retrieval & formatting
  const retrieved = await retrieveRelevantMemories({
    supabase: db,
    userId: 'user-1',
    queryText: 'Where does the user live?',
  });
  assert.equal(retrieved.memories.length, 1);
  const block = formatMemoryBlockForPrompt(retrieved);
  assert.match(block, /<persistent_memory>/);
  assert.match(block, /Seattle/);

  // Persistent emotional state save & load
  const savedState = await loadEmotionalState({ supabase: db, userId: 'user-1' });
  const updatedState = appraiseTurn(savedState, 'Thank you so much, I really appreciate your help!');
  await saveEmotionalState({ supabase: db, userId: 'user-1', state: updatedState });
  const reloadedState = await loadEmotionalState({ supabase: db, userId: 'user-1' });
  assert.ok(reloadedState.dimensions.pleasure >= savedState.dimensions.pleasure);
});

test('Memories API supports tiered GET, POST with secret protection, PATCH edit, and DELETE clearAll', async () => {
  const db = database({ memories: [] });
  const { default: memoriesHandler } = await loadApi('api/memories.js', db);

  // Create a memory via POST
  const createRes = response();
  await memoriesHandler(authedReq({ method: 'POST', body: { content: 'Always ask for a window table', memoryType: 'semantic' } }), createRes);
  assert.equal(createRes.code, 200);
  assert.equal(createRes.data.inserted, 1);

  // Attempt to save a secret via POST -> 400
  const secretRes = response();
  await memoriesHandler(authedReq({ method: 'POST', body: { content: 'My password is: hunter2password', memoryType: 'semantic' } }), secretRes);
  assert.equal(secretRes.code, 400);

  // List memories + emotionState via GET
  const getRes = response();
  await memoriesHandler(authedReq({ method: 'GET', query: { type: 'semantic' } }), getRes);
  assert.equal(getRes.code, 200);
  assert.equal(getRes.data.memories.length, 1);
  assert.ok(getRes.data.emotionState?.mood?.label);

  // Edit memory via PATCH
  const memId = getRes.data.memories[0].id;
  const patchRes = response();
  await memoriesHandler(authedReq({ method: 'PATCH', body: { id: memId, content: 'Always ask for a quiet patio table' } }), patchRes);
  assert.equal(patchRes.code, 200);
  assert.equal(db.tables.memories[0].content, 'Always ask for a quiet patio table');

  // Clear all memories via DELETE
  const clearRes = response();
  await memoriesHandler(authedReq({ method: 'DELETE', query: { clearAll: 'true' }, body: { clearAll: true } }), clearRes);
  assert.equal(clearRes.code, 200);
  assert.equal(db.tables.memories.length, 0);
});

test('Telegram social calling uses mp-relay /calls, correlates live transcripts, and supports hangup', async () => {
  const db = database({
    telegram_accounts: [{ user_id: 'user-1', status: 'connected', display_name: 'Sam TG' }],
    calls: [],
    social_calls: [],
  });
  const mpCalls = [];
  const fakeFetch = async (url, init = {}) => {
    mpCalls.push({ url, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null });
    if (url.endsWith('/calls') && (init.method || 'GET') === 'POST') {
      const payload = { callId: 'mp-tg-call-42', status: 'ringing' };
      return {
        ok: true,
        status: 200,
        json: async () => payload,
        text: async () => JSON.stringify(payload),
      };
    }
    if (url.endsWith('/calls/mp-tg-call-42') && init.method === 'DELETE') {
      const payload = { ok: true };
      return {
        ok: true,
        status: 200,
        json: async () => payload,
        text: async () => JSON.stringify(payload),
      };
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  const { default: socialHandler } = await loadApi('api/social-calling.js', db, fakeFetch, {
    MP_RELAY_URL: 'https://mp-relay.example.test',
    MP_RELAY_INTERNAL_SECRET: 'mp-secret',
    SOCIAL_RELAY_INTERNAL_SECRET: 'social-secret',
  });

  // 1. Place Telegram call via api/social-calling?action=call
  const placeRes = response();
  await socialHandler(
    authedReq({
      method: 'POST',
      query: { action: 'call' },
      body: { platform: 'telegram', toNumber: '+14155552671', contactName: 'Alex', objective: 'Check dinner time' },
    }),
    placeRes,
  );
  assert.equal(placeRes.code, 200);
  assert.equal(placeRes.data.platformCallId, 'mp-tg-call-42');
  assert.equal(db.tables.calls.length, 1);
  assert.equal(db.tables.calls[0].platform, 'telegram');
  assert.equal(mpCalls[0].url, 'https://mp-relay.example.test/calls');

  // 2. Relay sends live transcript Entry while call is in-progress
  const callId = placeRes.data.callId;
  const liveRes = response();
  await socialHandler(
    authedReq({
      method: 'POST',
      query: { action: 'relay-call-status' },
      headers: { 'x-relay-secret': 'mp-secret' },
      body: {
        callId,
        status: 'in-progress',
        transcriptEntry: { speaker: 'ai', content: 'Hi Alex, checking on dinner tonight!' },
      },
    }),
    liveRes,
  );
  assert.equal(liveRes.code, 200);
  assert.equal(db.tables.calls[0].status, 'in_progress');
  assert.equal(db.tables.calls[0].transcript.length, 1);
  assert.equal(db.tables.calls[0].transcript[0].content, 'Hi Alex, checking on dinner tonight!');

  // 3. Hangup Telegram call via api/calls?action=hangup
  const { default: callsHandler } = await loadApi('api/calls.js', db, fakeFetch, {
    MP_RELAY_URL: 'https://mp-relay.example.test',
    MP_RELAY_INTERNAL_SECRET: 'mp-secret',
  });
  const hangupRes = response();
  await callsHandler(authedReq({ method: 'POST', query: { action: 'hangup' }, body: { callId } }), hangupRes);
  assert.equal(hangupRes.code, 200);
  assert.equal(db.tables.calls[0].status, 'completed');
  assert.ok(mpCalls.some((c) => c.url.endsWith('/calls/mp-tg-call-42') && c.method === 'DELETE'));
});

test('Relay mulawToWav produces valid 44-byte RIFF/WAVE PCM16 header and Patter relay isolates voices per call', () => {
  const mulawSilenceAndTone = Buffer.from([0xff, 0x7f, 0x00, 0x80, 0x55, 0xd5]);
  const wav = mulawToWav(mulawSilenceAndTone);
  assert.equal(wav.length, 44 + mulawSilenceAndTone.length * 2);
  assert.equal(wav.subarray(0, 4).toString('ascii'), 'RIFF');
  assert.equal(wav.subarray(8, 12).toString('ascii'), 'WAVE');
  assert.equal(wav.subarray(12, 16).toString('ascii'), 'fmt ');
  assert.equal(wav.subarray(36, 40).toString('ascii'), 'data');
  assert.equal(wav.readUInt16LE(20), 1); // PCM format = 1
  assert.equal(wav.readUInt16LE(22), 1); // Mono = 1 channel
  assert.equal(wav.readUInt32LE(24), 8000); // 8000 Hz
  assert.equal(wav.readUInt16LE(34), 16); // 16-bit samples
  assert.equal(decodeMulawSample(0xff), 0);
  assert.notEqual(decodeMulawSample(0x00), 0);

  // Per-call voice isolation in server/patter-relay.js
  setVoiceForCall('call-A', 'voice-alice');
  setVoiceForCall('call-B', 'voice-bob');
  assert.equal(resolveVoiceId({ callId: 'call-A' }, 'default-voice'), 'voice-alice');
  assert.equal(resolveVoiceId({ callId: 'call-B' }, 'voice-default'), 'voice-bob');
  clearCall('call-A');
  assert.equal(resolveVoiceId({ callId: 'call-A' }, 'default-voice'), 'default-voice');
  clearCall('call-B');

  const patterCfg = resolvePatterLlmConfig({ LUNA_API_KEY: 'sk-luna', LLM_MODEL: 'gpt-6-luna' });
  assert.equal(patterCfg.provider, 'openai');
  assert.equal(patterCfg.model, 'gpt-6-luna');
});

test('Frontend app.js has no XSS innerHTML interpolations for transcript or avatar URLs and Vercel function count <= 12', async () => {
  const appJs = await readFile('app.js', 'utf8');
  // Transcript rendering must use textContent, never innerHTML with line.content
  assert.ok(!appJs.includes('<div class="transcriptBubble">${line.content}</div>'));
  assert.ok(!appJs.includes('<div class="transcriptBubble">${content}</div>'));
  assert.ok(!appJs.includes('el.innerHTML = `<img src="${url}"'));
  assert.ok(appJs.includes('createSafeAvatarImg'));
  assert.ok(appJs.includes('bubble.textContent ='));

  // Verify SQL migration order-independence
  const sql006 = await readFile('sql/006_chat_sessions.sql', 'utf8');
  const sql016 = await readFile('sql/016_memory_and_emotion.sql', 'utf8');
  assert.match(sql006, /information_schema\.tables/);
  assert.match(sql016, /create table if not exists user_emotional_states/i);

  // Verify Vercel Hobby plan 12-function cap
  const apiFiles = (await readdir('api')).filter((f) => f.endsWith('.js'));
  assert.ok(apiFiles.length <= 12, `Expected <= 12 Vercel functions, found ${apiFiles.length}`);
});
