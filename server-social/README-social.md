# Social calling relay (Telegram + WhatsApp)

A separate Render service, kept apart from the Twilio relay in `server/` so a failed
native-dependency install here (`@roamhq/wrtc`, `telegram`) cannot affect phone calling.

## Deploy (Render)

1. New Web Service from this repository, **root directory: `server-social`**.
2. Build command: `npm install`. Start command: `npm start`.
3. Environment variables (see the "Social calling relay" block in `.env.example`):
   - `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` - the same Supabase project as the rest of the app.
   - `SOCIAL_RELAY_INTERNAL_SECRET` - a long random string. Set the same value on the Vercel
     project, together with `SOCIAL_RELAY_URL`, so `api/social-calling.js` can call this service.
   - `SOCIAL_SESSION_ENC_KEY` - 32 random bytes, base64-encoded. Generate with:
     `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`
     It encrypts Telegram session strings and WhatsApp auth state at rest. If it is lost,
     every linked account has to be linked again, so also keep a copy in a password manager.
   - `TELEGRAM_API_ID`, `TELEGRAM_API_HASH` - application credentials from https://my.telegram.org.
   - `WHATSAPP_CALLING_ENABLED` - `false` by default. See "WhatsApp calling" below.
4. On Vercel, set `SOCIAL_RELAY_URL` to this service's URL and `SOCIAL_RELAY_INTERNAL_SECRET`
   to the value from step 3.
5. Run `sql/011_social_calling.sql` against Supabase.

## How it works

- Accounts are linked per user. Telegram uses a phone login (code, optional 2FA password);
  WhatsApp uses QR linking.
- Session data is stored encrypted (AES-256-GCM) in Supabase
  (`telegram_accounts.session_encrypted`, `whatsapp_accounts.auth_state_encrypted`); the
  key is held only by this service.
- WhatsApp auth state is kept in Supabase rather than on disk, so it survives redeploys.

## WhatsApp calling

WhatsApp calling uses an unofficial, reverse-engineered library and carries a risk of
account bans. It is disabled unless `WHATSAPP_CALLING_ENABLED=true`. Leaving it unset
keeps WhatsApp linking and messaging available without enabling calls.

Telegram and WhatsApp calling depend on third-party protocols and need testing against
real linked accounts before use in production.
