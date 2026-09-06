import { getServiceClient, getAuthedUserId } from '../lib/supabaseAdmin.js';

// Home-screen "talk to the assistant" chat. Separate from the live in-call
// relay (server/relay.js) — this is the request/response layer where the
// user tells Mitra what they want done, Mitra decides whether that means
// placing a call to a saved contact, and the actual call outcome (busy, no
// answer, completed) gets posted back into the same thread later by the
// Twilio status webhook (see api/calls-status.js).
export default async function handler(req, res) {
  const supabase = getServiceClient();
  const userId = await getAuthedUserId(req, supabase);
  if (!userId) return res.status(401).json({ error: 'Not signed in' });

  const action = req.query?.action || req.body?.action;
  switch (action) {
    case 'messages': return listMessages(req, res, supabase, userId);
    case 'send': return sendMessage(req, res, supabase, userId);
    case 'transcribe': return transcribeAudio(req, res, supabase, userId);
    case 'clear': return clearMessages(req, res, supabase, userId);
    default: return res.status(400).json({ error: 'Unknown or missing action' });
  }
}

async function clearMessages(req, res, supabase, userId) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const { error } = await supabase.from('assistant_messages').delete().eq('user_id', userId);
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ ok: true });
}

async function listMessages(req, res, supabase, userId) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
  const { data, error } = await supabase
    .from('assistant_messages')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: true })
    .limit(200);
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ messages: data });
}

async function insertMessage(supabase, userId, role, content, callId = null) {
  const { data, error } = await supabase
    .from('assistant_messages')
    .insert({ user_id: userId, role, content, call_id: callId })
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data;
}

async function sendMessage(req, res, supabase, userId) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const { text, callerId } = req.body || {};
  if (!text || !text.trim()) return res.status(400).json({ error: 'text required' });

  const userMsg = await insertMessage(supabase, userId, 'user', text.trim());
  const newMessages = [userMsg];

  const groqKey = process.env.GROQ_API_KEY;
  if (!groqKey) {
    newMessages.push(await insertMessage(supabase, userId, 'assistant', "I'm not fully set up yet — the assistant's API key hasn't been added on the server."));
    return res.status(200).json({ messages: newMessages });
  }

  const { data: contacts } = await supabase.from('contacts').select('id,name,phone_number').eq('user_id', userId);
  const { data: history } = await supabase
    .from('assistant_messages')
    .select('role,content')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(20);
  const recentHistory = (history || []).reverse();

  const contactsList = (contacts || []).map((c) => `- ${c.name}`).join('\n') || '(no contacts saved yet)';
  const systemPrompt = [
    'You are Mitra, the in-app assistant for a phone-calling app. The user can ask you to call people by name from their saved contacts, and you place the call for them.',
    'Known contacts:',
    contactsList,
    '',
    'Reply with ONLY a JSON object, no other text, matching this shape:',
    '{"action":"call"|"retry"|"reply","contactName":string|null,"objective":string|null,"reply":string|null}',
    '- action "call": the user wants you to call someone new. contactName is your best guess at which saved contact they mean (or null if unclear). objective is a short phrase describing what to say or ask on the call.',
    '- action "retry": the user wants you to call the same person again (e.g. "call him again", "try it again").',
    '- action "reply": anything else — just talk back normally and put your response in "reply".',
  ].join('\n');

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
        model: 'llama-3.3-70b-versatile',
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
    newMessages.push(await insertMessage(supabase, userId, 'assistant', "Sorry, I couldn't process that — try again in a moment."));
    return res.status(200).json({ messages: newMessages });
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
    } else {
      const name = (intent.contactName || '').trim().toLowerCase();
      if (name) {
        contact =
          (contacts || []).find((c) => c.name.toLowerCase() === name) ||
          (contacts || []).find((c) => c.name.toLowerCase().includes(name) || name.includes(c.name.toLowerCase())) ||
          null;
      }
    }

    if (!contact) {
      const msg =
        intent.action === 'retry'
          ? "I'm not sure who to call again yet — tell me who you'd like me to call."
          : `I don't have ${intent.contactName ? `"${intent.contactName}"` : 'that person'} in your contacts yet. Add them in Profile → Contacts, then ask me again.`;
      newMessages.push(await insertMessage(supabase, userId, 'assistant', msg));
      return res.status(200).json({ messages: newMessages });
    }

    const objective = intent.objective || 'Say hello and share what the user wants to talk about.';
    const placed = await placeCall(supabase, userId, { toNumber: contact.phone_number, objective, contactId: contact.id, callerId: callerId || null });

    if (placed.error) {
      newMessages.push(await insertMessage(supabase, userId, 'assistant', `I couldn't call ${contact.name}: ${placed.error}`));
      return res.status(200).json({ messages: newMessages });
    }

    const verb = intent.action === 'retry' ? 'again now' : 'now';
    newMessages.push(await insertMessage(supabase, userId, 'assistant', `I'm calling ${contact.name} ${verb}.`, placed.call.id));
    return res.status(200).json({ messages: newMessages, callId: placed.call.id });
  }

  newMessages.push(await insertMessage(supabase, userId, 'assistant', intent.reply || 'Got it.'));
  return res.status(200).json({ messages: newMessages });
}

// Duplicated (rather than shared with api/calls.js) on purpose: this keeps
// the already-working manual "type a number" composer flow in calls.js
// completely untouched while this newer assistant path is still being wired
// up and tested.
async function placeCall(supabase, userId, { toNumber, objective, contactId, callerId = null }) {
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
    form.append('file', new Blob([audioBytes], { type: mimeType || 'audio/webm' }), 'voice.webm');

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
