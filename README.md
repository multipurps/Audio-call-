# Emysa

Emysa is an AI phone-calling assistant. You tell it what you need done; after you
confirm, it places the call, handles the conversation and reports back in the app.

## Components

| Path | What it is |
| --- | --- |
| `index.html`, `app.js`, `styles.css`, `admin/`, `api/` | Mobile-first web app (PWA) and its serverless functions, deployed to Vercel (`vercel.json`). |
| `server/` | Node relay that carries the live audio of a phone call (Twilio Media Streams). Deployed to Render. |
| `server-social/` | Separate Node relay for linked Telegram and WhatsApp accounts. See [`server-social/README-social.md`](server-social/README-social.md). |
| `pipecat-service/` | Python voice assistant service (FastAPI + Pipecat). See [`pipecat-service/README.md`](pipecat-service/README.md). |
| `signal-bridge/` | Bridge for Signal calls, connected to the voice assistant service. |
| `telegram-call-bridge/` | Prototype Telegram call bridge. See [`telegram-call-bridge/README.md`](telegram-call-bridge/README.md). |
| `lib/` | Shared server-side modules used by `api/` and the relays. |
| `sql/` | Supabase migrations. |
| `tests/` | JavaScript tests. |

## Setup

1. Create a Supabase project and apply every file in `sql/` in filename order.
2. Enable Google as an auth provider in Supabase.
3. Set the Supabase project URL and public anon key in `app.js`, `admin/admin.js`
   and `landing.js`.
4. Deploy the repository root to Vercel and set the environment variables listed in
   `.env.example`.
5. Deploy `server/` to Render (`npm start`) and set the relay variables from
   `.env.example`. Set `RELAY_WS_URL` in Vercel to the relay's `wss://` URL.
6. Sign up in the app, then approve your own account in Supabase
   (`update user_approvals set approved = true where user_id = '<your user id>';`).
   Signing in as `ADMIN_EMAIL` unlocks the admin functions for approving other users.

The voice assistant service, social relay and bridges are deployed separately; see
their READMEs and the documents below.

## Tests

```bash
npm install
npm test                # JavaScript tests
npm run check:deploy    # verifies the files the Vercel deployment needs
```

Python tests for `pipecat-service/` are described in its README.

## Documentation

| Document | Contents |
| --- | --- |
| [`docs/ASSISTANT-DEPLOYMENT.md`](docs/ASSISTANT-DEPLOYMENT.md) | Voice assistant service: deployment, environment variables, testing |
| [`docs/ACAF-PROTOCOL.md`](docs/ACAF-PROTOCOL.md) | Audio bridge wire protocol |
| [`docs/MP-RELAY-INTEGRATION.md`](docs/MP-RELAY-INTEGRATION.md) | Telegram relay integration spec |
| [`docs/ADD-TIME-PAYMENTS.md`](docs/ADD-TIME-PAYMENTS.md) | Paying for call minutes |
| [`docs/AI-BEHAVIOR.md`](docs/AI-BEHAVIOR.md) | Admin-controlled AI behavior and shared knowledge |
| [`docs/LANDING.md`](docs/LANDING.md) | Public landing page and routing notes |
| [`docs/PHASE3-WHATSAPP-MEMORY.md`](docs/PHASE3-WHATSAPP-MEMORY.md) | Imported WhatsApp history and per-contact memory |
| [`docs/AI-VOICE-ASSISTANT-REPORT.md`](docs/AI-VOICE-ASSISTANT-REPORT.md) | Historical inspection report for the voice assistant service |

## License

Apache License 2.0. See [`LICENSE`](LICENSE). Third-party notices are in
`vendor/` and `telegram-call-bridge/NOTICE`.
