# Social calling relay (Telegram + WhatsApp)

Second, separate Render service — deliberately not merged into the existing
`server/` (Twilio/Patter) relay, so a bad native-dependency install here
(`@roamhq/wrtc`, `telegram`) can never take down the Twilio calling that
already works.

## Deploy (Render)

1. New Web Service, same repo, **root directory: `server-social`**.
2. Build command: `npm install` — Start command: `npm start`.
3. Env vars (see `.env.example`'s "Social calling relay" block):
   - `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` — same Supabase project as the rest of the app.
   - `SOCIAL_RELAY_INTERNAL_SECRET` — any long random string. Set the **same** value on the Vercel project (`SOCIAL_RELAY_URL` + this secret) so `api/social-calling.js` is allowed to call in.
   - `SOCIAL_SESSION_ENC_KEY` — 32 random bytes, base64-encoded. Generate with:
     `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`
     This is what encrypts Telegram session strings / WhatsApp auth state at rest — losing it means every linked account has to re-link. Store it somewhere durable outside Render's env vars too (e.g. a password manager).
   - `TELEGRAM_API_ID` / `TELEGRAM_API_HASH` — from https://my.telegram.org (your app credentials, not a user's).
   - `WHATSAPP_CALLING_ENABLED` — `false` by default. See "WhatsApp calling risk" below before flipping this.
4. On Vercel, set `SOCIAL_RELAY_URL` to this service's Render URL and `SOCIAL_RELAY_INTERNAL_SECRET` to the same secret as step 3.
5. Run `sql/011_social_calling.sql` against Supabase.

## What's implemented vs. what needs live verification

Implemented and following the app's existing conventions:
- Per-user linking (not one shared account) for both platforms.
- Encrypted-at-rest session storage in Supabase (`telegram_accounts.session_encrypted`, `whatsapp_accounts.auth_state_encrypted`) via AES-256-GCM, key never touches Postgres or Vercel.
- Telegram login (phone → SMS/app code → optional 2FA password) via GramJS, matching the "MTProto session string per user" architecture in the brief.
- WhatsApp QR-linking via Baileys with a custom Supabase-backed auth state (Baileys' default file-based state does not survive a Render redeploy — this is why a custom store was needed).
- One new Vercel API route (`api/social-calling.js`), multiplexed by `?action=`, to stay under the Hobby plan's 12-function cap (**the app was already at exactly 12 before this — see "Vercel function cap" below**).

Flagged as needing a live test pass against real linked accounts before shipping to users — this is inherent to both protocols being either closed (Telegram's call DH exchange / tgcalls bindings) or unofficial (WhatsApp calling), not something that can be verified by static review:
- `telegramCall()` in `social-relay.js` — issues a real `phone.RequestCall`, but completing the tgcalls audio bridge on top of that needs to be exercised against a real account/call.
- `whatsappCall()` — calls the fork's `sock.initiateCall()`. The brief flags this fork as unofficial/reverse-engineered with real ban risk; it's wired up but gated behind `WHATSAPP_CALLING_ENABLED=false` until that risk is explicitly accepted. Dropping WhatsApp *calling* while keeping WhatsApp *linking/messaging* just means never setting that flag to `true`.

## Vercel function cap

`api/` was already at 12 files (Hobby plan's limit) before this feature —
see the comment in `sql/009_profile_features.sql` about billing. This PR
adds exactly one (`api/social-calling.js`), bringing it to 13. If the
project is still on Hobby, a deploy will fail until either the plan is
upgraded or another endpoint is merged the same way (e.g. `calls-status.js`
+ `calls-incoming.js` are both small enough to fold into `calls.js` behind
`?action=`, the same pattern this file already uses).
