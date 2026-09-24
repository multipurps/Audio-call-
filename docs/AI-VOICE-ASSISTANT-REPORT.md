# Architecture + Dependency Report — Mitra-like AI voice assistant

Status: **blocking discrepancy found.** Read section 1 before any code is written.

Produced from a full read of this repository plus its sibling repos
(`multipurps/mp-relay`, `multipurps/WaCalls`). Nothing below is assumed;
every claim cites a file, a line, or a package.

---

## 1. Blocking finding — there is no Telegram call audio to integrate with

The brief says: *"Preserve the existing Telegram VoIP/tgvoip audio-call
implementation"* and *"Stop and ask for clarification if the current Telegram
audio implementation is incompatible with streaming audio."*

The current Telegram audio implementation is not **incompatible** — it is
**absent**. There is no Telegram call transport anywhere in the codebase, so
there is no place for Pipecat to plug into yet.

Evidence:

| Claim | Evidence |
| --- | --- |
| No PHP in this repo | No `*.php`, `composer.json`, or `composer.lock` exists |
| No MadelineProto in this repo | `grep -ri madeline` matches only two *comments* (`api/social-calling.js`, `lib/mpRelayClient.js`) explaining that it lives in an external service |
| No tgvoip anywhere | `grep -ri tgvoip` → zero matches in the whole repo |
| Telegram call-placing is knowingly broken | `server-social/social-relay.js` `telegramCall()` sends `gAHash: crypto.randomBytes(256)`. `g_a_hash` must be `SHA-256(g_a)` for a real Diffie-Hellman exchange. Random bytes can never complete one. Its own comment says *"NEEDS LIVE VERIFICATION"* and *"could never have worked"* |
| No call acceptance path at all | There is no `phone.acceptCall`, `phone.confirmCall`, `phone.sendSignalingData`, or `updatePhoneCall` handling anywhere |
| No audio layer | No FFmpeg, Opus, FFI, or native audio binding is installed or imported anywhere |
| The MadelineProto service only does login | `mp-relay/public/index.php` implements exactly four routes: `/sessions/{id}/start`, `/verify`, `/2fa`, `/status`, plus `DELETE /sessions/{id}`. Its own header comment: *"This file handles login only… Call-placing is intentionally a separate, later piece of work"* |

**Consequence:** the entire pipeline — inbound audio, VAD, STT, LLM, TTS,
outbound audio — has no Telegram transport to attach to. Building Pipecat
first would produce a service with nothing connected to it. The Telegram call
transport has to be built first, and it cannot be built in this repository,
because MadelineProto lives in `multipurps/mp-relay` (PHP).

The good news is that this is very achievable, and the MadelineProto version
already in use has exactly the hooks needed (section 8).

---

## 2. Answers to the ten inspection questions

### 1. Exact MadelineProto version

**`danog/madelineproto: ^8`** (PHP `>=8.2`), from `multipurps/mp-relay`'s
`composer.json`. The installed minor/patch is not pinned — `^8` floats, and
there is no `composer.lock` in that repo, so the resolved version differs by
build. For a reproducible deployment this should be pinned.

### 2. Exact Telegram VoIP implementation currently used

In this repo: **GramJS** (`telegram@^2.22.2`), in `server-social/social-relay.js`.
It calls the raw TL method `Api.phone.RequestCall` and stops there.

GramJS does **not** implement the Telegram call audio protocol. It generates
the `phone.*` API bindings from the TL schema but has no key exchange, no
signalling loop, and no media transport. The Node ecosystem's only real option
is `tgcallsjs` + `gram-tgcalls`, whose last GramJS-compatible release is
**2.5.0** — this repo is on `^2.22.2`, so that pairing cannot work. `tgcallsjs`
is also built for group voice chats, not 1:1 end-to-end calls.

So the answer is: **the current Telegram VoIP implementation is a stub that
issues one request and produces no audio.** This is a real Telegram call
*request*, not a real call.

### 3. tgvoip / php-libtgvoip / FFI / native extensions / FFmpeg / Opus / WebSockets

| Layer | Present in this repo? | Detail |
| --- | --- | --- |
| tgvoip / libtgvoip | **No** | zero matches |
| php-libtgvoip | **No** | no PHP at all here |
| FFI (`ext-ffi`) | **No** | not installed, not used |
| FFmpeg | **No** | never invoked |
| Opus (any binding) | **No** | no `opusscript`, `node-opus`, `@discordjs/opus`, `libopus` |
| Native extensions | **`@roamhq/wrtc@^0.10.0`** as an `optionalDependency` only, lazily imported by `initiateCall()` in the Baileys path |
| WebSockets | **`ws@^8.18.0`**, used only in `server/relay.js` for Twilio Media Streams |
| Audio codec work | Twilio mulaw only: base64 in/out, 20 ms / 160-byte framing, `wrapPcm16InWav()`, and a `mulawToWav()` that is an unimplemented passthrough stub |

`@roamhq/wrtc` is effectively **vestigial**: it exists for the Baileys
WhatsApp call path, but WhatsApp calling was since moved out to the external
`WaCalls` service (`lib/wacallsClient.js`, `sql/012_wacalls.sql`).

### 4. Where Telegram call audio enters the backend

**Nowhere.** There is no inbound Telegram audio path. The only audio that
enters any backend is Twilio's, at `server/relay.js` / `server/patter-relay.js`
via the Media Streams WebSocket.

### 5. Where Telegram call audio is sent back to the user

**Nowhere.** No outbound Telegram audio path exists.

### 6. Audio codec, sample rate, channel count, frame size at each boundary

Telegram boundaries are undefined, because they do not exist. For completeness,
the boundaries that *do* exist:

| Boundary | Encoding | Rate | Channels | Frame | Container |
| --- | --- | --- | --- | --- | --- |
| Twilio → relay WS | `mulaw`, base64 | 8000 Hz | 1 | 20 ms / 160 B | JSON `media` events |
| relay → Groq Whisper | PCM16 in WAV | 8000 Hz | 1 | whole utterance | WAV via `wrapPcm16InWav()` |
| LLM → Fish Audio | `format: 'mulaw'` | 8000 Hz (Fish default) | 1 | whole response | raw body |
| Fish Audio → Twilio | `mulaw` | 8000 Hz | 1 | 20 ms / 160 B | JSON `media` events |
| Patter pipeline | PCM16 @ 8 kHz in, TTS opus/pcm out | 8000 Hz | 1 | Patter-managed | Patter-managed |
| `api/assistant.js` `speakText` | `format: 'mp3'` | n/a | 1 | whole response | base64 in JSON to the **browser** |
| **Telegram (either direction)** | **undefined — does not exist** | — | — | — | — |

Two things worth flagging from this table:

- The Fish Audio `mulaw` output is assumed to be 8 kHz. Nothing verifies it.
  The brief says *"Do not assume sample rate or codec compatibility"* — the
  existing Twilio path breaks that rule. The Fish Audio API accepts a
  `sample_rate` parameter; the existing calls never set it.
- `mulawToWav()` in `server/relay.js` returns its input unchanged. The
  newer `patter-relay.js` fixes this with a real WAV header, which is why
  Patter is the start script and `relay.js` is legacy.

### 7. Existing Fish Audio integration

Working, HTTP (non-streaming), key `FISH_API_KEY`, all four call sites
server-side:

- `api/assistant.js` `speakText()` → `POST https://api.fish.audio/v1/tts`, `model: s1`, `format: 'mp3'`, returns base64 to the browser.
- `api/voice-clone.js` → `POST https://api.fish.audio/model` (create), voice preview via `/v1/tts`, `DELETE /model/{id}`.
- `server/patter-relay.js` `FishAudioTelephonyTTS` → `/v1/tts` with `format: 'mulaw'`, duck-typed `setTelephonyCarrier()` so Patter forwards bytes unmuxed.
- `server/relay.js` → same, `format: 'mulaw'`.

Voice identity is per-user: `voice_profiles.provider_voice_id` (Fish `reference_id`),
used only when `status === 'ready'`.

**No streaming TTS and no Fish WebSocket usage exists today.** This is a gap
the brief asks to close.

### 8. Existing Twilio / WhatsApp integration

- **Twilio outbound**: `api/calls.js`, `api/assistant.js` → Twilio REST `Calls.json`, with `MachineDetection: 'Enable'`.
- **Twilio voicemail guard**: `api/calls-twiml.js` reads `AnsweredBy` and hangs up before the relay is ever reached.
- **Twilio Media Streams**: `api/calls-twiml.js` emits `<Connect><Stream url="${RELAY_WS_URL}?callId=...">`. Consumed by `server/patter-relay.js` (Patter, `start`) or legacy `server/relay.js`, both via `ws`.
- **Twilio inbound**: `api/calls-incoming.js` → TwiML.
- **Twilio per-user numbers**: `api/call-answering.js` (buy/release/repoint).
- **WhatsApp**: `lib/wacallsClient.js` → external Go service `multipurps/WaCalls` (`WACALLS_RELAY_URL`), contacts only reachable over the WaCalls mirror via `contacts` → `whatsapp_accounts.wacalls_session_id`. No WhatsApp audio ever touches this repo.
- Media Streams lives in Patter, not a first-party adapter — Patter owns the mulaw↔PCM16 decode, framing, and VAD. That matters for the plan in section 9: **there is no first-party Twilio serializer here to reuse.**

### 9. Render start command, runtime, native deps, env vars

There is **no `render.yaml`, `Dockerfile`, or `Procfile` in this repo** — Render
config is entirely dashboard-side. Two services, both defined only by their
`package.json`:

| Service | Root dir | Build | Start | Runtime | Port |
| --- | --- | --- | --- | --- | --- |
| Twilio relay | `server` | `npm install` | `npm start` → `node patter-relay.js` | Node, ESM (`"type": "module"`) | `PORT`, default 8080 |
| Social relay | `server-social` | `npm install` | `npm start` → `node social-relay.js` | Node, ESM | `PORT`, default 8081 |

Third service, separate repo: **`mp-relay`** (MadelineProto) — `php -S 0.0.0.0:${PORT:-10000}`
in a `php:8.3-cli` image, extensions `gmp sockets pgsql pdo_pgsql`, `composer install --no-dev`.

Native/OS dependencies currently required:

- `server-social`: `@roamhq/wrtc` native build (optional dep), `big-integer`, `qrcode`, `@queenanya/baileys` from a GitHub URL.
- `mp-relay`: `libgmp`, `libpq`, plus PHP `sockets`. **No FFmpeg, no libopus, no FFI** — which matters, see section 8.
- Neither `server` nor `server-social` has a health endpoint. Only `mp-relay` originally did, and it was removed (commit `5a4f877`); `server-social` still has `GET /healthz`.

Every env var referenced by code (complete list, `grep`-derived, nothing invented):

```
SUPABASE_URL  SUPABASE_SERVICE_ROLE_KEY  PUBLIC_APP_URL  ADMIN_EMAIL
TWILIO_ACCOUNT_SID  TWILIO_AUTH_TOKEN  TWILIO_FROM_NUMBER
FISH_API_KEY  GROQ_API_KEY  FAL_KEY
RELAY_WS_URL  RENDER_EXTERNAL_URL  PORT
SOCIAL_RELAY_URL  SOCIAL_RELAY_INTERNAL_SECRET  SOCIAL_SESSION_ENC_KEY
MP_RELAY_URL  MP_RELAY_INTERNAL_SECRET      <-- not in .env.example
WACALLS_RELAY_URL  WACALLS_INTERNAL_SECRET  <-- not in .env.example
TELEGRAM_API_ID  TELEGRAM_API_HASH  WHATSAPP_CALLING_ENABLED
VAPID_PUBLIC_KEY  VAPID_PRIVATE_KEY  VAPID_SUBJECT
```

`.env.example` is missing `MP_RELAY_URL`, `MP_RELAY_INTERNAL_SECRET`,
`WACALLS_RELAY_URL`, `WACALLS_INTERNAL_SECRET`, and the `SUPABASE_DB_*` vars
`mp-relay` needs.

### 10. Render Web Service, Background Worker, or both?

**Both are Render Web Services.** Both bind `PORT` and call `app.listen()` /
`patter.serve()`; neither is a Background Worker. This matters twice:

- **Long-lived WebSockets are already fine.** Render Web Services support
  them; `server/relay.js` has depended on that since day one. No worker is needed for Pipecat.
- **Web Services spin down on the free tier after inactivity.** A cold start
  mid-call is fatal. Any service holding live call audio needs an always-on
  instance — worth confirming the current plan.

---

## 3. Dependency report (current state)

```
server/                      server-social/                 mp-relay/ (separate repo)
  @supabase/supabase-js ^2.45  @supabase/supabase-js ^2.45     php >=8.2
  getpatter ^0.7.0             express ^4.19.2                 danog/madelineproto ^8
  ws ^8.18.0                   telegram ^2.22.2
                               big-integer ^1.6.52
                               @queenanya/baileys (github:)
                               qrcode ^1.5.4
                               @roamhq/wrtc ^0.10.0  (optional)
```

Nothing in this tree can carry Telegram call audio. Notably absent, and needed:
an Opus codec binding, FFmpeg, and (if the bridge is built in PHP) `ext-ffi`.

---

## 4. Smallest safe integration point

`lib/mpRelayClient.js` is already the one and only seam between this repo and
the MadelineProto service: HTTP + `X-Internal-Secret`, called from
`api/social-calling.js`, with a documented `AbortSignal.timeout(35_000)`.

**The smallest safe integration point is a new sibling of that seam** — a
per-call control-plane call from `api/social-calling.js` into `mp-relay`
(`POST /calls`, `DELETE /calls/{id}`), while the audio itself never goes
through Vercel at all. This:

- adds no new credential path;
- reuses the existing shared-secret auth model verbatim;
- leaves `server/patter-relay.js`, `server/relay.js`, `api/*.js` and both
  Vercel functions untouched, so Twilio cannot regress;
- keeps Telegram-specific logic out of Pipecat, satisfying the brief's adapter rule.

The audio-plane bridge (section 5) is a *separate*, additive connection between
`mp-relay` and the Pipecat service. It is not a replacement for anything.

---

## 5. Why Pipecat cannot run inside the current process

- Pipecat is Python. `mp-relay` is PHP. There is no practical in-process story.
- Even in principle, `mp-relay` is served by `php -S`, PHP's single-threaded
  development server, and is **stateless per request** by design — its own
  comment notes an active call *"needs a connection that stays alive for its
  duration, which is a genuinely different request model than this stateless
  login flow."*
- `mp-relay`'s image installs no FFmpeg, no libopus and no `ext-ffi`.

So: **a separate Python Pipecat service on Render**, reached over a persistent
low-latency WebSocket. This is exactly the fallback the brief pre-authorises.

### MadelineProto v8 makes the bridge buildable

This is the key enabling fact, from MadelineProto's own calls documentation:

- **Inbound audio**: `$call->setOutput($stream)` — *"`$stream` can also be a
  `WritableStream`. Can be used to pipe OGG OPUS audio data to ffmpeg,
  asterisk via **amphp/process, amphp/socket**, etc."*
- **Outbound audio**: `play()` accepts a `ReadableStream`, which the
  maintainer confirms can be *"a TCP/UDP socket or any other kind of stream
  supported by amphp."*
- MadelineProto v8 ships a **pure-PHP libtgvoip reimplementation plus a pure-PHP
  OGG Opus muxer/demuxer**, so it runs without the old `php-libtgvoip`
  extension. Real-time conversion of arbitrary formats additionally wants
  `ffmpeg` + `libopus` + `ext-ffi`, but that is for *transcoding*, not for
  carrying a stream.

So both directions map onto an amphp socket to Python. **The wire format on
that socket is OGG Opus in both directions**, which is the one hard constraint
the brief's "normalized audio frames" idea has to accommodate — see below.

### Transport adapter interface

```
receiveAudio(): stream of normalized audio frames   -> VoIP::setOutput(writableStream)
sendAudio(frame): frames back to Telegram           -> VoIP::play(readableStream)
stop(): close the call cleanly                      -> VoIP::discard/end + close socket
```

Implemented in PHP (the only place that can see a `VoIP` object), exposing
Pipecat-agnostic primitives. Pipecat sees frames and a socket, never Telegram.

---

## 6. Proposed wire protocol (PHP ⇄ Python)

Control plane is JSON text frames. Audio is binary frames with a fixed header,
as the brief requires `sessionId seq timestamp rate channels encoding payload`:

```
offset  size  field
0       4     magic 'ACAF'
4       1     version (=1)
5       1     type      1=audio.in 2=audio.out 3=partial_transcript 4=interrupt
6       1     encoding  1=ogg_opus 2=pcm_s16le 3=mulaw
7       1     channels
8       4     sample_rate   uint32 LE
12      4     sequence      uint32 LE
16      8     timestamp_ms  uint64 LE
24      4     payload_len   uint32 LE
28      N     payload
```

`sessionId` lives in the JSON `hello` handshake rather than every audio frame,
so per-frame overhead stays at 28 bytes. JSON control messages: `hello`,
`ready`, `interrupt`, `hangup`, `ping`, `pong`, `error`, `metrics`.

Required behaviours, per the brief: monotonic sequence numbers with gap
detection, heartbeat, idle timeout, reconnect with session resume, bounded
outbound queue with `drop-oldest` backpressure, and session teardown that
always closes cleanly.

**Never through Vercel.** Audio goes `mp-relay ⇄ pipecat-service` directly.
Vercel keeps only the existing request/response role.

---

## 7. Codec reality at each boundary

| Boundary | Format | Note |
| --- | --- | --- |
| Telegram ⇄ MadelineProto | OGG Opus, 48 kHz mono, 20 ms frames | libtgvoip's native rate; the legacy engine accepts **only** OGG Opus produced by MadelineProto/@libtgvoipbot unless realtime conversion is available |
| MadelineProto ⇄ bridge | OGG Opus, verbatim relay | PHP does no audio processing — no FFmpeg/FFI needed |
| Bridge ⇄ Pipecat | OGG Opus decoded to PCM by Pipecat | Pipecat's pipeline rate |
| Pipecat ⇄ Fish Audio | **`FishAudioTTSService`**, WebSocket streaming, `output_format` ∈ `pcm`/`opus`/`mp3`/`wav` | a first-class Pipecat service — do not hand-roll |
| Fish Audio ⇄ Pipecat | Pipecat resamples | |
| Pipecat ⇄ Twilio | PCM → mulaw 8 kHz, base64, 20 ms | Pipecat `TwilioFrameSerializer`; Viaduct note in section 9 |
| Pipecat ⇄ Telegram | PCM → OGG Opus 48 kHz mono → PHP → `play()` | |

The brief's warning *"Do not assume sample rate or codec compatibility"* is
exactly right here: Telegram is 48 kHz Opus, Twilio is 8 kHz mulaw. They share
the Pipecat pipeline only *after* normalization, each behind its own serializer.

---

## 8. One hard constraint to design around

MadelineProto negotiates a call engine based on the `libraryVersions` the peer
accepted. The current stub advertises `libraryVersions: ['4.0.0']` with
`minLayer: 65, maxLayer: 92` — the legacy libtgvoip generation. Current
MadelineProto v8 has both a legacy libtgvoip engine and newer WebRTC engines
(`tgcalls` InstanceV2Impl dialects, php-rtc), and the OGG-Opus-only restriction
applies to the **legacy** engine for 1:1 calls.

This means the exact outbound container (OGG Opus vs WebM/OGG) depends on which
engine a real call negotiates, and that can only be settled against a live
Telegram account. Same class of unverifiable-from-static-review risk the
existing code already flags for itself — but it is a risk to plan for, not a
reason to guess.

---

## 9. Twilio must keep working — and currently has no first-party adapter

Twilio Media Streams is not implemented in this repo; **Patter owns it**.
`server/patter-relay.js` hands Patter the mulaw bytes and Patter does decode,
framing, VAD and turn-taking.

So the brief's *"keep Twilio Media Streams in its own adapter, reuse the same
Pipecat pipeline after normalizing audio"* is achievable but implies one of:

1. Build a first-party Twilio serializer + transport in the Pipecat service
   and point `RELAY_WS_URL` at it, retiring `patter-relay.js`; or
2. Leave Patter as the production Twilio path and treat the Pipecat Twilio
   adapter as the second consumer, verified in local/mocked mode only.

Option 1 gives one shared pipeline as the brief asks, and Pipecat ships a
`TwilioFrameSerializer` so the work is small — but it **changes a working
path**, which the brief forbids without explanation. This needs a decision.

---

## 10. Testing reality check

**There are no tests in this repository.** No test files, no `test` script in
any `package.json`, no Jest/Vitest/Pytest config. The brief's step 1 ("run the
existing tests before changing anything") has nothing to run.

`docs/` and a test framework therefore both need to be introduced from
scratch. Any harness must be able to run with no Telegram account, no Twilio
account, and no provider keys — the brief's mocked/local modes.

---

## 11. What is verified vs. what needs a live account

**Verified by reading source:** the full current architecture; every env var;
both Render start commands; that no Telegram audio path exists; that the
`gA_hash` stub cannot work; that MadelineProto is `^8` and does login only;
that Pipecat ships `FishAudioTTSService`, `FastAPIWebsocketTransport`,
`FrameSerializer` and `TwilioFrameSerializer`.

**Cannot be verified without a live account** (state plainly, do not paper over):
whether a negotiated real call accepts streamed OGG Opus on `play()`; which
call engine wins; actual two-way audio quality and barge-in latency on a real
Telegram call; and whether the deployed Render plan is always-on.

---

## 12. Decisions needed before implementation

1. **Where does the Telegram call transport get built?** It must be where
   MadelineProto is: `multipurps/mp-relay`.
2. **What happens to the broken `telegramCall()`** in `server-social/social-relay.js`
   and the `/telegram/call` route in `api/social-calling.js`?
3. **Default LLM provider/model?** (`GROQ_API_KEY` exists; `FAL_KEY` +
   `gpt-4o-mini` also exists. Brief requires env-driven and replaceable either way.)
4. **Default STT?** Groq Whisper is batch-only and cannot emit partial results,
   so it cannot satisfy *"partial STT results where supported"* on its own.
5. **Twilio: replace Patter, or keep it and add the Pipecat adapter alongside?**
