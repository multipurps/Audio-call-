# Assistant service — deployment and testing

The Pipecat AI voice assistant lives in [`pipecat-service/`](../pipecat-service).
It is a **separate Render Web Service**. Nothing in the existing Twilio path,
the Vercel functions, or the MadelineProto integration was modified.

- Architecture and the inspection report: [AI-VOICE-ASSISTANT-REPORT.md](AI-VOICE-ASSISTANT-REPORT.md)
- Wire protocol reference: [ACAF-PROTOCOL.md](ACAF-PROTOCOL.md)
- PHP-side integration spec: [MP-RELAY-INTEGRATION.md](MP-RELAY-INTEGRATION.md)

---

## 1. Final architecture

```
                              ┌──────────────────────── Vercel (unchanged) ─────────┐
  Telegram app ◄──MTProto──►  │  api/*.js — auth, call control, Twilio REST,        │
        ▲                     │  Supabase. Issues the HTTP request that starts a    │
        │ Opus/48k            │  call. NEVER carries live audio.                    │
        │                     └─────────────────────────────────────────────────────┘
        │
  ┌─────┴────────────────────── Render: mp-relay (PHP, separate repo) ──────────────┐
  │  MadelineProto v8  — login (done today) + call transport (to be added)          │
  │  Pure-PHP libtgvoip + pure-PHP OGG Opus muxer                                   │
  │                                                                                 │
  │  VoIP::setOutput(writableStream)  ── inbound caller audio ────┐                 │
  │  VoIP::play(readableStream)       ◄── outbound assistant audio─┘                │
  │                                                               │                 │
  │  ACAF adapter: PCM16 @ 16 kHz, 28-byte header per frame        │                │
  └───────────────────────────────────────────────────────────────┼─────────────────┘
                                                                  │
                                            wss://  ACAF bridge  │  (private, secret-authed)
                                                                  ▼
  ┌──────────────────────── Render: pipecat-service (this PR) ──────────────────────┐
  │  FastAPI  /stream (ACAF)   /healthz   /readyz                                   │
  │                                                                                 │
  │  AcafBridge ── TelegramFrameSerializer ── Pipecat Pipeline                      │
  │    handshake, heartbeat,      ACAF ◄─► Pipecat frames      transport.input()    │
  │    backpressure, session                                   → VAD + turn detect  │
  │    lifecycle, teardown                                     → STT (Groq Whisper)│
  │                                                            → context + memory  │
  │                                                            → LLM (replaceable) │
  │                                                            → Fish Audio TTS    │
  │                                                            → transport.output()│
  │                                                                                 │
  │  CallSession: heartbeats, idle/max-duration timeouts, reconnect grace,          │
  │              barge-in cancellation, structured logs with secret redaction      │
  └─────────────────────────────────────────────────────────────────────────────────┘

  ┌── Twilio (unchanged) ──────────────────────────────────────────────────────────┐
  │  Twilio REST → api/calls-twiml.js → <Connect><Stream> → RELAY_WS_URL →          │
  │  server/patter-relay.js (Patter) — still the production Twilio path.           │
  │  Pipecat's TwilioFrameSerializer is available for a later unification;          │
  │  see Known limitations.                                                        │
  └────────────────────────────────────────────────────────────────────────────────┘
```

### Request path for a Telegram call

1. Browser → Vercel `api/social-calling.js?action=call` (unchanged).
2. Vercel → mp-relay `POST /calls` with the shared secret (new endpoint).
3. mp-relay dials Telegram via MadelineProto and opens the ACAF WebSocket to
   this service, sending `{"type":"hello", ...}`.
4. Audio flows **only** between mp-relay and this service. Vercel is not involved.
5. On hangup, `{"type":"hangup"}`; this service stops the pipeline and closes
   the session. mp-relay discards the Telegram call.

### Why the audio path bypasses Vercel entirely

Vercel functions are request/response and cannot hold a socket open for the
duration of a call. Routing audio through them would add a serverless
cold-start to every frame and has no benefit — the browser never needs to
touch call audio at all.

---

## 2. Files changed

**Nothing existing was modified except `.env.example`.** No file under `api/`,
`lib/`, `server/`, `server-social/`, `app.js`, or `index.html` was touched.

| File | Purpose |
| --- | --- |
| `.env.example` | *Modified.* Added the assistant service block; also added `MP_RELAY_URL`, `MP_RELAY_INTERNAL_SECRET`, `WACALLS_RELAY_URL`, `WACALLS_INTERNAL_SECRET`, and the `SUPABASE_DB_*` vars, which code referenced but the file never documented. |
| `docs/AI-VOICE-ASSISTANT-REPORT.md` | Inspection report: the ten answers, dependency report, codec table. |
| `docs/ASSISTANT-DEPLOYMENT.md` | This file. |
| `docs/ACAF-PROTOCOL.md` | Wire protocol reference. |
| `docs/MP-RELAY-INTEGRATION.md` | PHP-side spec + reference adapter for the mp-relay PR. |
| `pipecat-service/app/protocol.py` | ACAF v1 frame + control-message codec, sequence tracking. |
| `pipecat-service/app/audio.py` | G.711 mu-law, PCM16 helpers, stateful resampler, format descriptors. |
| `pipecat-service/app/config.py` | Env-driven settings, fail-fast validation, redacted summary. |
| `pipecat-service/app/logging_setup.py` | JSON logs, secret redaction filter, `log_audio()` (metadata only). |
| `pipecat-service/app/serializer.py` | `TelegramFrameSerializer` — Pipecat `FrameSerializer` over ACAF. |
| `pipecat-service/app/backpressure.py` | Bounded drop-oldest queue + adaptive frame skipping. |
| `pipecat-service/app/session.py` | `CallSession` / `SessionRegistry`: lifecycle, heartbeat, timeout, reconnect, reaping. |
| `pipecat-service/app/transport.py` | `AcafBridge`: handshake, auth, pump loops, teardown. |
| `pipecat-service/app/providers.py` | STT/LLM/TTS factories + working mock implementations. |
| `pipecat-service/app/pipeline.py` | Pipecat pipeline assembly, system prompt. |
| `pipecat-service/app/main.py` | FastAPI app, `/healthz`, `/readyz`, `/stream`, graceful shutdown. |
| `pipecat-service/app/adapters/base.py` | `TransportAdapter` interface (`receiveAudio`/`sendAudio`/`stop`). |
| `pipecat-service/app/adapters/telegram.py` | Telegram ACAF adapter. |
| `pipecat-service/app/adapters/mock.py` | Self-driving synthetic call for local/test mode. |
| `pipecat-service/tests/` | 327 tests (see §6). |
| `pipecat-service/{requirements.txt,requirements-dev.txt,pyproject.toml,Dockerfile,render.yaml,README.md}` | Packaging and deployment. |

---

## 3. New dependencies

Runtime (`pipecat-service/requirements.txt`), all pinned:

| Package | Version | Why |
| --- | --- | --- |
| `pipecat-ai[fish,groq,openai,silero,websocket]` | `1.11.0` | The pipeline. Pinned exactly — Pipecat is pre-2.0 and its APIs have moved between releases. |
| `fastapi` | `0.141.1` | ACAF WebSocket + health endpoints. |
| `uvicorn[standard]` | `0.53.0` | ASGI server. |
| `loguru` | `0.7.3` | Logging (Pipecat uses it too). |

Test-only (`requirements-dev.txt`): `pytest` 9.1.1, `pytest-asyncio` 1.4.0, `httpx` 0.28.1.

**Deliberately not installed:** no Opus codec, no FFmpeg, no libopus, no
libgmp, no `ext-ffi`, no numpy/scipy in first-party code, no Twilio SDK. The
reasoning is in `pipecat-service/requirements.txt`; the short version is that
all codec work belongs on the PHP side, which already has it.

---

## 4. Environment variables

### This service (Render: `audio-call-assistant`)

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `PORT` | injected by Render | `8080` | |
| `ASSISTANT_BRIDGE_SECRET` | **yes** | — | Shared with mp-relay. Min 16 chars. Generate: `python -c "import secrets;print(secrets.token_urlsafe(32))"` |
| `GROQ_API_KEY` | yes (if STT or LLM is groq) | — | |
| `FISH_API_KEY` | yes (if TTS is fish) | — | Server-side only; never sent to the browser. |
| `ASSISTANT_STT_PROVIDER` | no | `groq` | `groq` \| `mock` |
| `ASSISTANT_LLM_PROVIDER` | no | `groq` | `groq` \| `openai` \| `mock` |
| `ASSISTANT_TTS_PROVIDER` | no | `fish` | `fish` \| `mock` |
| `ASSISTANT_STT_MODEL` | no | `whisper-large-v3-turbo` | |
| `ASSISTANT_LLM_MODEL` | no | `llama-3.3-70b-versatile` | |
| `ASSISTANT_LLM_BASE_URL` | no | provider default | Override for a self-hosted OpenAI-compatible endpoint. |
| `ASSISTANT_LLM_TEMPERATURE` | no | `0.7` | |
| `ASSISTANT_LLM_MAX_TOKENS` | no | `200` | Keeps replies short. |
| `ASSISTANT_TTS_VOICE_ID` | no | Fish default | Per-user voice comes from `voice_profiles.provider_voice_id` at call setup. |
| `ASSISTANT_TTS_MODEL` | no | Fish default | e.g. `s1`. |
| `ASSISTANT_BRIDGE_SAMPLE_RATE` | no | `16000` | PCM16 rate on the bridge. Must match mp-relay. |
| `ASSISTANT_IDLE_TIMEOUT_SECS` | no | `30` | Silence before the session is reaped. |
| `ASSISTANT_HEARTBEAT_INTERVAL_SECS` | no | `10` | |
| `ASSISTANT_OUTBOUND_QUEUE_MAX_FRAMES` | no | `100` | Backpressure bound. |
| `ASSISTANT_MAX_CALL_SECONDS` | no | `1800` | Hard ceiling per call. |
| `ASSISTANT_MAX_SILENT_TURNS` | no | `3` | |
| `ASSISTANT_GREETING` | no | time-of-day default | |
| `ASSISTANT_SYSTEM_PROMPT` | no | built-in prompt | Overrides the conversational prompt. |
| `ASSISTANT_ENABLE_PERSISTENT_MEMORY` | no | `false` | Explicit flag. Requires Supabase vars. |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | only if persistent memory is on | — | |
| `ASSISTANT_MOCK_MODE` | no | `false` | No provider keys, no network. |

### mp-relay (new, for the PHP-side PR)

| Variable | Notes |
| --- | --- |
| `ASSISTANT_BRIDGE_URL` | e.g. `wss://audio-call-assistant.onrender.com/stream` |
| `ASSISTANT_BRIDGE_SECRET` | Must equal the value above. |
| `ASSISTANT_BRIDGE_SAMPLE_RATE` | Must equal the value above. |
| `MP_RELAY_INTERNAL_SECRET` | Already required; now documented. |
| `SUPABASE_DB_HOST` / `_PORT` / `_USER` / `_PASSWORD` / `_NAME` | MadelineProto's Postgres session store. |

**No secret is ever sent to the browser.** `/healthz` and `/readyz` report only
`"<set>"` / `"<unset>"` placeholders, and `tests/test_logging_and_config.py`
asserts this.

---

## 5. Render deployment

### This service

1. Render → **New → Web Service**, repo `multipurps/Audio-call-`.
2. **Root Directory:** `pipecat-service`
   **Runtime:** Python 3
   **Build Command:** `pip install -r requirements.txt`
   **Start Command:** `python -m app.main`
3. **Health Check Path:** `/healthz`
4. Plan: **must be always-on.** A free instance spins down; a cold start during
   a live call drops the call.
5. Set the env vars from §4. At minimum `ASSISTANT_BRIDGE_SECRET`,
   `GROQ_API_KEY`, `FISH_API_KEY`.
6. Deploy, then confirm `GET /readyz` returns `{"status":"ready", ...}`.

Or use the Blueprint: **New → Blueprint**, which reads
`pipecat-service/render.yaml`.

> **Private networking.** On a paid plan, Render exposes `*.internal` hostnames
> that are not reachable from the public internet. Prefer
> `ws://audio-call-assistant:8080/stream` from mp-relay over the public
> `wss://` URL. The bridge secret is the fallback control, not the primary one.

### mp-relay

Unchanged except for adding `ASSISTANT_BRIDGE_URL`, `ASSISTANT_BRIDGE_SECRET`
and `ASSISTANT_BRIDGE_SAMPLE_RATE`. Its existing Dockerfile
(`php:8.3-cli` + `gmp sockets pgsql pdo_pgsql`, no FFmpeg/libopus/FFI) is
already sufficient for this design, because all codec work stays in MadelineProto.

### Existing services

`server/` (Twilio/Patter) and `server-social/` are **not changed and not
redeployed**. Leave their dashboard configuration alone.

---

## 6. Local testing

### Run the test suite

```bash
cd pipecat-service
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt -r requirements-dev.txt
python -m pytest
```

Expected: **327 passed.**

No Telegram account, no Twilio account, no API keys, and no network access are
required — the defaults are mock-mode safe.

### Run the service locally

```bash
cd pipecat-service
ASSISTANT_MOCK_MODE=true python -m app.main
# then:
curl localhost:8080/healthz
curl localhost:8080/readyz
```

With `ASSISTANT_MOCK_MODE=true` no credentials are needed and
`/readyz` reports every provider as `mock`.

### Drive a call by hand

```bash
python - <<'PY'
import asyncio, json, struct, websockets

async def main():
    async with websockets.connect("ws://localhost:8080/stream") as ws:
        await ws.send(json.dumps({
            "type": "hello", "sessionId": "local-1", "platform": "telegram",
            "sampleRate": 16000, "channels": 1, "encoding": "pcm_s16le",
        }))
        print("handshake:", await ws.recv())

        # Send 20 ms of silence, then barge in.
        await ws.send(struct.pack("<4sBBBBIIQI", b"ACAF", 1, 1, 1, 1,
                                  16000, 0, 0, 320) + bytes(320))
        await ws.send(json.dumps({"type": "interrupt"}))
        await ws.send(json.dumps({"type": "hangup"}))
        print("closed cleanly")

asyncio.run(main())
PY
```

(`pip install websockets` if needed — it is already a Pipecat `[websocket]`
dependency.)

### What the 327 tests cover

| File | Covers |
| --- | --- |
| `test_audio.py` | mu-law against ITU-T reference vectors, round-trip, monotonicity, clipping; PCM16 framing; resampler continuity across frame seams; Telegram-48k ≠ Twilio-8k asserted as a test. |
| `test_protocol.py` | Frame encode/decode, header validation, truncation, uint32 wraparound, **frame ordering and missing-frame detection**. |
| `test_serializer.py` | ACAF ⇄ Pipecat frames both directions, resampling both directions, **interruption and TTS cancellation**, gap counting, hangup-once. |
| `test_backpressure.py` | Drop-oldest under overflow, memory-bound guarantee, adaptive skipping with hysteresis. |
| `test_session.py` | State machine, heartbeat, idle/max-duration timeout, reconnect grace, barge-in cancellation, idempotent teardown, registry reaping, graceful shutdown. |
| `test_logging_and_config.py` | **Secrets never reach a log** (including exception traces), **audio never reaches a log**, config fail-closed validation. |
| `test_adapters.py` | Interface contract, mock call produces audible (not silent) audio, barge-in cancellation, Telegram inbound/outbound, bounded inbound queue. |
| `test_integration_bridge.py` | **Full end-to-end WebSocket** against the real FastAPI app: handshake, auth accept/reject, audio flow, barge-in, heartbeat, cleanup, reconnect, `/healthz` + `/readyz`. |

---

## 7. Known limitations

**Stated plainly, because these are the things that will bite.**

1. **The Telegram call transport does not exist yet, and is not in this repo.**
   `telegramCall()` in `server-social/social-relay.js` sends a random `gAHash`,
   which can never complete a Diffie-Hellman exchange, so no Telegram call has
   ever carried audio. Building the transport inside MadelineProto is a
   prerequisite for anything here to be reachable from Telegram, and it lives
   in `multipurps/mp-relay` (PHP). See `docs/MP-RELAY-INTEGRATION.md`.
   Per your instruction, the broken stub was **left untouched**.

2. **The Pipecat pipeline has never carried a real call.** It is assembled and
   unit-tested, and the transport around it is integration-tested end to end,
   but the `stt → llm → tts` chain has not been exercised against live
   providers. Treat first-call testing as required, not optional.

3. **Opus is not decoded here.** Pipecat 1.11 ships no Opus decoder (verified:
   `pipecat/audio/utils.py` exposes only mu-law, A-law and WAV). Telegram's
   Opus must therefore be decoded on the PHP side, and `app/serializer.py`
   refuses Opus frames with a clear log rather than failing silently per frame.

4. **Pipecat's own streaming resampler is not used.** Measured: fed 20 ms
   telephony frames, `create_stream_resampler()` (soxr) returns 0 bytes for
   ~6 frames, then a 3 KB burst. That is ~120 ms of dead air and bursty output
   that breaks telephony frame cadence. `app/audio.py`'s deterministic
   resampler is used instead. Documented in `app/serializer.py`.

5. **No partial STT.** Your chosen default, Groq Whisper, is batch-only and
   cannot emit partial transcripts. The brief asked for partials "where
   supported"; this provider does not support them. The provider is
   env-swappable, so adding a streaming STT is a config-plus-adapter change.

6. **Twilio and Telegram run on two different pipelines today.** Twilio still
   runs through Patter (`server/patter-relay.js`), untouched. Pipecat ships a
   `TwilioFrameSerializer`, so unifying them is straightforward, but doing it
   would have meant changing a working production path, which your constraints
   forbid without explanation. Unification is the natural next step.

7. **Which Telegram call engine wins is unverified.** The current stub
   advertises `libraryVersions: ['4.0.0']`, `minLayer: 65`, `maxLayer: 92` —
   the legacy libtgvoip generation. MadelineProto v8 also has newer WebRTC
   engines, and the OGG-Opus-only restriction applies to the legacy engine for
   1:1 calls. The exact container a real call negotiates can only be
   confirmed against a live account.

8. **Concurrent-call capacity is per-instance and untested at scale.**
   `SessionRegistry` bounds sessions (`max_sessions=200`, not yet
   env-configurable) and refuses beyond that rather than degrading every call.
   No load test has been run.

9. **Persistent memory is a stub.** The flag exists, is off by default,
   validates its Supabase configuration, and `CallSession` tracks transcript
   *length* — but the Supabase read/write of memory content is not implemented.

10. **Tool calling is wired but has no tools.** `build_pipeline()` returns the
    LLM so tools can be registered, and no tools are registered by default,
    matching "tool calls only when tools are configured". The registration
    path itself is untested against a real provider.
