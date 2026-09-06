# Emysa

Emysa — an Android/web AI phone-calling assistant, in the spirit of Mitra/Osmo: tell it
what you need done, it makes a real call, handles the conversation, and
reports back.

## Architecture

Two deployables:

1. **Web app** (`index.html`, `styles.css`, `app.js`, `api/*.js`) — a
   single-file-style PWA plus Vercel serverless functions for everything
   that's request/response: auth, admin approval, AI caller CRUD, voice
   cloning, starting a call, call history. Deploys to Vercel.

2. **Relay server** (`server/relay.js`) — a persistent Node process that
   Twilio's Media Streams WebSocket connects to for the live audio of an
   in-progress call. This has to be a long-lived process, not a Vercel
   function, because the connection stays open for the whole call. Deploy
   it on Render (same as the other apps' backends).

```
Android/Web app -> Vercel api/*.js -> Supabase (users, callers, calls, usage)
                                    -> Twilio REST API (start the call)

Twilio call audio -> server/relay.js (Render) -> Groq (brain + Whisper STT)
                                                -> Fish Audio (TTS)
```

All provider keys (Twilio, Groq, Fish Audio) live server-side only, in env
vars — the app owns the accounts, users never see or provide their own keys.
Per-user monthly minute limits are enforced in `api/calls-create.js` before
Twilio is ever touched.

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
skeleton with the full Twilio <-> Groq <-> Fish Audio loop wired up. Not yet
tuned against real calls: silence-detection timing in the relay, mulaw/WAV
framing for Whisper, and the IVR/hold-music handling from the original spec
still need real-call testing before this is production-ready.

Home screen is now a chat with the assistant ("Mitra"-style), not a raw
number composer: `contacts` (name -> phone number, managed from Profile ->
Contacts) let you say "call Juicy Jay" instead of typing digits; `POST
/api/assistant?action=send` runs one Groq call to decide call vs. retry vs.
plain reply, then places the call itself; `api/calls-status.js` posts a
follow-up message (busy / no answer / finished) back into the same thread
once Twilio's status webhook fires, so the chat updates on its own while
you keep using the app. Voice input (the wave icon) records with
`MediaRecorder` and transcribes via Groq Whisper — same model the relay
already uses. All of this needs `GROQ_API_KEY` set in the Vercel project
(added to `.env.example`) and `sql/007_assistant.sql` run against Supabase
before it'll do anything; until then `api/assistant.js` replies with an
explicit "not configured yet" message instead of failing silently.
