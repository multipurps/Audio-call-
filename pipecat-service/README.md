# Audio Call Assistant (Pipecat service)

The AI voice assistant that answers live Telegram calls. A separate Render Web
Service — it does not replace or modify the MadelineProto integration, the
existing Twilio relay, or the Vercel functions.

```
Telegram <-> MadelineProto (mp-relay, PHP) <--ACAF--> this service (Pipecat)
                                                  |
                              VAD -> STT -> LLM -> Fish Audio TTS
```

Live call audio never passes through Vercel.

## Documents

| Document | Contents |
| --- | --- |
| [`../docs/AI-VOICE-ASSISTANT-REPORT.md`](../docs/AI-VOICE-ASSISTANT-REPORT.md) | Inspection report, dependency report, the ten findings |
| [`../docs/ASSISTANT-DEPLOYMENT.md`](../docs/ASSISTANT-DEPLOYMENT.md) | Architecture, deployment, env vars, testing, limitations |
| [`../docs/ACAF-PROTOCOL.md`](../docs/ACAF-PROTOCOL.md) | Wire protocol reference |
| [`../docs/MP-RELAY-INTEGRATION.md`](../docs/MP-RELAY-INTEGRATION.md) | PHP-side spec + reference adapter |

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
python -m pytest          # 327 tests, no credentials required
```

## Layout

```
app/
  protocol.py        ACAF frame + control codec, sequence tracking
  audio.py           G.711 mu-law, PCM16 helpers, stateful resampler
  config.py          env-driven settings, fail-fast validation
  logging_setup.py   JSON logs, secret redaction, audio-safe logging
  serializer.py      ACAF <-> Pipecat frames (TelegramFrameSerializer)
  backpressure.py    bounded drop-oldest queue, adaptive skipping
  session.py         CallSession / SessionRegistry: lifecycle, heartbeat, reaping
  transport.py       AcafBridge: handshake, auth, pump loops, teardown
  providers.py       STT/LLM/TTS factories + mock implementations
  pipeline.py        Pipecat pipeline assembly
  main.py            FastAPI: /stream, /healthz, /readyz, graceful shutdown
  adapters/
    base.py          TransportAdapter interface (receiveAudio/sendAudio/stop)
    telegram.py      Telegram ACAF adapter
    mock.py          self-driving synthetic call
tests/               327 tests
```

## Two design decisions worth knowing before editing

**The bridge carries PCM16, not Opus.** Pipecat 1.11 has no Opus decoder, and
MadelineProto already carries a pure-PHP OGG Opus muxer. Decoding on the PHP
side keeps a Telegram-specific codec out of the Pipecat process and keeps a
native libopus build out of this image. See `app/serializer.py`.

**Pipecat's streaming resampler is not used on the audio path.** Measured:
fed 20 ms telephony frames, `create_stream_resampler()` returns 0 bytes for
~6 frames then bursts ~3 KB. That is ~120 ms of dead air and output that breaks
telephony frame cadence. `app/audio.py`'s deterministic resampler is used
instead. The measurement is recorded in `app/serializer.py`.

## Not production-verified yet

The pipeline has never carried a real call, because the Telegram call transport
does not exist yet (it lives in `multipurps/mp-relay`, PHP). See
"Known limitations" in [`../docs/ASSISTANT-DEPLOYMENT.md`](../docs/ASSISTANT-DEPLOYMENT.md).
