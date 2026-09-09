// Twilio hits this URL (as XML, not JSON) once the outbound call connects.
// <Connect><Stream> opens a bidirectional Media Stream WebSocket to the
// relay server (server/relay.js), which is a persistent process — not this
// serverless function — because real-time audio needs a long-lived
// connection Vercel functions can't hold open. Deploy the relay the same
// place the other single-file apps' backends run (Render).
//
// MachineDetection:'Enable' (set on the original Calls.create() request in
// api/calls.js and api/assistant.js) makes Twilio hold the call, run its own
// audio-level detection, and pass the result here as AnsweredBy *before*
// this webhook fires — so a voicemail never reaches the relay at all, it's
// hung up right here instead.
import { getServiceClient } from '../lib/supabaseAdmin.js';

export default async function handler(req, res) {
  const callId = req.query?.callId || (req.body && req.body.callId) || '';
  const answeredBy = req.body?.AnsweredBy || '';

  if (answeredBy.startsWith('machine') || answeredBy === 'fax') {
    if (callId) {
      const supabase = getServiceClient();
      await supabase.from('calls').update({ status: 'no_answer', outcome_summary: 'Reached voicemail — hung up automatically.' }).eq('id', callId);
    }
    res.setHeader('Content-Type', 'text/xml');
    return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`);
  }

  const relayUrl = process.env.RELAY_WS_URL; // e.g. wss://audio-call-relay.onrender.com/stream

  if (!relayUrl) {
    res.setHeader('Content-Type', 'text/xml');
    return res.status(200).send(
      `<?xml version="1.0" encoding="UTF-8"?><Response><Say>Sorry, this assistant isn't configured yet.</Say><Hangup/></Response>`
    );
  }

  const streamUrl = `${relayUrl}?callId=${encodeURIComponent(callId)}`;
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${streamUrl}" />
  </Connect>
</Response>`;

  res.setHeader('Content-Type', 'text/xml');
  return res.status(200).send(twiml);
}
