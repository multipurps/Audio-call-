# Emysa

Emysa — an Android/web AI phone-calling assistant, in the spirit of Mitra/Osmo: tell it
what you need done, it makes a real call, handles the conversation, and
reports back.

## Architecture

Three deployables:

1. **Web app** (`index.html`, `styles.css`, `app.js`, `api/*.js`) — a
   mobile-first PWA plus Vercel serverless functions (11 endpoints in `api/`,
   staying within the 12-function Vercel Hobby cap): auth, admin approval,
   contacts, voice cloning, call plans & confirmation, social calling
   (`WaCalls` for WhatsApp, `mp-relay` for Telegram), tiered memories, and
   call history. Deploys to Vercel.

2. **Twilio Relay Server** (`server/patter-relay.js` and `server/relay.js`) —
   persistent Node processes that Twilio's Media Streams WebSocket connects to
   for the live audio of an in-progress PSTN call. Uses GPT Luna (`gpt-6-luna`)
   via OpenAI's Chat Completions API (optional fal OpenRouter fallback),
   OpenAI transcription (`gpt-4o-mini-transcribe`) with a speech-vs-noise gate,
   Fish Audio TTS with per-call voice isolation, OpenFeelz-inspired emotional
   intelligence, and Letta-inspired 4-tier persistent memory.
   Groq was removed from every provider role (LLM, STT, vision, TTS was never
   Groq) — see `docs/CALL-SYSTEM-IMPLEMENTATION-REPORT.md`.

3. **Pipecat Voice Service** (`pipecat-service/`) — Python FastAPI + Pipecat
   real-time audio bridge used by `mp-relay` and WaCalls over the ACAF
   WebSocket protocol for Telegram/WhatsApp calling. Supports GPT Luna
   (`ASSISTANT_LLM_PROVIDER=luna`), OpenAI transcription
   (`ASSISTANT_STT_PROVIDER=openai`, `gpt-4o-mini-transcribe`), Fish Audio
   TTS, Silero VAD, emotional state tracking, and `[[END_CALL]]` call
   termination. It also resolves the app's `calls` row at call start (goal,
   memories, prior summaries), persists the live transcript per turn, and
   reports the call's end back so the shared summary runs.

## Emotional Intelligence & Persistent Memory

- **GPT Luna Primary LLM (`lib/llmClient.js`, `pipecat-service/app/config.py`)**:
  Defaults to `gpt-6-luna` via `LUNA_API_KEY` / `OPENAI_API_KEY`, with an
  optional Fal OpenRouter fallback (`FAL_KEY`). There is no Groq endpoint any
  more: `LLM_PROVIDER=groq` resolves to the OpenAI primary rather than
  silently targeting a removed provider.
- **OpenFeelz-Inspired Emotional State (`lib/emotionEngine.js`, `pipecat-service/app/emotion.py`)**:
  Models OCEAN personality traits, continuous PAD (Pleasure, Arousal, Dominance)
  + relational dimensions (Connection, Curiosity, Energy, Trust), exponential
  time decay toward personality baseline, and a multi-stage rumination buffer
  with zero extra LLM calls per turn.
- **Letta-Inspired 4-Tier Memory (`lib/memoryManager.js`, `api/memories.js`, `sql/016_memory_and_emotion.sql`)**:
  Separates memory into `working`, `semantic` (facts/preferences), `episodic`
  (call/chat summaries), and `emotional` (relationship notes) tiers stored in
  Supabase with hybrid relevance + recency + importance retrieval, contradiction
  resolution, and automatic secret/PII scrubbing.

## SQL Migrations

Run the SQL migrations in `sql/` in order against your Supabase project:
- `001_schema.sql` through `015_call_plans.sql` (`006_chat_sessions.sql` and
  `007_assistant.sql` are order-independent)
- `016_memory_and_emotion.sql` (adds tiered memory columns on `memories` and
  creates the `emotional_states` table with RLS policies)

## Design

Matches the visual language of `live-call`: same theme-variable system
(Coffee & Emerald / Midnight & Cyan / Forest & Gold), same floating
bottom-tab-bar pattern. Two explicit choices carried over from that app,
both intentional:

- No emoji anywhere in the UI.
- No `safe-area-inset` padding anywhere — the app bleeds edge to edge,
  including under the notch and home indicator. This is a deliberate
  tradeoff (some tap targets sit in the gesture zone) rather than an
  oversight.

## Setup

1. Create a Supabase project, run `sql/001_schema.sql`.
2. Enable Google as an auth provider in Supabase.
3. Set `SUPABASE_URL` / `SUPABASE_ANON_KEY` in `app.js`.
4. Deploy the root of this repo to Vercel; set the env vars in
   `.env.example` (Vercel section) in the project settings.
5. Deploy `server/` to Render as a background/web service; set the env
   vars in `.env.example` (relay section) there. Point `RELAY_WS_URL`
   (in Vercel) at its `wss://` URL.
6. Sign up in the app, then approve your own account directly in Supabase
   (`update user_approvals set approved = true where user_id = '...'`) —
   after that, sign in as `ADMIN_EMAIL` unlocks the admin endpoints for
   approving everyone else.

## Status

Initial scaffold: auth + approval gate, AI caller CRUD, voice cloning,
call initiation with usage limits, call history, and a working relay-server
skeleton with the full Twilio <-> OpenAI <-> Fish Audio loop wired up. Not yet
tuned against real calls: silence-detection timing in the relay, WAV framing
for OpenAI transcription, and the IVR/hold-music handling from the original spec
still need real-call testing before this is production-ready. Status of every
path (and what has NOT been verified on a real line) is tracked in
`docs/CALL-SYSTEM-IMPLEMENTATION-REPORT.md`.

Home screen is now a chat with the assistant ("Mitra"-style), not a raw
number composer: `contacts` (name -> phone number, managed from the Contacts tab) let you say "call Juicy Jay" instead of typing digits; `POST
/api/assistant?action=send` runs one LLM call (GPT Luna on OpenAI) to decide
call vs. retry vs. plain reply, then prepares a Phone call for explicit in-chat
confirmation; `api/calls-status.js` posts a
follow-up message (busy / no answer / finished) back into the same thread
once Twilio's status webhook fires, so the chat updates on its own while
you keep using the app. Voice input (the wave icon) records with
`MediaRecorder` and transcribes via OpenAI (`gpt-4o-mini-transcribe`) — the
same transcription API the relays use. All of this needs `OPENAI_API_KEY` (or
`LUNA_API_KEY`) set in the Vercel project (see `.env.example`) and
`sql/007_assistant.sql` run against Supabase
before it'll do anything; until then `api/assistant.js` replies with an
explicit "not configured yet" message instead of failing silently.

## Mobile navigation and call confirmation

The nav/call redesign reuses the existing PWA and provider integrations. Phone
calls now require a persisted script summary and an explicit **Call Now** action;
Home's **Call Emysa** uses a clearly labeled Twilio callback to the user's phone.

**Deployment requires `sql/015_call_plans.sql` and a relay redeploy.** See
[the redesign deployment and validation guide](docs/NAV-AND-CALL-REDESIGN.md)
for schema changes, callback semantics, API compatibility, and test commands.
