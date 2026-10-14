# Voice assistant service (Pipecat)

The real-time AI voice assistant behind Emysa's calls. It runs as a separate Render
Web Service and speaks the ACAF audio bridge protocol over a WebSocket (`/stream`),
with health checks at `/healthz` and `/readyz`. Call audio does not pass through Vercel.

## Documents

| Document | Contents |
| --- | --- |
| [`../docs/ASSISTANT-DEPLOYMENT.md`](../docs/ASSISTANT-DEPLOYMENT.md) | Architecture, deployment, environment variables, testing |
| [`../docs/ACAF-PROTOCOL.md`](../docs/ACAF-PROTOCOL.md) | Wire protocol reference |
| [`../docs/MP-RELAY-INTEGRATION.md`](../docs/MP-RELAY-INTEGRATION.md) | Telegram relay integration spec |
| [`../docs/AI-VOICE-ASSISTANT-REPORT.md`](../docs/AI-VOICE-ASSISTANT-REPORT.md) | Historical inspection report |

## Run it

```bash
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt -r requirements-dev.txt

# Local/mock mode: no credentials, no network, no real calls.
ASSISTANT_MOCK_MODE=true python -m app.main
curl localhost:8080/healthz
curl localhost:8080/readyz
```

## Test it

```bash
python -m pytest          # no credentials required
```

## Layout

```
app/
  main.py                FastAPI entrypoint: ACAF WebSocket bridge, health checks, shutdown
  protocol.py            ACAF v1 frame and control codec
  transport.py           ACAF bridge: one WebSocket connection per live call
  session.py             Per-call lifecycle: heartbeat, timeout, reconnect, cleanup
  serializer.py          ACAF <-> Pipecat frame serializer
  audio.py               Audio conversion primitives
  backpressure.py        Bounded outbound queue with drop-oldest backpressure
  config.py              Environment configuration
  logging_setup.py       Structured logging that does not leak audio or credentials
  providers.py           STT / LLM / TTS factories and mock implementations
  pipeline.py            Pipecat pipeline assembly
  live.py                Speech-to-speech call engine
  conversation.py        Conversation runner between the bridge and Pipecat
  conversation_policy.py Conversational behaviour policy
  call_context.py        Pre-call context and live persistence against the app database
  call_state.py          Call-attempt facts for the call context
  call_wrapup.py         Decides when a call should wrap up
  caller_state.py        Caller interaction state
  emotion.py             Emotional state tracking
  expressive_context.py  Expressive manner for the voice pipeline
  vocal.py               Contextual vocalisations and delivery markers
  global_config.py       Admin-controlled global AI guidance
  monitor.py             Live call monitoring for the signed-in app user
  app_call.py            Browser entry point for the in-app call
  prewarm.py             Startup work done at boot instead of during a call
  adapters/              Transport adapters (base interface, Telegram, mock)
tests/
```

## Design notes

The bridge carries PCM16 audio, and `app/audio.py` provides a deterministic
resampler used on the audio path instead of Pipecat's streaming resampler. The
reasoning and measurements are recorded in `app/serializer.py`.
