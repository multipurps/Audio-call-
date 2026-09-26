import { getServiceClient, getAuthedUserId } from '../lib/supabaseAdmin.js';
import { wacallsStartCall } from '../lib/wacallsClient.js';
import { mpRelayRequest } from '../lib/mpRelayClient.js';

const LANGUAGE_NAMES = { en: 'English', es: 'Spanish', fr: 'French', pt: 'Portuguese', de: 'German', ha: 'Hausa', yo: 'Yoruba', ig: 'Igbo', sw: 'Swahili', ar: 'Arabic', hi: 'Hindi', zh: 'Chinese' };

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
// Intent parsing (action=send) uses fal.ai's OpenRouter-compatible chat
// completions proxy with openai/gpt-4o-mini — not Groq. Groq's
// llama-3.3-70b-versatile (used here until now) was decommissioned; every
// call to it now fails with model_decommissioned. Voice-input transcription
// (action=transcribe) still uses Groq Whisper, which is unaffected.
export default async function handler(req, res) {
  const supabase = getServiceClient();
  const userId = await getAuthedUserId(req, supabase);
  if (!userId) return res.status(401).json({ error: 'Not signed in' });

  const action = req.query?.action || req.body?.action;
  switch (action) {
    case 'sessions': return listSessions(req, res, supabase, userId);
    case 'archiveSession': return archiveSession(req, res, supabase, userId);
    case 'messages': return listMessages(req, res, supabase, userId);
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
  if (!text || !text.trim()) return res.status(400).json({ error: 'text required' });

  const { data: voice } = await supabase.from('voice_profiles').select('*').eq('user_id', userId).maybeSingle();
  const referenceId = voice?.status === 'ready' ? voice.provider_voice_id : undefined;

  try {
    const resp = await fetch('https://api.fish.audio/v1/tts', {
      method: 'POST',
      headers: { Authorization: `Bearer ${fishKey}`, 'Content-Type': 'application/json', model: 's1' },
      body: JSON.stringify({ text: text.slice(0, 600), reference_id: referenceId, format: 'mp3' }),
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
  const { data, error } = await supabase
    .from('chat_sessions')
    .select('id,title,created_at,updated_at,archived')
    .eq('user_id', userId)
    .eq('archived', archived)
    .order('updated_at', { ascending: false })
    .limit(100);
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ sessions: data });
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
  return res.status(200).json({ messages: data, sessionId });
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
// Uses Groq's qwen/qwen3.8-27b, a vision-capable model on the same free
// tier already used for Whisper transcription in this file - no separate
// paid account needed for this feature.
// (Note: a previous change here briefly swapped this to 'qwen/qwen3-32b',
// on the wrong assumption that qwen3.8-27b didn't exist. It does - that
// was a bad fix and has been reverted. If Groq requests are still failing,
// the cause is something else; see the richer error surfaced below.)
async function sendImage(req, res, supabase, userId) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const { imageBase64, mimeType, caption, sessionId: incomingSessionId, source } = req.body || {};
  if (!imageBase64) return res.status(400).json({ error: 'imageBase64 required' });
  const msgSource = source === 'call' ? 'call' : 'text';
  const groqKey = process.env.GROQ_API_KEY;
  if (!groqKey) return res.status(500).json({ error: 'Vision not configured (missing GROQ_API_KEY)' });

  let sessionId = incomingSessionId || null;
  let isNewSession = false;
  if (!sessionId) {
    const { data: session, error } = await supabase
      .from('chat_sessions')
      .insert({ user_id: userId, title: 'Photo' })
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
    const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${groqKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen/qwen3.8-27b',
        messages: [
          {
            role: 'system',
            content:
              "You are Emysa, a helpful voice assistant. The user just shared a photo with you. Respond to what's actually in it naturally and conversationally, in 1-3 sentences, as if speaking out loud on a phone call.",
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
      }),
    });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => '');
      console.error(`sendImage: vision request rejected (status ${resp.status}):`, detail.slice(0, 500));
    } else {
      const data = await resp.json();
      reply = data.choices?.[0]?.message?.content?.trim() || reply;
    }
  } catch (err) {
    console.error('sendImage: vision request threw:', err);
  }

  newMessages.push(await insertMessage(supabase, userId, sessionId, 'assistant', reply, null, msgSource));
  return res.status(200).json({ messages: newMessages, sessionId, isNewSession });
}

async function sendMessage(req, res, supabase, userId) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const { text, callerId, sessionId: incomingSessionId, source, channel } = req.body || {};
  if (!text || !text.trim()) return res.status(400).json({ error: 'text required' });
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
  let isNewSession = false;
  if (!sessionId) {
    const { data: session, error } = await supabase
      .from('chat_sessions')
      .insert({ user_id: userId, title: titleFromText(text) || 'New chat' })
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });
    sessionId = session.id;
    isNewSession = true;
  }

  const userMsg = await insertMessage(supabase, userId, sessionId, 'user', text.trim(), null, msgSource);
  const newMessages = [userMsg];
  const respond = (extra = {}) => res.status(200).json({ messages: newMessages, sessionId, isNewSession, ...extra });

  const groqKey = process.env.GROQ_API_KEY;
  if (!groqKey) {
    newMessages.push(await insertMessage(supabase, userId, sessionId, 'assistant', "I'm not fully set up yet — the assistant's API key hasn't been added on the server.", null, msgSource));
    return respond();
  }

  const { data: contacts } = await supabase.from('contacts').select('id,name,phone_number').eq('user_id', userId);
  const { data: memRows } = await supabase.from('memories').select('content').eq('user_id', userId).order('created_at', { ascending: false }).limit(5);
  const { data: history } = await supabase
    .from('assistant_messages')
    .select('role,content')
    .eq('user_id', userId)
    .eq('session_id', sessionId)
    .order('created_at', { ascending: false })
    .limit(20);
  const recentHistory = (history || []).reverse();

  const contactsList = (contacts || []).map((c) => `- ${c.name}`).join('\n') || '(no contacts saved yet)';
  const memoriesList = (memRows || []).map((m) => `- ${m.content}`).join('\n');
  const systemPrompt = [
    'You are Emysa, the in-app assistant for a phone-calling app. The user tells you who to call and what to say, and you place the call for them. They can give you either a phone number directly, or a name from their saved contacts below:',
    'Known contacts:',
    contactsList,
    memoriesList ? `\nThings worth remembering about this user from past calls:\n${memoriesList}` : '',
    '',
    "About the app, for when the user asks (answer naturally and conversationally in \"reply\" — don't deflect these to a phone-number prompt): this app lets you tell Emysa (you) who to call and what to say, then Emysa places a real phone call and carries the conversation. You can call any phone number or a saved contact, ask for the same person again with something like \"call him again\", and Emysa remembers context from past calls to inform future ones.",
    '',
    'Reply with ONLY a JSON object, no other text, matching this shape:',
    '{"action":"call"|"retry"|"reply","phoneNumber":string|null,"contactName":string|null,"objective":string|null,"channel":"phone"|"whatsapp"|"telegram"|null,"reply":string|null}',
    '- action "call": the user wants you to call someone new. If they gave you an actual phone number in their message, put the digits (with country code if given, e.g. "+15551234567") in phoneNumber. Otherwise, if they named someone from the saved contacts list, put your best guess at that name in contactName. objective is a short phrase describing what to say or ask on the call — if they also gave any tone or manner direction (stay calm, keep it light, let it flow naturally, be quick about it, etc.), include that in objective too, don\'t drop it. If they explicitly named which line to call on in this message (e.g. "on WhatsApp", "call him on Telegram", "use my phone line"), put that in channel - phone/whatsapp/telegram. If they did not name a line in THIS message, leave channel null; do not guess or reuse a line from earlier in the conversation, since the app\'s own line selector already carries that forward and takes over whenever this is null.',
    '- action "retry": the user wants you to call the same person again (e.g. "call him again", "try it again").',
    '- action "reply": anything else — general conversation, questions about you or the app, small talk, or a call request with no number/contact given yet. Answer naturally and helpfully in "reply". Only ask for a phone number or contact name if they\'ve actually expressed intent to make a call but haven\'t said who.',
    'Every single response, with no exceptions, must be that one JSON object and nothing else - never plain conversational text, never text before or after the JSON, even for casual chat or small talk. Put the conversational reply itself inside the "reply" field.',
  ].filter(Boolean).join('\n');

  const chatMessages = [
    { role: 'system', content: systemPrompt },
    ...recentHistory.map((h) => ({ role: h.role === 'assistant' ? 'assistant' : 'user', content: h.content })),
  ];

  let intent;
  try {
    const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${groqKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen/qwen3.8-27b',
        messages: chatMessages,
        temperature: 0.3,
        response_format: { type: 'json_object' },
      }),
    });
    if (!resp.ok) throw new Error(await resp.text());
    const data = await resp.json();
    intent = JSON.parse(data.choices?.[0]?.message?.content || '{}');
  } catch (err) {
    // Groq's strict JSON-mode validator sometimes rejects a perfectly good
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
      // TEMPORARY: showing the real error text in-app (truncated) because
      // there's no access to Vercel's function logs from here to see why a
      // request failed. Ask to have this reverted to a plain generic
      // message once the assistant is reliably working again.
      const detail = String(err?.message || err).slice(0, 220);
      newMessages.push(await insertMessage(supabase, userId, sessionId, 'assistant', `Sorry, I couldn't process that. (debug: ${detail})`, null, msgSource));
      return respond();
    }
  }

  // A platform named explicitly in this message (e.g. "call him on
  // WhatsApp") wins over the sticky line picker in the UI - naming it IS
  // choosing it, and should not be silently overridden by whatever the
  // button happened to be left on.
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
      // Retry looks at the call history of the *chosen* line only. Twilio
      // calls live in `calls`; WhatsApp/Telegram calls live in
      // `social_calls`. Retrying on WhatsApp must never pick up (and
      // re-dial) the last Twilio call, or vice versa.
      if (callChannel === 'phone') {
        const { data: lastCall } = await supabase
          .from('calls')
          .select('contact_id,to_number,objective')
          .eq('user_id', userId)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (lastCall?.contact_id) {
          const { data: c } = await supabase.from('contacts').select('*').eq('id', lastCall.contact_id).maybeSingle();
          contact = c;
        }
        retryToNumber = lastCall?.to_number || null;
        retryObjective = lastCall?.objective || null;
      } else {
        const { data: lastSocial } = await supabase
          .from('social_calls')
          .select('peer_identifier')
          .eq('user_id', userId)
          .eq('platform', callChannel)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        retryToNumber = lastSocial?.peer_identifier || null;
        if (retryToNumber) {
          contact = (contacts || []).find((c) => (c.phone_number || '').replace(/[\s()-]/g, '') === retryToNumber) || null;
        }
      }
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
      const recordSocialCall = async (status, platformCallId) => {
        await supabase.from('social_calls').insert({ user_id: userId, platform: callChannel, peer_identifier: digitsOnly, status })
          .then(({ error }) => { if (error) console.error('social_calls insert failed:', error.message); });
        const { data: callRow, error: callErr } = await supabase.from('calls').insert({
          user_id: userId,
          contact_id: contact?.id || null,
          to_number: digitsOnly,
          objective,
          platform: callChannel,
          platform_call_id: platformCallId || null,
          status,
        }).select().single();
        if (callErr) console.error('calls insert failed:', callErr.message);
        return callRow;
      };
      const verb = intent.action === 'retry' ? 'again now' : 'now';
      try {
        let platformCallId = null;
        if (callChannel === 'whatsapp') {
          const { data: waRow } = await supabase.from('whatsapp_accounts').select('wacalls_session_id').eq('user_id', userId).maybeSingle();
          if (!waRow?.wacalls_session_id) throw new Error('WhatsApp is not connected — link it in Profile first.');
          const result = await wacallsStartCall(userId, waRow.wacalls_session_id, digitsOnly);
          platformCallId = result?.callId || null;
        } else {
          // Telegram goes through mp-relay (MadelineProto), never through
          // the old relay's fake-DH stub and never through Twilio. If the
          // deployed mp-relay has no call route yet, say exactly that.
          const { data: tgRow } = await supabase.from('telegram_accounts').select('status').eq('user_id', userId).maybeSingle();
          if (tgRow?.status !== 'connected') throw new Error('Telegram is not connected — link it in Profile first.');
          try {
            const result = await mpRelayRequest('/calls', { method: 'POST', body: { userId, to: digitsOnly, sessionId, contactName: contact?.name || null } });
            platformCallId = result?.callId || null;
          } catch (err) {
            if (err.statusCode === 404) throw new Error("the Telegram call service (mp-relay) doesn't have call support deployed yet.");
            throw err;
          }
        }
        const callRow = await recordSocialCall('ringing', platformCallId);
        newMessages.push(await insertMessage(supabase, userId, sessionId, 'assistant', `Calling ${label} on ${channelName} ${verb}.`, null, msgSource));
        return respond({ channelUsed: callChannel, callId: callRow?.id || null, toNumber: digitsOnly, contactName: contact?.name || null });
      } catch (err) {
        await recordSocialCall('failed', null);
        newMessages.push(await insertMessage(supabase, userId, sessionId, 'assistant', `I couldn't call ${label} on ${channelName}: ${err.message}`, null, msgSource));
        return respond({ channelUsed: callChannel });
      }
    }

    // Belt and braces: Twilio is only reachable on an explicit 'phone' line.
    if (callChannel !== 'phone') {
      newMessages.push(await insertMessage(supabase, userId, sessionId, 'assistant', "I couldn't work out which line to call on. Pick Phone, WhatsApp or Telegram and try again.", null, msgSource));
      return respond();
    }

    const placed = await placeCall(supabase, userId, { toNumber, objective, contactId: contact?.id || null, callerId: callerId || null, sessionId });

    if (placed.error) {
      newMessages.push(await insertMessage(supabase, userId, sessionId, 'assistant', `I couldn't call ${label}: ${placed.error}`, null, msgSource));
      return respond();
    }

    const verb = intent.action === 'retry' ? 'again now' : 'now';
    newMessages.push(await insertMessage(supabase, userId, sessionId, 'assistant', `I'm calling ${label} ${verb}.`, placed.call.id, msgSource));
    return respond({ callId: placed.call.id, toNumber, contactName: contact?.name || null, channelUsed: callChannel });
  }

  newMessages.push(await insertMessage(supabase, userId, sessionId, 'assistant', intent.reply || 'Got it.', null, msgSource));
  return respond();
}

// Duplicated (rather than shared with api/calls.js) on purpose: this keeps
// the already-working manual "type a number" composer flow in calls.js
// completely untouched while this newer assistant path is still being wired
// up and tested.
async function placeCall(supabase, userId, { toNumber, objective, contactId, callerId = null, sessionId = null }) {
  const { data: usage } = await supabase.from('user_usage').select('*').eq('user_id', userId).maybeSingle();
  const used = usage?.call_minutes_used ?? 0;
  const limit = (usage?.monthly_minute_limit ?? 60) + (usage?.bonus_minutes ?? 0);
  if (used >= limit) return { error: 'monthly call minutes exhausted' };

  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const fromNumber = process.env.TWILIO_FROM_NUMBER;
  const appUrl = process.env.PUBLIC_APP_URL;
  if (!accountSid || !authToken || !fromNumber || !appUrl) return { error: 'telephony not configured yet' };

  const { data: settings } = await supabase.from('profiles').select('record_calls, ring_seconds').eq('user_id', userId).maybeSingle();
  const recordCalls = settings?.record_calls ?? true;
  const ringSeconds = settings?.ring_seconds ?? 25;

  const { data: call, error: insertErr } = await supabase
    .from('calls')
    .insert({
      user_id: userId,
      caller_id: callerId,
      to_number: toNumber,
      objective,
      status: 'queued',
      contact_id: contactId || null,
      session_id: sessionId || null,
    })
    .select()
    .single();
  if (insertErr) return { error: insertErr.message };

  try {
    const twiml_url = `${appUrl}/api/calls-twiml?callId=${call.id}`;
    const status_callback = `${appUrl}/api/calls-status?callId=${call.id}`;
    const body = new URLSearchParams({
      To: toNumber,
      From: fromNumber,
      Url: twiml_url,
      StatusCallback: status_callback,
      StatusCallbackEvent: 'initiated ringing answered completed',
      Record: recordCalls ? 'true' : 'false',
      Timeout: String(ringSeconds),
      MachineDetection: 'Enable', // lets calls-twiml.js hang up immediately on voicemail instead of connecting the relay
    });
    const twilioResp = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls.json`, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    });
    if (!twilioResp.ok) {
      const detail = await twilioResp.text().catch(() => '');
      console.error(`placeCall: Twilio rejected the call (status ${twilioResp.status}):`, detail.slice(0, 500));
      await supabase.from('calls').update({ status: 'failed' }).eq('id', call.id);
      return { error: 'call provider rejected the call' };
    }
    const twilioData = await twilioResp.json();
    await supabase.from('calls').update({ twilio_call_sid: twilioData.sid, status: 'ringing' }).eq('id', call.id);
    return { call };
  } catch (err) {
    await supabase.from('calls').update({ status: 'failed' }).eq('id', call.id);
    return { error: err.message || String(err) };
  }
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
  const groqKey = process.env.GROQ_API_KEY;
  if (!groqKey) return res.status(200).json({ summary: 'Had a call with Emysa.' });
  try {
    const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${groqKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen/qwen3.8-27b',
        messages: [
          { role: 'system', content: 'Summarize this voice call with an assistant in ONE short, plain sentence, third person, as if logging what the user did. No quotes, no preamble.' },
          { role: 'user', content: transcript.slice(0, 4000) },
        ],
        temperature: 0.3,
        max_tokens: 60,
      }),
    });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => '');
      console.error(`summarizeCall: request rejected (status ${resp.status}):`, detail.slice(0, 500));
      return res.status(200).json({ summary: 'Had a call with Emysa.' });
    }
    const data = await resp.json();
    const summary = data.choices?.[0]?.message?.content?.trim();
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
  const groqKey = process.env.GROQ_API_KEY;
  if (!groqKey) return res.status(500).json({ error: 'Voice input not configured (missing GROQ_API_KEY)' });

  const { audioBase64, mimeType } = req.body || {};
  if (!audioBase64) return res.status(400).json({ error: 'audioBase64 required' });

  try {
    const audioBytes = Buffer.from(audioBase64, 'base64');
    const form = new FormData();
    form.append('model', 'whisper-large-v3-turbo');
    const ext = (mimeType || 'audio/webm').split('/')[1]?.split(';')[0] || 'webm';
    form.append('file', new Blob([audioBytes], { type: mimeType || 'audio/webm' }), `voice.${ext}`);

    const resp = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${groqKey}` },
      body: form,
    });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => '');
      console.error(`transcribeAudio: Groq Whisper rejected the request (status ${resp.status}):`, detail.slice(0, 500));
      return res.status(502).json({ error: 'Transcription failed', detail });
    }
    const data = await resp.json();
    return res.status(200).json({ text: data.text || '' });
  } catch (err) {
    console.error('transcribeAudio: request to Groq threw:', err);
    return res.status(500).json({ error: err.message || String(err) });
  }
}
