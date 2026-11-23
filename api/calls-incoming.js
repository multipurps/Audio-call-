// The carrier hits this (as XML) the moment someone calls a number provisioned
// via Profile -> Call Answering (see api/call-answering.js). Mirrors
// api/calls-twiml.js's <Connect><Stream> setup for outbound calls, except
// there's no pre-existing calls row yet — this creates one first, with
// direction:'inbound' and to_number set to the *caller's* number (since
// that's who Emysa is actually talking to here).
import { guardWebhook, streamUrl } from '../lib/telephony.js';
import { getServiceClient } from '../lib/supabaseAdmin.js';

function xml(res, body) {
  res.setHeader('Content-Type', 'text/xml');
  return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`);
}

export default async function handler(req, res) {
  if (!guardWebhook(req, res, 'incoming')) return;
  const to = req.body?.To || '';
  const from = req.body?.From || '';
  const callSid = req.body?.CallSid || '';
  const supabase = getServiceClient();

  const { data: settings } = await supabase
    .from('call_answering_settings')
    .select('*')
    .eq('twilio_number', to)
    .eq('enabled', true)
    .maybeSingle();

  if (!settings) {
    return xml(res, `<Say>Sorry, this number isn't accepting calls right now.</Say><Hangup/>`);
  }

  // Best-effort: if the caller's number matches a saved contact, link it so
  // memories/instructions stay contact-aware, same as outbound calls.
  const { data: contact } = await supabase
    .from('contacts')
    .select('id')
    .eq('user_id', settings.user_id)
    .eq('phone_number', from)
    .maybeSingle();

  const { data: call, error } = await supabase
    .from('calls')
    .insert({
      user_id: settings.user_id,
      to_number: from,
      objective: settings.instructions || 'Answer the phone naturally and see what they need.',
      status: 'in_progress',
      contact_id: contact?.id || null,
      direction: 'inbound',
      twilio_call_sid: callSid,
    })
    .select()
    .single();

  if (error || !call) return xml(res, `<Say>Sorry, something went wrong.</Say><Hangup/>`);

  const relayUrl = streamUrl(process.env.RELAY_WS_URL);
  if (!relayUrl) return xml(res, `<Say>Sorry, this assistant isn't configured yet.</Say><Hangup/>`);

  // No query string on the stream URL (SignalWire rejects it): the call id goes in a <Parameter>.
  const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  return xml(res, `<Connect><Stream url="${esc(relayUrl)}"><Parameter name="callId" value="${esc(call.id)}" /></Stream></Connect>`);
}
