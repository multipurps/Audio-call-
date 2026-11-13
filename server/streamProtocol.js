// The phone provider's media WebSocket, seen from the relay. Twilio and Telnyx both send start / media / stop frames
// with base64 8 kHz mu-law audio, but the field names differ, so the relays go through these helpers and work with
// either one. The provider is detected from the start frame, so the relay needs no extra setting.
//
//   Twilio  start: { event:'start', start:{ streamSid, callSid, customParameters } }
//           send:  { event:'media', streamSid, media:{ payload } }   { event:'clear', streamSid }
//   Telnyx  start: { event:'start', stream_id, start:{ call_control_id, user_id, custom_parameters, media_format } }
//           send:  { event:'media', media:{ payload } }              { event:'clear' }   (no stream id)
//   Telnyx also sends a 'connected' frame first, plus 'mark', 'dtmf' and 'error' frames the relays ignore.

export function streamStart(msg) {
  if (msg?.event !== 'start') return null;
  const s = msg.start || {};
  if (msg.stream_id || s.call_control_id) {
    return {
      provider: 'telnyx',
      streamId: msg.stream_id || null,
      callSid: s.call_control_id || null,
      accountId: s.user_id || null, // Telnyx account id, used to hang up when TELNYX_ACCOUNT_ID is not set
      customParameters: s.custom_parameters || {},
    };
  }
  return { provider: 'twilio', streamId: s.streamSid || null, callSid: s.callSid || null, accountId: null, customParameters: s.customParameters || {} };
}

// The callee's audio as a Buffer, or null for anything else. Telnyx can also echo our own audio back as the
// 'outbound' track; that must never be treated as the callee speaking.
export function inboundAudio(msg) {
  if (msg?.event !== 'media' || !msg.media?.payload) return null;
  if (msg.media.track === 'outbound') return null;
  return Buffer.from(msg.media.payload, 'base64');
}

export function mediaMessage(provider, streamId, payloadBase64) {
  return provider === 'telnyx'
    ? { event: 'media', media: { payload: payloadBase64 } }
    : { event: 'media', streamSid: streamId, media: { payload: payloadBase64 } };
}

export function clearMessage(provider, streamId) {
  return provider === 'telnyx' ? { event: 'clear' } : { event: 'clear', streamSid: streamId };
}

// Twilio wants small ~20 ms frames. Telnyx accepts 20 ms to 30 s per message, so send fewer, larger ones.
export function outboundFrameSize(provider) {
  return provider === 'telnyx' ? 3200 : 160; // bytes of 8 kHz mu-law: 400 ms vs 20 ms
}
