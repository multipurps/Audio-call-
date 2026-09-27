import { LANGUAGE_NAMES } from './callLanguages.js';
import { placeCall } from './phoneCalls.js';
import { normalizePhone } from './phoneNumbers.js';

async function message(db, userId, sessionId, role, content, callId = null) {
  const { data, error } = await db.from('assistant_messages').insert({
    user_id: userId, session_id: sessionId, role, content, source: 'text', call_id: callId,
  }).select().single();
  if (error) throw new Error(error.message);
  await db.from('chat_sessions').update({ updated_at: new Date().toISOString() }).eq('id', sessionId).eq('user_id', userId);
  return data;
}

export async function saveCallPlan(db, userId, { sessionId, toNumber, contactId = null, objective, script = objective, summary, label, kind = 'contact' }) {
  const number = normalizePhone(toNumber);
  if (!number) throw new Error('Enter a phone number with country code, for example +14155552671.');
  const reply = await message(db, userId, sessionId, 'assistant', `${summary}\nPhone: ${number}. Review the script, then tap Call Now. Nothing has been dialed yet.`);
  // A revision supersedes the previous confirmation, including on another device.
  const { error: cancelError } = await db.from('call_plans').update({ status: 'cancelled' })
    .eq('user_id', userId).eq('session_id', sessionId).eq('status', 'pending');
  if (cancelError) throw new Error(cancelError.message);
  const { data: plan, error } = await db.from('call_plans').insert({
    user_id: userId, session_id: sessionId, message_id: reply.id,
    to_number: number, contact_id: contactId, objective, script, summary, label, kind,
  }).select().single();
  if (error) throw new Error(error.message);
  return { ...reply, call_plan: plan };
}

export async function attachCallPlans(db, userId, sessionId, messages) {
  const { data, error } = await db.from('call_plans').select('*').eq('user_id', userId).eq('session_id', sessionId);
  if (error) throw new Error(error.message);
  const plans = new Map((data || []).map((p) => [p.message_id, p]));
  return (messages || []).map((m) => ({ ...m, call_plan: plans.get(m.id) || null }));
}

export async function prepareCall(req, res, db, userId) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const { text, target = {}, sessionId: incomingSessionId } = req.body || {};
  if (typeof text !== 'string' || !text.trim() || text.length > 4000) return res.status(400).json({ error: 'Write your call instructions (maximum 4000 characters).' });
  try {
    if (!target || typeof target !== 'object' || (target.kind === 'emysa' && target.contactId)) return res.status(400).json({ error: 'Choose a contact or a direct Emysa callback, not both.' });
    let number = normalizePhone(target.toNumber);
    let contactId = null;
    let label = target.kind === 'emysa' ? 'Emysa (callback to you)' : number;
    if (target.contactId) {
      const { data: contact } = await db.from('contacts').select('*').eq('id', target.contactId).eq('user_id', userId).maybeSingle();
      if (!contact) return res.status(404).json({ error: 'Contact not found' });
      number = normalizePhone(contact.phone_number);
      contactId = contact.id;
      label = contact.name;
    }
    if (!number) return res.status(400).json({ error: 'Enter a phone number with country code, for example +14155552671.' });
    let sessionId = incomingSessionId;
    if (sessionId) {
      const { data: owned } = await db.from('chat_sessions').select('id').eq('id', sessionId).eq('user_id', userId).maybeSingle();
      if (!owned) return res.status(404).json({ error: 'Chat not found' });
    }
    const key = process.env.GROQ_API_KEY;
    if (!key) return res.status(503).json({ error: 'The assistant is not configured yet. No call was placed.' });
    // Summarization is deliberately separate from intent parsing: the model
    // cannot choose a different contact, channel or destination here.
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'qwen/qwen3.8-27b', temperature: 0.3, max_tokens: 220,
        messages: [
          { role: 'system', content: 'You are Emysa. Summarize the user\'s call instructions in one or two short sentences in first person ("I will..."). Preserve important details and tone. This is only a preview, never say you have dialed or completed anything. Do not add promises, change the recipient or invent facts.' },
          { role: 'user', content: text.trim() },
        ],
      }),
    });
    if (!response.ok) return res.status(502).json({ error: 'Could not prepare the summary. Please try again. No call was placed.' });
    const result = await response.json();
    const summary = result.choices?.[0]?.message?.content?.trim();
    if (!summary) throw new Error('The summary was empty. Please try again.');
    if (!sessionId) {
      const { data, error } = await db.from('chat_sessions').insert({ user_id: userId, title: `Call · ${label}`.slice(0, 100) }).select().single();
      if (error) throw new Error(error.message);
      sessionId = data.id;
    }
    const userMessage = await message(db, userId, sessionId, 'user', text.trim());
    let objective = target.kind === 'emysa'
      ? `You are Emysa, calling the app user directly at their requested callback number. Talk with them about the following, not with a third-party contact.\n${text.trim()}`
      : text.trim();
    const { data: profile } = await db.from('profiles').select('language').eq('user_id', userId).maybeSingle();
    if (profile?.language && LANGUAGE_NAMES[profile.language]) {
      objective = `Speak only in ${LANGUAGE_NAMES[profile.language]} for this entire call. ${objective}`;
    }
    const reply = await saveCallPlan(db, userId, { sessionId, toNumber: number, contactId, objective, script: text.trim(),
      summary: `${label}: ${summary}`, label, kind: target.kind === 'emysa' ? 'emysa' : 'contact' });
    return res.status(200).json({ sessionId, messages: [userMessage, reply], channelUsed: 'phone' });
  } catch (err) {
    console.error('prepareCall:', err);
    return res.status(500).json({ error: 'Could not save the call plan. Please try again. No call was placed.' });
  }
}

export async function confirmCallPlan(req, res, db, userId) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const { planId } = req.body || {};
  if (typeof planId !== 'string' || !/^[0-9a-f-]{36}$/i.test(planId)) return res.status(400).json({ error: 'Prepare a script in chat, then use Call Now.' });
  // Compare-and-set in Postgres: double taps, concurrent tabs and retries
  // cannot submit the same paid call twice. Never unlock after provider I/O:
  // a network timeout may mean Twilio accepted the call without a response.
  const { data: plan, error } = await db.from('call_plans').update({ status: 'placing' })
    .eq('id', planId).eq('user_id', userId).eq('status', 'pending')
    .gt('expires_at', new Date().toISOString()).select().maybeSingle();
  if (error) return res.status(500).json({ error: 'Could not confirm the call. Please reload the conversation.' });
  if (!plan) return res.status(409).json({ error: 'This plan was already used, replaced, cancelled or expired. Prepare a new script to call again.' });
  try {
    const placed = await placeCall(db, userId, { toNumber: plan.to_number, objective: plan.objective,
      contactId: plan.contact_id, sessionId: plan.session_id, kind: plan.kind });
    if (placed.error) {
      await db.from('call_plans').update({ status: placed.uncertain ? 'uncertain' : 'failed', call_id: placed.callId || null }).eq('id', plan.id).eq('user_id', userId);
      return res.status(502).json({ error: `${placed.error}. Check Recent before preparing another call.` });
    }
    await db.from('call_plans').update({ status: 'placed', call_id: placed.call.id }).eq('id', plan.id).eq('user_id', userId);
    const reply = await message(db, userId, plan.session_id, 'assistant', `Calling ${plan.label} now.`, placed.call.id);
    return res.status(200).json({ callId: placed.call.id, toNumber: plan.to_number, contactName: plan.label, sessionId: plan.session_id, messages: [reply] });
  } catch (err) {
    console.error('confirmCallPlan:', err);
    return res.status(500).json({ error: 'Could not verify the call result. Check Recent before preparing another call.' });
  }
}
