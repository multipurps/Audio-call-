import { getServiceClient, getAuthedUserId } from '../lib/supabaseAdmin.js';

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
    case 'messages': return listMessages(req, res, supabase, userId);
    case 'send': return sendMessage(req, res, supabase, userId);
    case 'transcribe': return transcribeAudio(req, res, supabase, userId);
    case 'speak': return speakText(req, res, supabase, userId);
    case 'deleteSession': return deleteSession(req, res, supabase, userId);
    default: return res.status(400).json({ error: 'Unknown or missing action' });
  }
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
      return res.status(502).json({ error: 'Speech generation failed', detail: detail.slice(0, 300) });
    }
    const audioBuf = Buffer.from(await resp.arrayBuffer());
    return res.status(200).json({ audioBase64: audioBuf.toString('base64'), mimeType: 'audio/mpeg' });
  } catch (err) {
    return res.status(500).json({ error: 'Speech generation failed', detail: String(err?.message || err).slice(0, 300) });
  }
}

async function listSessions(req, res, supabase, userId) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
  const { data, error } = await supabase
    .from('chat_sessions')
    .select('id,title,created_at,updated_at')
    .eq('user_id', userId)
    .order('updated_at', { ascending: false })
    .limit(100);
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ sessions: data });
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
    .order('created_at', { ascending: true })
    .limit(200);
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ messages: data, sessionId });
}

async function insertMessage(supabase, userId, sessionId, role, content, callId = null) {
  const { data, error } = await supabase
    .from('assistant_messages')
    .insert({ user_id: userId, session_id: sessionId, role, content, call_id: callId })
    .select()
    .single();
  if (error) throw new Error(error.message);
  await supabase.from('chat_sessions').update({ updated_at: new Date().toISOString() }).eq('id', sessionId);
  return data;
}

async function sendMessage(req, res, supabase, userId) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const { text, callerId, sessionId: incomingSessionId } = req.body || {};
  if (!text || !text.trim()) return res.status(400).json({ error: 'text required' });

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

  const userMsg = await insertMessage(supabase, userId, sessionId, 'user', text.trim());
  const newMessages = [userMsg];
  const respond = (extra = {}) => res.status(200).json({ messages: newMessages, sessionId, isNewSession, ...extra });

  const falKey = process.env.FAL_KEY;
  if (!falKey) {
    newMessages.push(await insertMessage(supabase, userId, sessionId, 'assistant', "I'm not fully set up yet — the assistant's API key hasn't been added on the server."));
    return respond();
  }

  const { data: contacts } = await supabase.from('contacts').select('id,name,phone_number').eq('user_id', userId);
  const { data: history } = await supabase
    .from('assistant_messages')
    .select('role,content')
    .eq('user_id', userId)
    .eq('session_id', sessionId)
    .order('created_at', { ascending: false })
    .limit(20);
  const recentHistory = (history || []).reverse();

  const contactsList = (contacts || []).map((c) => `- ${c.name}`).join('\n') || '(no contacts saved yet)';
  const systemPrompt = [
    'You are Emysa, the in-app assistant for a phone-calling app. The user tells you who to call and what to say, and you place the call for them. They can give you either a phone number directly, or a name from their saved contacts below:',
    'Known contacts:',
    contactsList,
    '',
    'Reply with ONLY a JSON object, no other text, matching this shape:',
    '{"action":"call"|"retry"|"reply","phoneNumber":string|null,"contactName":string|null,"objective":string|null,"reply":string|null}',
    '- action "call": the user wants you to call someone new. If they gave you an actual phone number in their message, put the digits (with country code if given, e.g. "+15551234567") in phoneNumber. Otherwise, if they named someone from the saved contacts list, put your best guess at that name in contactName. objective is a short phrase describing what to say or ask on the call — if they also gave any tone or manner direction (stay calm, keep it light, let it flow naturally, be quick about it, etc.), include that in objective too, don\'t drop it.',
    '- action "retry": the user wants you to call the same person again (e.g. "call him again", "try it again").',
    '- action "reply": anything else, including if they want to call someone but haven\'t given you a number or a known contact yet — ask for the phone number in "reply".',
  ].join('\n');

  const chatMessages = [
    { role: 'system', content: systemPrompt },
    ...recentHistory.map((h) => ({ role: h.role === 'assistant' ? 'assistant' : 'user', content: h.content })),
  ];

  let intent;
  try {
    const resp = await fetch('https://fal.run/openrouter/router/openai/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Key ${falKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'openai/gpt-4o-mini',
        messages: chatMessages,
        temperature: 0.3,
        response_format: { type: 'json_object' },
      }),
    });
    if (!resp.ok) throw new Error(await resp.text());
    const data = await resp.json();
    intent = JSON.parse(data.choices?.[0]?.message?.content || '{}');
  } catch (err) {
    console.error('assistant intent parse failed:', err);
    newMessages.push(await insertMessage(supabase, userId, sessionId, 'assistant', "Sorry, I couldn't process that — try again in a moment."));
    return respond();
  }

  if (intent.action === 'call' || intent.action === 'retry') {
    let contact = null;

    if (intent.action === 'retry') {
      const { data: lastCall } = await supabase
        .from('calls')
        .select('contact_id')
        .eq('user_id', userId)
        .not('contact_id', 'is', null)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (lastCall?.contact_id) {
        const { data: c } = await supabase.from('contacts').select('*').eq('id', lastCall.contact_id).maybeSingle();
        contact = c;
      }
    } else if (!intent.phoneNumber) {
      const name = (intent.contactName || '').trim().toLowerCase();
      if (name) {
        contact =
          (contacts || []).find((c) => c.name.toLowerCase() === name) ||
          (contacts || []).find((c) => c.name.toLowerCase().includes(name) || name.includes(c.name.toLowerCase())) ||
          null;
      }
    }

    const toNumber = intent.phoneNumber || contact?.phone_number || null;
    const label = contact?.name || intent.phoneNumber;

    if (!toNumber) {
      const msg =
        intent.action === 'retry'
          ? "I'm not sure who to call again yet — tell me who you'd like me to call."
          : "What number should I call? You can give me a phone number, or a name from your saved contacts.";
      newMessages.push(await insertMessage(supabase, userId, sessionId, 'assistant', msg));
      return respond();
    }

    let objective = intent.objective || 'Say hello and share what the user wants to talk about.';
    const { data: langProfile } = await supabase.from('profiles').select('language').eq('user_id', userId).maybeSingle();
    if (langProfile?.language && langProfile.language !== 'en') {
      const langName = LANGUAGE_NAMES[langProfile.language] || langProfile.language;
      objective = `Speak only in ${langName} for this entire call, regardless of what language this instruction is written in. ${objective}`;
    }
    const placed = await placeCall(supabase, userId, { toNumber, objective, contactId: contact?.id || null, callerId: callerId || null, sessionId });

    if (placed.error) {
      newMessages.push(await insertMessage(supabase, userId, sessionId, 'assistant', `I couldn't call ${label}: ${placed.error}`));
      return respond();
    }

    const verb = intent.action === 'retry' ? 'again now' : 'now';
    newMessages.push(await insertMessage(supabase, userId, sessionId, 'assistant', `I'm calling ${label} ${verb}.`, placed.call.id));
    return respond({ callId: placed.call.id, toNumber, contactName: contact?.name || null });
  }

  newMessages.push(await insertMessage(supabase, userId, sessionId, 'assistant', intent.reply || 'Got it.'));
  return respond();
}

// Duplicated (rather than shared with api/calls.js) on purpose: this keeps
// the already-working manual "type a number" composer flow in calls.js
// completely untouched while this newer assistant path is still being wired
// up and tested.
async function placeCall(supabase, userId, { toNumber, objective, contactId, callerId = null, sessionId = null }) {
  const { data: usage } = await supabase.from('user_usage').select('*').eq('user_id', userId).maybeSingle();
  const used = usage?.call_minutes_used ?? 0;
  const limit = usage?.monthly_minute_limit ?? 60;
  if (used >= limit) return { error: 'monthly call minutes exhausted' };

  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const fromNumber = process.env.TWILIO_FROM_NUMBER;
  const appUrl = process.env.PUBLIC_APP_URL;
  if (!accountSid || !authToken || !fromNumber || !appUrl) return { error: 'telephony not configured yet' };

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
      Record: 'true',
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
      return res.status(502).json({ error: 'Transcription failed', detail });
    }
    const data = await resp.json();
    return res.status(200).json({ text: data.text || '' });
  } catch (err) {
    return res.status(500).json({ error: err.message || String(err) });
  }
}
