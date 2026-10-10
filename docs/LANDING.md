# Public landing page / deployment notes

- On Vercel, `/` serves `landing.html`; `/landing.html` also works directly.
  The existing authenticated application and login remain at `/index.html`.
  The PWA manifest starts at `/index.html`; there is **one** manifest and one
  root service worker. OAuth and email confirmation redirects now return to
  `/index.html`, not `/`, so the landing route cannot intercept the session.
  If you have an external Supabase Auth URL allowlist, add the production
  `https://your-domain/index.html` redirect URL before deploying.
- Run `sql/032_landing_media.sql` on the existing Supabase project **before
  using admin media uploads**. No new environment variables. Existing
  `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` and `ADMIN_EMAIL` are required.
  The admin-only `/api/admin` function creates signed upload URLs for the
  existing `app-assets` Storage bucket. It confirms paths and stores media
  references in `landing_media` (RLS enabled, no browser write policy).
  `GET /api/admin?action=landing-media` returns only a curated public
  projection. Until the new table exists, the landing page renders editorial
  fallbacks. The existing Home GIF is used as hero background if no dedicated
  landing hero is configured.
- In Admin → Content & push → Public landing page media, upload separate
  backgrounds and screenshot overlays for each scene. Single slots replace;
  call/feature galleries support reorder. GIFs remain animated and are not
  recompressed server-side; prepare a web-optimized GIF before uploading.
  Image/GIF limit: 20 MB. Optional MP4/WebM: 50 MB. The voice orb slot only
  accepts a GIF. Each upload is sent directly to Supabase Storage via signed
  URL, then persisted in the table. Refresh and redeploy do not clear assets.
- The announcement is **not** replaced: `assets/intro/intro.mp3` and
  `assets/intro/intro.json` are used by both landing and existing welcome flow.
  The landing attempts autoplay once per tab if the existing `emysa_intro_seen`
  key is absent; rejected playback stays manual. Finishing audio sets the
  existing key. The orb GIF is optional admin media, with an emblem fallback.
- Install UI integrates `philfung/add-to-homescreen` 4.6.0 English bundle and
  assets, vendored in `vendor/adhs/` under MIT (see LICENSE). Native
  `beforeinstallprompt` is preferred on Android/desktop when available;
  library guidance is shown on click for iOS/iPad/in-app browsers and when
  native install is unavailable. Installed standalone mode offers Open Emysa
  instead of misleading install instructions. Some browsers cannot detect an
  installation made in a *different* browser profile.

## Capability audit behind the public copy

- Objective + confirmation for phone call: `api/assistant.js`, call-plan APIs
  in `api/calls.js`, `sql/015_call_plans.sql`, and Home UI in `app.js`.
- PSTN calling: `api/calls.js`, `lib/phoneCalls.js`, `lib/phoneLines.js`,
  Twilio relay in `server/`. Requires Twilio/service configuration. Connected
  WhatsApp/Telegram calling: `api/social-calling.js` and relay integrations;
  requires linked account, live relay, and deployed assistant service.
- Live transcript and call detail: `app.js` call UI, `api/calls.js`,
  `sql/017_call_context_and_summaries.sql`, Pipecat call-context persistence.
  Live transcript availability depends on call channel/deployment.
- Voice options/preferences and cloning: `app.js`, `lib/liveVoices.js`,
  `lib/voiceChoice.js`, `api/voice-clone.js`, `sql/024_voice_preferences.sql`;
  provider configuration is required.
- Per-contact memory, history and outcomes: `api/memories.js`,
  `lib/contactMemory.js`, `sql/026_contact_memory.sql`, `app.js` call detail.
  Memory use is conditional/opt-in. Retry targets in `app.js`/`api/assistant.js`.
- No scheduling claim: not verified as a completed end-user flow. No claim of
  24/7 availability or real-world call success; provider paths need live tests.

## Validation after deploying

1. Open `/` and `/index.html` separately. Test sign-up, Google/Apple callback,
   and email confirmation with configured auth redirects.
2. Apply migration, upload one GIF and overlay to each showcase; refresh and
   redeploy; confirm both persist, background remains exposed at 375px and
   desktop widths, gallery order sticks, and unauthorized POST is rejected.
3. Test first visit, blocked autoplay, listened/return visit and manual replay
   on iPhone Safari, iPad, Chrome Android, and Instagram/Facebook in-app views.
4. Test install guidance and the actual installed app route on physical iOS,
   Android and supported desktop browsers. Real device/browser tests and
   production storage persistence cannot be certified from the source tree.
