# Emysa audio path — what actually carries call audio

Written before any voice-changer code, by reading the existing implementation.
Every line reference below is to the code as of commit `46f2632`.

## There is no browser-side call audio today

The browser **never** touches the audio of a phone call. `getUserMedia` appears
in exactly two places in `app.js`, and neither is a call:

- `app.js:979` — `startAssistantListening()`, the Emysa chat call screen.
  `MediaRecorder` → `/api/assistant?action=transcribe` (Groq Whisper).
- `app.js:1795` — the home-screen wave button. Same MediaRecorder → Whisper path.

Both are record-then-upload. Nothing streams.

## The real outgoing track

A call is placed by Twilio, not by the browser:

```
api/calls.js:createCall        -> POST twilio Calls.json, Url=/api/calls-twiml?callId=…
api/calls-twiml.js             -> <Connect><Stream url="wss://RELAY_WS_URL?callId=…"/>
server/relay.js  wss.on('connection')   (line 36)   <- Twilio opens this WebSocket
```

**The exact outgoing audio track the remote caller hears is the `media` frame
loop at the bottom of `speak()` in `server/relay.js`:**

```js
// Twilio expects base64 mulaw in ~20ms (160-byte) frames.
const frameSize = 160;
for (let i = 0; i < audioBuf.length; i += frameSize) {
  const frame = audioBuf.subarray(i, i + frameSize);
  ws.send(JSON.stringify({
    event: 'media',
    streamSid: state.streamSid,
    media: { payload: frame.toString('base64') },
  }));
}
```

Format: **G.711 μ-law, 8 kHz, mono, 20 ms = 160 byte frames**, base64-encoded.
That is the single injection point for anything that needs to be heard by the
person on the other end of the line.

The matching inbound track is `relay.js:58`:

```js
if (msg.event === 'media') {
  state.audioChunks.push(Buffer.from(msg.media.payload, 'base64'));
  resetSilenceTimer(ws, state);
  return;
}
```

Inbound μ-law frames are buffered, then flushed on 700 ms of silence to
`handleTurn()` → Whisper STT → LLM → Fish TTS → `speak()`.

## So the two call modes differ exactly here

| | outgoing (caller hears) | inbound (user hears) |
|---|---|---|
| AI Voice | `speak()` — Fish TTS μ-law frames | nowhere; it goes to Whisper |
| Direct Voice | converted browser mic μ-law frames | forwarded to the browser, untouched |

Direct Voice must **not** run `resetSilenceTimer` / `handleTurn` (no STT, no
LLM, no TTS) and must **not** call `speak()`.

## Two relays exist

- `server/relay.js` — plain `ws` server, the one `RELAY_WS_URL` points at, the
  one `api/calls-twiml.js` and `api/calls-incoming.js` connect Twilio to.
  **This is the file that owns the track above.**
- `server/patter-relay.js` — a Patter-based rewrite (`server/package.json`
  `main`), which lets Patter own the Twilio media stream instead and uses its
  own webhook, not `RELAY_WS_URL`.

The voice-changer layer is integrated into `server/relay.js`, because that is
the process that actually holds the Twilio media socket the TwiML points at.
`patter-relay.js` is left untouched.

## Known pre-existing bug (not introduced here)

`relay.js:365` — `mulawToWav()` returns its input unchanged:

```js
function mulawToWav(mulawBuffer) {
  return mulawBuffer;
}
```

Whisper is being handed headerless μ-law with a `.wav` filename. Out of scope
for this change; noted so it isn't mistaken for something the voice-changer
work broke. `patter-relay.js` writes a real WAV header.

## w-okada/voice-changer integration surface

Verified against the upstream source (`w-okada/voice-changer`, master):

| What | Where | Shape |
|---|---|---|
| Realtime convert (REST) | `POST /test` (`server/restapi/MMVC_Rest_VoiceChanger.py`) | in `{"timestamp": int, "buffer": base64(int16 PCM)}` → out `{"timestamp", "changedVoiceBase64"}` |
| Realtime convert (Socket.IO) | namespace `/test`, event `request_message` (`server/sio/MMVC_Namespace.py`) | `[timestamp, int16 bytes]` → `response` `[timestamp, int16 bytes, perf]` |
| Server info / model list | `GET /info` (`MMVC_Rest_Fileuploader.py`) | `{status:"OK", modelSlots:[…], modelSlotIndex, inputSampleRate, outputSampleRate, gpus}` |
| Switch model | `POST /update_settings`, **form-encoded** | `key=modelSlotIndex&val=3` |
| Bypass conversion | `POST /update_settings` | `key=passThrough&val=true` |

Sample format is **int16 PCM**, and `VoiceChangerSettings` defaults to
`inputSampleRate = outputSampleRate = 48000` (`server/voice_changer/VoiceChanger.py`).
`changeVoice()` resamples from `inputSampleRate` to the model's own processing
rate internally, so callers only have to match 48 kHz.

`TrustedOriginMiddleware` (`server/restapi/mods/trustedorigin.py`) returns
HTTP 400 `"Invalid origin header"` for any request carrying an `Origin` not in
the allowlist. Relay→VC calls are server-to-server from Node, which sends no
`Origin`, so they pass; a browser calling the VC server directly would not,
which is the main reason the conversion runs in the relay.

One caveat worth stating plainly: `VoiceChangerManager` is a singleton holding
**one** active `modelSlotIndex`. A single w-okada server can therefore serve one
voice at a time. Multi-tenant deployments need one VC instance per active
voice; see `README.md` → Direct Caller Mode.
