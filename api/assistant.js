import { LANGUAGE_NAMES } from '../lib/callLanguages.js';
// Languages the transcription model accepts as a pinned language. Igbo is not
// one of them, so it is left to auto-detect.
const STT_LANGUAGES = new Set(['en', 'es', 'fr', 'pt', 'de', 'ha', 'yo', 'sw', 'ar', 'hi', 'zh']);
import { prepareCall, saveCallPlan, confirmCallPlan, attachCallPlans } from '../lib/callPlans.js';
import { formatEmotionStateBlock, extractAndStripControlTags, shouldEndCall, toFishTtsText } from '../lib/emotionEngine.js';
import { createChatCompletion, hasConfiguredLlm } from '../lib/llmClient.js';
import { prepareTurnContext, consolidateAndStoreMemories, inferMemoryType } from '../lib/memoryManager.js';
import { getServiceClient, getAuthedUserId } from '../lib/supabaseAdmin.js';
import { wacallsPlaceAICall } from '../lib/wacallsClient.js';
import { mpRelayRequest } from '../lib/mpRelayClient.js';
import { endCallRow, isEndCallRequest, LIVE_CALL_STATUSES } from '../lib/callHangup.js';
import { sendCallNote } from '../lib/callNote.js';
import { createCallRecord, markCallPlaced, markCallFailed, findDuplicateActiveCall } from '../lib/callSession.js';
import { transcribeAudioBuffer, resolveSttApiKey } from '../lib/sttClient.js';



// Home-screen "talk to the assistant" chat. Separate from the live in-call
// relay (server/relay.js) — this is the request/response layer where the
// user tells Emysa what they want done, Emysa decides whether that means
// placing a call to a saved contact, and the actual call outcome (busy, no
// answer, completed) gets posted back into the same thread later by the
// Twilio status webhook (see api/calls-status.js).
//
// Conversations are organized into chat_sessions ("Saved Chats") so the
// user can keep separate named threads instead of one endless conversation.
//
// Intent parsing (action=send) and voice-input transcription
// (action=transcribe) both use OpenAI: GPT Luna (`gpt-6-luna`) for the
// conversation, `gpt-4o-mini-transcribe` on /v1/audio/transcriptions for
// speech. Groq was removed entirely — the model this app used there was
// decommissioned, and no path may silently fall back to it.
export default async function handler(req, res) {
  const supabase = getServiceClient();
  const userId = await getAuthedUserId(req, supabase);
  if (!userId) return res.status(401).json({ error: 'Not signed in' });

  const action = req.query?.action || req.body?.action;
  switch (action) {
    case 'sessions': return listSessions(req, res, supabase, userId);
    case 'archiveSession': return archiveSession(req, res, supabase, userId);
    case 'messages': return listMessages(req, res, supabase, userId);
    case 'cancelCall': {
      if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
      if (!req.body?.sessionId) return res.status(400).json({ error: 'sessionId required' });
      const { error } = await supabase.from('call_plans').update({ status: 'cancelled' }).eq('user_id', userId).eq('session_id', req.body.sessionId).eq('status', 'pending');
      return res.status(error ? 500 : 200).json(error ? { error: error.message } : { ok: true });
    }
    case 'prepareCall': return prepareCall(req, res, supabase, userId);
    case 'confirmCall': return confirmCallPlan(req, res, supabase, userId);
    case 'send': return sendMessage(req, res, supabase, userId);
    case 'sendImage': return sendImage(req, res, supabase, userId);
    case 'transcribe': return transcribeAudio(req, res, supabase, userId);
    case 'speak': return speakText(req, res, supabase, userId);
    case 'logCallSummary': return logCallSummary(req, res, supabase, userId);
    case 'summarizeCall': return summarizeCall(req, res, supabase, userId);
    case 'deleteSession': return deleteSession(req, res, supabase, userId);
    case 'savePushSubscription': return savePushSubscription(req, res, supabase, userId);
    default: return res.status(400).json({ error: 'Unknown or missing action' });
  }
}

// Folded in from the old api/save-push-subscription.js — small enough not
// to warrant its own function slot (Vercel Hobby caps a deployment at 12).
async function savePushSubscription(req, res, supabase, userId) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const { subscription } = req.body || {};
  if (!subscription?.endpoint || !subscription?.keys) return res.status(400).json({ error: 'Invalid subscription' });

  const { error } = await supabase.from('push_subscriptions').upsert(
    {
      user_id: userId,
      endpoint: subscription.endpoint,
      p256dh: subscription.keys.p256dh,
      auth: subscription.keys.auth,
    },
    { onConflict: 'endpoint' }
  );
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ ok: true });
}


// Synthesizes a short line of text through Fish Audio so the in-app "call"
// with Emysa is an actual voice back-and-forth, not text you have to read —
// used for the assistant's own replies on the call screen, independent of
// whether voice *input* (transcription) is working, so a Groq outage
// doesn't also silence output that has nothing to do with Groq.
async function speakText(req, res, supabase, userId) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const fishKey = process.env.FISH_API_KEY;
  if (!fishKey) return res.status(500).json({ error: 'Voice output not configured (missing FISH_API_KEY)' });

  const { text } = req.body || {};
  if (typeof text !== 'string' || !text.trim() || text.length > 4000) return res.status(400).json({ error: 'Text required (maximum 4000 characters)' });

  // This HTTP path speaks Fish model s1, whose vocalisation tags are the
  // (paren) set. Emysa's canonical markers ([laughing] etc.) are translated
  // to the model's REAL audio tags so laughs/sighs/throat-clears are heard,
  // internal [[...]] control tags are stripped, and unknown tags are dropped
  // rather than read out loud. Verified against Fish's emotion-control docs.
  const spokenText = toFishTtsText(text, { model: 's1' }).trim().slice(0, 600);
  if (!spokenText) return res.status(400).json({ error: 'Text required' });

  const { data: voice } = await supabase.from('voice_profiles').select('*').eq('user_id', userId).maybeSingle();
  const referenceId = voice?.status === 'ready' ? voice.provider_voice_id : undefined;

  try {
    const resp = await fetch('https://api.fish.audio/v1/tts', {
      method: 'POST',
      headers: { Authorization: `Bearer ${fishKey}`, 'Content-Type': 'application/json', model: 's1' },
      body: JSON.stringify({
        text: spokenText, reference_id: referenceId, format: 'mp3',
        // Fish defaults (speed 1, 0 dB) came out rushed and loud on the call.
        prosody: { speed: Number(process.env.FISH_TTS_SPEED) || 0.92, volume: Number.isFinite(Number(process.env.FISH_TTS_VOLUME)) && process.env.FISH_TTS_VOLUME ? Number(process.env.FISH_TTS_VOLUME) : -3 },
      }),
    });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => '');
      console.error(`speakText: Fish Audio TTS rejected the request (status ${resp.status}):`, detail.slice(0, 500));
      return res.status(502).json({ error: 'Speech generation failed', detail: detail.slice(0, 300) });
    }
    const audioBuf = Buffer.from(await resp.arrayBuffer());
    return res.status(200).json({ audioBase64: audioBuf.toString('base64'), mimeType: 'audio/mpeg' });
  } catch (err) {
    console.error('speakText: request to Fish Audio threw:', err);
    return res.status(500).json({ error: 'Speech generation failed', detail: String(err?.message || err).slice(0, 300) });
  }
}

async function listSessions(req, res, supabase, userId) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
  const archived = req.query?.archived === 'true';
  let query = supabase.from('chat_sessions').select('id,title,created_at,updated_at,archived')
    .eq('user_id', userId).eq('archived', archived);
  let relatedCalls = [];
  let plans = [];
  if (req.query?.callRelated === 'true') {
    const [callsResult, plansResult] = await Promise.all([
      supabase.from('calls').select('id,session_id,to_number,contact_id,created_at').eq('user_id', userId).not('session_id', 'is', null).order('created_at', { ascending: false }).limit(1000),
      supabase.from('call_plans').select('session_id,label,created_at').eq('user_id', userId).order('created_at', { ascending: false }).limit(1000),
    ]);
    if (callsResult.error || plansResult.error) return res.status(500).json({ error: 'Could not load call conversations' });
    relatedCalls = callsResult.data || [];
    plans = plansResult.data || [];
    const ids = [...new Set([...relatedCalls, ...plans].map((r) => r.session_id))];
    if (!ids.length) return res.status(200).json({ sessions: [] });
    query = query.in('id', ids);
  }
  const { data, error } = await query.order('updated_at', { ascending: false }).limit(100);
  if (error) return res.status(500).json({ error: error.message });
  const sessions = (data || []).map((session) => ({ ...session,
    call_label: plans.find((p) => p.session_id === session.id)?.label || relatedCalls.find((c) => c.session_id === session.id)?.to_number || null,
    call_id: relatedCalls.find((c) => c.session_id === session.id)?.id || null,
  }));
  return res.status(200).json({ sessions });
}

async function archiveSession(req, res, supabase, userId) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const { sessionId, archived } = req.body || {};
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
  const { error } = await supabase.from('chat_sessions').update({ archived: !!archived }).eq('id', sessionId).eq('user_id', userId);
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ ok: true });
}

async function deleteSession(req, res, supabase, userId) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const { sessionId } = req.body || {};
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
  const { error } = await supabase.from('chat_sessions').delete().eq('id', sessionId).eq('user_id', userId);
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ ok: true });
}

// Users who were chatting before "Saved Chats" existed have messages with no
// session_id. Fold them into a single session on first read after upgrade,
// titled from their first message, so nothing they already said disappears.
async function resolveDefaultSession(supabase, userId) {
  const { data: mostRecent } = await supabase
    .from('chat_sessions')
    .select('id')
    .eq('user_id', userId)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (mostRecent) return mostRecent.id;

  const { data: orphans } = await supabase
    .from('assistant_messages')
    .select('id,role,content,created_at')
    .eq('user_id', userId)
    .is('session_id', null)
    .order('created_at', { ascending: true });
  if (!orphans?.length) return null;

  const firstUserMsg = orphans.find((m) => m.role === 'user');
  const title = titleFromText(firstUserMsg?.content) || 'Saved chat';
  const { data: session, error } = await supabase
    .from('chat_sessions')
    .insert({ user_id: userId, title, updated_at: orphans[orphans.length - 1].created_at })
    .select()
    .single();
  if (error) throw new Error(error.message);

  await supabase.from('assistant_messages').update({ session_id: session.id }).in('id', orphans.map((m) => m.id));
  return session.id;
}

function titleFromText(text) {
  if (!text) return null;
  const words = text.trim().split(/\s+/).slice(0, 6).join(' ');
  const capped = words.length > 42 ? words.slice(0, 42).trimEnd() + '…' : words;
  return capped.charAt(0).toUpperCase() + capped.slice(1);
}

async function listMessages(req, res, supabase, userId) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
  let sessionId = req.query?.sessionId || null;
  if (!sessionId) {
    try {
      sessionId = await resolveDefaultSession(supabase, userId);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }
  if (!sessionId) return res.status(200).json({ messages: [], sessionId: null });

  const { data, error } = await supabase
    .from('assistant_messages')
    .select('*')
    .eq('user_id', userId)
    .eq('session_id', sessionId)
    .neq('source', 'call')
    .order('created_at', { ascending: true })
    .limit(200);
  if (error) return res.status(500).json({ error: error.message });
  try {
    return res.status(200).json({ messages: await attachCallPlans(supabase, userId, sessionId, data), sessionId });
  } catch (err) {
    return res.status(500).json({ error: 'Could not load call plans. Check that the call-plans migration has been applied.' });
  }
}

async function insertMessage(supabase, userId, sessionId, role, content, callId = null, source = 'text') {
  const { data, error } = await supabase
    .from('assistant_messages')
    .insert({ user_id: userId, session_id: sessionId, role, content, call_id: callId, source })
    .select()
    .single();
  if (error) throw new Error(error.message);
  await supabase.from('chat_sessions').update({ updated_at: new Date().toISOString() }).eq('id', sessionId);
  return data;
}

// Handles a photo sent from the call screen's "More" menu (Camera/Photos).
// Goes through the same LLM client as text turns: GPT Luna (`gpt-6-luna`,
// text+image input, verified in OpenAI's model catalog) with the optional
// fal OpenRouter fallback — no separate vision provider.
async function sendImage(req, res, supabase, userId) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const { imageBase64, mimeType, caption, sessionId: incomingSessionId, source } = req.body || {};
  if (!imageBase64) return res.status(400).json({ error: 'imageBase64 required' });
  const msgSource = source === 'call' ? 'call' : 'text';
  if (!hasConfiguredLlm(process.env)) return res.status(500).json({ error: 'Vision not configured (missing LLM API key)' });

  let sessionId = incomingSessionId || null;
  if (sessionId) {
    const { data: owned } = await supabase.from('chat_sessions').select('id').eq('id', sessionId).eq('user_id', userId).maybeSingle();
    if (!owned) return res.status(404).json({ error: 'Chat not found' });
  }
  let isNewSession = false;
  if (!sessionId) {
    const { data: session, error } = await supabase
      .from('chat_sessions')
      .insert({ user_id: userId, title: 'Photo', archived: msgSource === 'call' })
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });
    sessionId = session.id;
    isNewSession = true;
  }

  const newMessages = [];
  newMessages.push(await insertMessage(supabase, userId, sessionId, 'user', caption?.trim() || '📷 Sent a photo', null, msgSource));

  const dataUrl = `data:${mimeType || 'image/jpeg'};base64,${imageBase64}`;
  let reply = "Sorry, I couldn't look at that just now.";
  try {
    const llmResult = await createChatCompletion({
      messages: [
        {
          role: 'system',
          content:
            "You are Emysa, a warm, observant, and natural voice companion. The user just shared a photo with you. Respond to what's actually in it naturally and conversationally, in 1-3 sentences, as if speaking out loud to a close friend.",
        },
        {
          role: 'user',
          content: [
            { type: 'text', text: caption?.trim() || "Here's a photo." },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
        },
      ],
      temperature: 0.5,
      max_tokens: 160,
    });
    if (!llmResult.ok) {
      console.error(`sendImage: vision request rejected (status ${llmResult.status}):`, llmResult.errorText);
    } else {
      const rawReply = llmResult.data?.choices?.[0]?.message?.content?.trim();
      if (rawReply) reply = extractAndStripControlTags(rawReply).cleanText || reply;
    }
  } catch (err) {
    console.error('sendImage: vision request threw:', err);
  }

  newMessages.push(await insertMessage(supabase, userId, sessionId, 'assistant', reply, null, msgSource));
  return res.status(200).json({ messages: newMessages, sessionId, isNewSession });
}

async function sendMessage(req, res, supabase, userId) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const { text, callerId, sessionId: incomingSessionId, source, channel, target } = req.body || {};
  if (typeof text !== 'string' || !text.trim() || text.length > 4000) return res.status(400).json({ error: 'Text required (maximum 4000 characters)' });
  // Which line to call out on — 'phone' (Twilio), or 'whatsapp'/'telegram'
  // (the user's linked personal account). Selected from the dropdown under
  // the Home header's call-channel button and sent explicitly with every
  // message. There is deliberately NO default here: a missing/unknown
  // channel used to silently mean Twilio, which is how a WhatsApp/Telegram
  // request could end up as a phone call. Twilio is only ever used when the
  // client says 'phone'.
  const uiChannel = ['phone', 'whatsapp', 'telegram'].includes(channel) ? channel : null;
  // 'call' = a live voice turn on the call screen — kept out of the home
  // chat list (which is meant to read as "what I typed / what got decided",
  // not a transcript of speaking out loud), but still written to
  // assistant_messages so the model still has real conversation context.
  const msgSource = source === 'call' ? 'call' : 'text';

  let sessionId = incomingSessionId || null;
  if (sessionId) {
    const { data: owned } = await supabase.from('chat_sessions').select('id').eq('id', sessionId).eq('user_id', userId).maybeSingle();
    if (!owned) return res.status(404).json({ error: 'Chat not found' });
  }
  let isNewSession = false;
  if (!sessionId) {
    const { data: session, error } = await supabase
      .from('chat_sessions')
      .insert({ user_id: userId, title: titleFromText(text) || 'New chat', archived: msgSource === 'call' }) // voice calls with Emysa must not pile up in Recent
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });
    sessionId = session.id;
    isNewSession = true;
  }

  const userMsg = await insertMessage(supabase, userId, sessionId, 'user', text.trim(), null, msgSource);
  const newMessages = [userMsg];
  const respond = (extra = {}) => res.status(200).json({ messages: newMessages, sessionId, isNewSession, ...extra });

  // "End the call" typed/spoken in chat ends THIS conversation's live call.
  // Scoped by the chat session id, never by "the most recent call overall",
  // so it can't hang up a different person's call (same rule as retries).
  if (isEndCallRequest(text)) {
    const { data: liveCall } = await supabase.from('calls').select('*')
      .eq('user_id', userId).eq('session_id', sessionId).in('status', LIVE_CALL_STATUSES)
      .order('created_at', { ascending: false }).limit(1).maybeSingle();
    let replyText;
    if (!liveCall) {
      replyText = "There's no active call in this chat right now.";
    } else {
      let who = liveCall.to_number || 'them';
      if (liveCall.contact_id) {
        const { data: c } = await supabase.from('contacts').select('name').eq('id', liveCall.contact_id).eq('user_id', userId).maybeSingle();
        if (c?.name) who = c.name;
      }
      const result = await endCallRow(supabase, userId, liveCall);
      replyText = result.ok
        ? (result.alreadyEnded ? `The call with ${who} had already ended.` : `Ended the call with ${who}.`)
        : `I couldn't end the call with ${who}: ${result.error}. Use the End button on the call screen.`;
    }
    newMessages.push(await insertMessage(supabase, userId, sessionId, 'assistant', replyText, liveCall?.id || null, msgSource));
    return respond();
  }

  // While a call from THIS chat is live, a typed message is a note for Emysa
  // (new info to pass along). Scoped by chat session like "end the call".
  // Dial requests are left alone so "call Sam" still places a call.
  if (msgSource !== 'call' && !/^\s*(call|dial|ring|phone)\b/i.test(text)) {
    const { data: noteCall } = await supabase.from('calls').select('*')
      .eq('user_id', userId).eq('session_id', sessionId).in('status', LIVE_CALL_STATUSES)
      .order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (noteCall) {
      const result = await sendCallNote(noteCall, text.trim());
      const replyText = result.ok
        ? "Passed to Emysa. She'll work it in when the moment's right."
        : `I couldn't pass that to Emysa: ${result.error}.`;
      newMessages.push(await insertMessage(supabase, userId, sessionId, 'assistant', replyText, noteCall.id, msgSource));
      return respond();
    }
  }

  if (!hasConfiguredLlm(process.env)) {
    newMessages.push(await insertMessage(supabase, userId, sessionId, 'assistant', "I'm not fully set up yet — the assistant's API key hasn't been added on the server.", null, msgSource));
    return respond();
  }

  const [{ data: contacts }, { data: history }, turnContext] = await Promise.all([
    supabase.from('contacts').select('id,name,phone_number').eq('user_id', userId),
    supabase
      .from('assistant_messages')
      .select('role,content')
      .eq('user_id', userId)
      .eq('session_id', sessionId)
      .order('created_at', { ascending: false })
      .limit(20),
    prepareTurnContext({
      supabase,
      userId,
      userText: text.trim(),
      isVoiceCall: msgSource === 'call',
    }),
  ]);
  const recentHistory = (history || []).reverse();
  const { emotionState, memoryBundle, commitTurn } = turnContext;

  const { data: langProfile } = await supabase.from('profiles').select('language').eq('user_id', userId).maybeSingle();
  const userLanguage = LANGUAGE_NAMES[langProfile?.language] || 'English';
  const contactsList = (contacts || []).map((c) => `- ${c.name}`).join('\n') || '(no contacts saved yet)';
  const emotionBlock = formatEmotionStateBlock(emotionState);
  const systemPrompt = [
    'You are Emysa — a warm, emotionally observant, witty, and grounded personal companion and calling assistant.',
    `LANGUAGE: always reply in ${userLanguage}, the language chosen in Settings. If the user's text looks like another language it is most likely a speech-to-text mistake: do not switch languages, answer in ${userLanguage} or ask them to repeat. Only change language if they explicitly ask you to.`,
    'The user can chat with you naturally about anything, or tell you who to call and what to say so you can place the call for them.',
    'Known contacts:',
    contactsList,
    memoryBundle.promptBlock ? `\n${memoryBundle.promptBlock}` : '',
    `\n${emotionBlock}`,
    '',
    'HUMAN PERSONALITY & CONVERSATION STYLE:',
    '- Speak like a perceptive, caring human friend — never a scripted corporate bot. Use natural contractions and rhythm.',
    '- Adapt to the user\'s emotional state: be gentle and unhurried if they are stressed or sad, playful when they are joking, and crisp when they are in a hurry.',
    '- Avoid repeating stock phrases like "How can I assist you today?" or "I understand your frustration."',
    '- VOCAL EXPRESSION: when your reply is spoken aloud you may include occasional, contextual vocalisation markers — [laughing], [chuckling], [giggling], [sighing], [clearing throat], [gasping], [humming], and tone markers [soft], [whispering], [emphasis]. They become real sounds in your voice. A genuinely funny joke may earn [chuckling] before you answer; an awkward moment may fit [giggling]; a thinking pause may fit [sighing] or just "Hmm.". Serious, sad or business moments stay serious — never force laughter. Keep these occasional (several minutes apart at most), varied, and never use one instead of actually answering.',
    msgSource === 'call'
      ? '- Never start a reply with "Hey", "Hi" or "Hello" except the very first greeting of the call; vary how you open and just answer. Speak calmly, never rushed. Talk like a real person on the phone, not an assistant: react first ("Oh wow.", "Ha, no way.", "Mm, yeah."), keep most turns to about 5 to 15 words, use contractions and the occasional natural filler, ask at most one follow-up and not every turn, never repeat their words back, and vary your reactions. Never say "How can I help", "Is there anything else", "I understand", "Certainly", "Absolutely", "I would be happy to" or "Great question". You are currently speaking out loud on a live voice call with the user. Keep "reply" concise (1-2 spoken sentences), natural for TTS, with no markdown or bullet lists. If the user says goodbye or asks to end/hang up the call, include [[END_CALL]] at the very end of "reply".'
      : '',
    '',
    "About the app, for when the user asks (answer naturally and conversationally in \"reply\" — don't deflect these to a phone-number prompt): this app lets you tell Emysa (you) who to call and what to say, then Emysa places a real phone, WhatsApp, or Telegram call and carries the conversation. You can call any phone number or a saved contact, ask for the same person again with something like \"call him again\", and Emysa remembers context from past conversations and calls.",
    '',
    'Reply with ONLY a JSON object, no other text, matching this shape:',
    '{"action":"call"|"retry"|"reply","phoneNumber":string|null,"contactName":string|null,"objective":string|null,"channel":"phone"|"whatsapp"|"telegram"|null,"reply":string|null,"mood":string|null}',
    '- action "call": the user wants you to call someone new. If they gave you an actual phone number in their message, put the digits (with country code if given, e.g. "+15551234567") in phoneNumber. Otherwise, if they named someone from the saved contacts list, put your best guess at that name in contactName. objective is a short phrase describing what to say or ask on the call — if they also gave any tone or manner direction (stay calm, keep it light, let it flow naturally, be quick about it, etc.), include that in objective too, don\'t drop it. If they explicitly named which line to call on in this message (e.g. "on WhatsApp", "call him on Telegram", "use my phone line"), put that in channel - phone/whatsapp/telegram. If they did not name a line in THIS message, leave channel null; do not guess or reuse a line from earlier in the conversation, since the app\'s own line selector already carries that forward and takes over whenever this is null.',
    '- action "retry": the user wants you to call the same person again (e.g. "call him again", "try it again").',
    '- action "reply": anything else — general conversation, emotional support, questions about you or the app, small talk, or a call request with no number/contact given yet. Answer naturally, warmly, and helpfully in "reply". Only ask for a phone number or contact name if they\'ve actually expressed intent to make a call but haven\'t said who.',
    'Every single response, with no exceptions, must be that one JSON object and nothing else - never plain conversational text, never text before or after the JSON, even for casual chat or small talk. Put the conversational reply itself inside the "reply" field.',
  ].filter(Boolean).join('\n');

  const chatMessages = [
    { role: 'system', content: systemPrompt },
    ...recentHistory.map((h) => ({ role: h.role === 'assistant' ? 'assistant' : 'user', content: h.content })),
  ];

  let intent;
  try {
    const llmResult = await createChatCompletion({
      messages: chatMessages,
      temperature: 0.35,
      max_tokens: 280,
      response_format: { type: 'json_object' },
    });
    if (!llmResult.ok) throw new Error(llmResult.rawErrorText || llmResult.errorText || 'LLM request failed');
    const rawContent = llmResult.data?.choices?.[0]?.message?.content || '{}';
    try {
      intent = JSON.parse(rawContent);
    } catch {
      // If the provider returned plain text despite json_object mode, wrap it cleanly
      const jsonMatch = rawContent.match(/\{[\s\S]*\}/);
      intent = jsonMatch ? JSON.parse(jsonMatch[0]) : { action: 'reply', reply: rawContent.trim() };
    }
  } catch (err) {
    // Strict JSON-mode validators sometimes reject a perfectly good
    // conversational reply just because the model didn't wrap it in our
    // schema - but the actual text it tried to say is right there in the
    // error payload's failed_generation field. Use it instead of throwing
    // away a working reply and showing a generic failure.
    let recovered = null;
    try {
      const parsed = JSON.parse(err.message);
      const text = parsed?.error?.failed_generation;
      if (text && typeof text === 'string') recovered = text.trim();
    } catch {
      // err.message wasn't JSON (a network error, etc.) - nothing to recover.
    }
    if (recovered) {
      intent = { action: 'reply', reply: recovered };
    } else {
      console.error('assistant intent parse failed:', err);
      const detail = String(err?.message || err).slice(0, 220);
      newMessages.push(await insertMessage(supabase, userId, sessionId, 'assistant', `Sorry, I couldn't process that right now. (${detail})`, null, msgSource));
      return respond();
    }
  }

  // A platform named explicitly in this message (e.g. "call him on
  // WhatsApp") wins over the sticky line picker in the UI - naming it IS
  // choosing it, and should not be silently overridden by whatever the
  // button happened to be left on.
  // Explicit contact actions cannot be redirected by model output.
  if (target) {
    if (!['whatsapp', 'telegram'].includes(uiChannel)) return res.status(400).json({ error: 'Use the pre-call flow for Phone' });
    const contact = (contacts || []).find((c) => c.id === target.contactId);
    if (!contact) return res.status(404).json({ error: 'Contact not found' });
    intent = { action: 'call', contactName: contact.name, phoneNumber: null, objective: text.trim(), channel: uiChannel };
  }
  const callChannel = (['phone', 'whatsapp', 'telegram'].includes(intent.channel) ? intent.channel : null) || uiChannel;

  if (intent.action === 'call' || intent.action === 'retry') {
    let contact = null;
    let retryToNumber = null;
    let retryObjective = null;

    if (!callChannel) {
      // Never guess a line. Twilio placing a real phone call when the user
      // meant WhatsApp/Telegram is worse than asking.
      newMessages.push(await insertMessage(supabase, userId, sessionId, 'assistant', 'Which line should I call on — Phone, WhatsApp or Telegram? Pick one from the call button and tell me again.', null, msgSource));
      return respond();
    }

    if (intent.action === 'retry') {
      // Retry resolves against THIS conversation's own call history — never
      // the user's global "most recent call". The bug this replaces:
      // WhatsApp/Telegram retries looked up the last `social_calls` row for
      // the user, so after calling B from B's chat, "call him again" in A's
      // chat dialled B. A conversation that already identifies a contact
      // must never be redirected by another conversation's history, and a
      // conversation with nobody identifiable must ask, not guess.
      const { data: sessionCalls } = await supabase
        .from('calls')
        .select('contact_id,to_number,objective,platform,created_at')
        .eq('user_id', userId)
        .eq('session_id', sessionId)
        .order('created_at', { ascending: false })
        .limit(10);
      const priorCalls = sessionCalls || [];
      // The call to repeat: this conversation's most recent call on the
      // chosen line; failing that, its most recent call on any line (the
      // person is a property of the conversation, the line is not).
      const lastCall = callChannel
        ? priorCalls.find((c) => c.platform === callChannel) || null
        : priorCalls[0] || null;
      const identityRow = lastCall || priorCalls[0] || null;
      if (identityRow?.contact_id) {
        const { data: c } = await supabase.from('contacts').select('*').eq('id', identityRow.contact_id).maybeSingle();
        contact = c;
      }
      retryToNumber = identityRow?.to_number || null;
      retryObjective = lastCall?.objective || identityRow?.objective || null;

      if (!retryToNumber) {
        // A phone call prepared through the plan flow is this conversation's
        // only trace of who to call.
        const { data: plans } = await supabase
          .from('call_plans')
          .select('to_number,contact_id,objective')
          .eq('user_id', userId)
          .eq('session_id', sessionId)
          .order('created_at', { ascending: false })
          .limit(1);
        const plan = plans?.[0] || null;
        if (plan?.contact_id && !contact) {
          const { data: c } = await supabase.from('contacts').select('*').eq('id', plan.contact_id).maybeSingle();
          contact = c;
        }
        retryToNumber = plan?.to_number || null;
        retryObjective = plan?.objective || retryObjective;
      }
      if (!retryToNumber && contact?.phone_number) {
        retryToNumber = contact.phone_number;
      }
    } else if (target?.contactId) {
      contact = (contacts || []).find((c) => c.id === target.contactId);
    } else if (!intent.phoneNumber) {
      const name = (intent.contactName || '').trim().toLowerCase();
      if (name) {
        const exact = (contacts || []).filter((c) => c.name.toLowerCase() === name);
        const partial = (contacts || []).filter((c) => c.name.toLowerCase().includes(name) || name.includes(c.name.toLowerCase()));
        const matches = exact.length ? exact : partial;
        if (matches.length === 1) {
          contact = matches[0];
        } else if (matches.length > 1) {
          // Ambiguous — ask instead of guessing which one to dial.
          const list = matches.map((c) => c.name).join(', ');
          newMessages.push(await insertMessage(supabase, userId, sessionId, 'assistant', `I've got a few contacts named like that — ${list}. Who do you mean?`, null, msgSource));
          return respond();
        }
      }
    }

    const toNumber = intent.phoneNumber || contact?.phone_number || retryToNumber || null;
    const label = contact?.name || intent.phoneNumber || retryToNumber;

    if (!toNumber) {
      const msg =
        intent.action === 'retry'
          ? "I'm not sure who to call again yet — tell me who you'd like me to call."
          : "What number should I call? You can give me a phone number, or a name from your saved contacts.";
      newMessages.push(await insertMessage(supabase, userId, sessionId, 'assistant', msg, null, msgSource));
      return respond();
    }

    if (callChannel === 'phone' && !intent.objective && !retryObjective) {
      newMessages.push(await insertMessage(supabase, userId, sessionId, 'assistant', `What would you like me to say to ${label}? Send your instructions and I'll prepare a summary before you tap Call Now.`, null, msgSource));
      return respond();
    }
    let objective = intent.objective || (intent.action === 'retry' ? retryObjective : null) || 'Say hello and share what the user wants to talk about.';
    const { data: langProfile } = await supabase.from('profiles').select('language').eq('user_id', userId).maybeSingle();
    if (langProfile?.language && langProfile.language !== 'en') {
      const langName = LANGUAGE_NAMES[langProfile.language] || langProfile.language;
      objective = `Speak only in ${langName} for this entire call, regardless of what language this instruction is written in. ${objective}`;
    }

    if (callChannel === 'whatsapp' || callChannel === 'telegram') {
      const channelName = callChannel === 'whatsapp' ? 'WhatsApp' : 'Telegram';
      // Fail fast, before the relay round-trip: WhatsApp/Telegram calls only
      // resolve to a real account with a full international number — no way
      // to guess a country code for a bare local-format number.
      const digitsOnly = toNumber.replace(/[\s()-]/g, '');
      if (!/^\+[1-9]\d{7,14}$/.test(digitsOnly)) {
        const who = contact?.name ? `${contact.name}'s saved number (${toNumber})` : `That number (${toNumber})`;
        newMessages.push(await insertMessage(supabase, userId, sessionId, 'assistant', `${who} needs a country code to call on ${channelName} — e.g. +2349038226059. Update the contact or give me the full number.`, null, msgSource));
        return respond();
      }
      // Social calls get their own row in `calls` (not just social_calls) so
      // they use the SAME header-spinner / call-screen UI Twilio calls
      // already get - the frontend only needs a callId + toNumber to open
      // it (see openCallFromMessage/trackActiveCall in app.js), and doesn't
      // care which platform placed the call.
      //
      // The row is created BEFORE dialing (status 'queued') so the assistant
      // pipeline can resolve it the instant the provider connects, and the
      // user's own instructions are preserved verbatim for that pipeline.
      const createSocialRow = async () => {
        await supabase.from('social_calls').insert({ user_id: userId, platform: callChannel, peer_identifier: digitsOnly, status: 'queued' })
          .then(({ error }) => { if (error) console.error('social_calls insert failed:', error.message); });
        // Throws on failure — a call we cannot track must not be dialled.
        return createCallRecord(supabase, userId, {
          platform: callChannel,
          toNumber: digitsOnly,
          objective,
          instructions: text.trim(),
          contactId: contact?.id || null,
          sessionId,
        });
      };
      const markSocialRowFailed = async (callRow) => {
        if (!callRow) return;
        await markCallFailed(supabase, callRow.id);
        await supabase.from('social_calls')
          .update({ status: 'failed' })
          .eq('user_id', userId)
          .eq('platform', callChannel)
          .eq('peer_identifier', digitsOnly)
          .eq('status', 'queued');
      };
      const verb = intent.action === 'retry' ? 'again now' : 'now';

      // A second press while the first attempt is still ringing must not
      // dial again — surface the live call instead.
      const duplicate = await findDuplicateActiveCall(supabase, userId, callChannel, digitsOnly);
      if (duplicate) {
        newMessages.push(await insertMessage(supabase, userId, sessionId, 'assistant', `I'm already calling ${label} on ${channelName}.`, duplicate.id, msgSource));
        return respond({ channelUsed: callChannel, callId: duplicate.id, toNumber: digitsOnly, contactName: contact?.name || null });
      }

      const callRow = await createSocialRow();
      try {
        let platformCallId = null;
        if (callChannel === 'whatsapp') {
          const { data: waRow } = await supabase.from('whatsapp_accounts').select('wacalls_session_id').eq('user_id', userId).maybeSingle();
          if (!waRow?.wacalls_session_id) throw new Error('WhatsApp is not connected — link it in Profile first.');
          // Places the call and connects the assistant to it. A call that
          // rings with no assistant behind it is a failure, not a success:
          // this throws (after hanging up) so the user is told the truth.
          const placed = await wacallsPlaceAICall(userId, waRow.wacalls_session_id, digitsOnly, {
            appSessionId: sessionId, contactName: contact?.name || null,
            // Persist the provider id BEFORE the assistant bridge dials in.
            onCallStarted: async ({ callId }) => {
              platformCallId = callId;
              await markCallPlaced(supabase, callRow.id, { platformCallId: callId });
            },
          });
          platformCallId = placed.callId;
        } else {
          // Telegram goes through mp-relay (MadelineProto), never through
          // the old relay's fake-DH stub and never through Twilio. If the
          // deployed mp-relay has no call route yet, say exactly that.
          const { data: tgRow } = await supabase.from('telegram_accounts').select('status').eq('user_id', userId).maybeSingle();
          if (tgRow?.status !== 'connected') throw new Error('Telegram is not connected — link it in Profile first.');
          try {
            const result = await mpRelayRequest('/calls', { method: 'POST', body: { userId, to: digitsOnly, sessionId, contactName: contact?.name || null } });
            platformCallId = result?.callId || null;
            await markCallPlaced(supabase, callRow.id, { platformCallId });
          } catch (err) {
            if (err.statusCode === 404) throw new Error("the Telegram call service (mp-relay) doesn't have call support deployed yet.");
            if (err.statusCode === 401) {
              // mp-relay confirmed the account's auth key is dead (logged
              // out / revoked, not just a network blip) - clear the cached
              // "connected" row so the Connected Accounts screen stops
              // lying about it, same self-heal as the WhatsApp path.
              await supabase.from('telegram_accounts').update({ status: 'disconnected', display_name: null }).eq('user_id', userId);
              throw new Error('your Telegram session expired - reconnect Telegram in Profile and try again');
            }
            throw err;
          }
        }
        await supabase.from('social_calls').update({ status: 'ringing' })
          .eq('user_id', userId).eq('platform', callChannel).eq('peer_identifier', digitsOnly).eq('status', 'queued');
        newMessages.push(await insertMessage(supabase, userId, sessionId, 'assistant', `Calling ${label} on ${channelName} ${verb}.`, callRow.id, msgSource));
        return respond({ channelUsed: callChannel, callId: callRow.id, toNumber: digitsOnly, contactName: contact?.name || null });
      } catch (err) {
        await markSocialRowFailed(callRow);
        newMessages.push(await insertMessage(supabase, userId, sessionId, 'assistant', `I couldn't call ${label} on ${channelName}: ${err.message}`, callRow?.id || null, msgSource));
        return respond({ channelUsed: callChannel });
      }
    }

    // Belt and braces: Twilio is only reachable on an explicit 'phone' line.
    if (callChannel !== 'phone') {
      newMessages.push(await insertMessage(supabase, userId, sessionId, 'assistant', "I couldn't work out which line to call on. Pick Phone, WhatsApp or Telegram and try again.", null, msgSource));
      return respond();
    }

    try {
      const message = await saveCallPlan(supabase, userId, {
        sessionId, toNumber, contactId: contact?.id || null,
        objective: `${objective}\nUser's instructions: ${text.trim()}`, script: text.trim(),
        summary: `I'll call ${label}. ${objective}`, label,
      });
      newMessages.push(message);
      return respond({ channelUsed: 'phone' });
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  }

  const rawReplyText = intent.reply || 'Got it.';
  const { endCall, cleanText } = shouldEndCall(rawReplyText, text);
  const { moodTag } = extractAndStripControlTags(rawReplyText);
  const inlineMood = intent.mood ? { emotion: String(intent.mood) } : moodTag;
  const finalEmotion = await commitTurn({ moodTag: inlineMood });

  newMessages.push(await insertMessage(supabase, userId, sessionId, 'assistant', cleanText || 'Got it.', null, msgSource));
  return respond({
    endCall,
    emotionState: {
      primaryEmotion: finalEmotion.primaryEmotion,
      secondaryEmotion: finalEmotion.secondaryEmotion,
      intensity: finalEmotion.intensity,
    },
  });
}

// Posted once, when a voice call with Emysa ends — the home chat is meant
// to read like a log of decisions, not a transcript of talking out loud,
// so instead of leaving every "hey" / "how can I help" turn visible there
// (those were saved with source:'call' and are filtered out of the list),
// one clean line goes in summarizing what actually happened.
async function summarizeCall(req, res, supabase, userId) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const { transcript } = req.body || {};
  if (!transcript || !transcript.trim()) return res.status(400).json({ error: 'transcript required' });
  if (!hasConfiguredLlm(process.env)) return res.status(200).json({ summary: 'Had a call with Emysa.' });
  try {
    const llmResult = await createChatCompletion({
      messages: [
        {
          role: 'system',
          content:
            'Analyze this voice call with Emysa. Reply with a JSON object: {"summary": "ONE short plain sentence in third person logging what happened", "memories": ["up to 3 durable personal facts, preferences, or episodic takeaways worth remembering about the user, or empty array"]}.',
        },
        { role: 'user', content: transcript.slice(0, 4000) },
      ],
      temperature: 0.3,
      max_tokens: 180,
      response_format: { type: 'json_object' },
    });
    if (!llmResult.ok) {
      console.error(`summarizeCall: request rejected (status ${llmResult.status}):`, llmResult.errorText);
      return res.status(200).json({ summary: 'Had a call with Emysa.' });
    }
    const raw = llmResult.data?.choices?.[0]?.message?.content?.trim() || '';
    let summary = 'Had a call with Emysa.';
    let extractedMemories = [];
    try {
      const parsed = JSON.parse(raw);
      if (parsed.summary && typeof parsed.summary === 'string') summary = parsed.summary.trim();
      if (Array.isArray(parsed.memories)) extractedMemories = parsed.memories;
    } catch {
      if (raw && !raw.startsWith('{')) summary = raw;
    }
    if (extractedMemories.length > 0) {
      await consolidateAndStoreMemories({
        supabase,
        userId,
        candidates: extractedMemories.map((m) => ({
          content: String(m),
          memory_type: inferMemoryType(String(m)),
        })),
      });
    }
    return res.status(200).json({ summary: summary || 'Had a call with Emysa.' });
  } catch (err) {
    console.error('summarizeCall: request threw:', err);
    return res.status(200).json({ summary: 'Had a call with Emysa.' });
  }
}

async function logCallSummary(req, res, supabase, userId) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const { sessionId, summary } = req.body || {};
  if (!sessionId || !summary || !summary.trim()) return res.status(400).json({ error: 'sessionId and summary required' });
  try {
    const row = await insertMessage(supabase, userId, sessionId, 'assistant', summary.trim(), null, 'text');
    return res.status(200).json({ message: row });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

async function transcribeAudio(req, res, supabase, userId) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!resolveSttApiKey(process.env)) return res.status(500).json({ error: 'Voice input not configured (missing OPENAI_API_KEY)' });

  const { audioBase64, mimeType } = req.body || {};
  if (!audioBase64) return res.status(400).json({ error: 'audioBase64 required' });

  try {
    const audioBytes = Buffer.from(audioBase64, 'base64');
    const ext = (mimeType || 'audio/webm').split('/')[1]?.split(';')[0] || 'webm';
    // Pin the language from Settings. Auto-detect on short or noisy audio was
    // guessing German, and Emysa then answered in German.
    const { data: langRow } = await supabase.from('profiles').select('language').eq('user_id', userId).maybeSingle();
    const language = STT_LANGUAGES.has(langRow?.language) ? langRow.language : undefined;
    const result = await transcribeAudioBuffer({
      language,
      bytes: audioBytes,
      filename: `voice.${ext}`,
      mimeType: mimeType || 'audio/webm',
    });
    if (!result.ok) {
      console.error(`transcribeAudio: OpenAI transcription rejected (status ${result.status}):`, result.error);
      return res.status(502).json({ error: 'Transcription failed', detail: result.error });
    }
    return res.status(200).json({ text: result.text });
  } catch (err) {
    console.error('transcribeAudio: request to OpenAI threw:', err);
    return res.status(500).json({ error: err.message || String(err) });
  }
}
