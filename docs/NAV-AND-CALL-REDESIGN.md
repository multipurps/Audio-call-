# Mobile navigation and confirmed calling

## What changed

- Four independent floating navigation capsules: **Home / Recent / Contacts / Profile**. The nav group has zero padding, no shared background, no border, and no glider. Existing tab routing and Profile/settings are reused.
- Contacts is now a top-level tab. The Profile → Contacts shortcut still opens it. Existing contact storage/API is reused.
- A separate bottom-center keypad has 1–9, `*`, `0`, `#`, plus, backspace, and a call button. New international numbers offer **Save Contact**; formatted versions of saved numbers match existing contacts.
- A contact's action sheet contains only **WhatsApp / Telegram / Phone**. The selected contact ID and method are explicit; model output cannot redirect that action to another contact or channel. Social calls use the existing linked-account services and are linked to their chat session.
- Home's phone button is now **Call Emysa**, independent of contacts.
- **Recent → All** shows the existing call log. **Chat** lists conversations linked to calls or call preparation, including resumable pending confirmations. Unrelated chats remain available in Home → Saved Chats. Legacy calls without a `session_id` remain in All; this change does not invent a historical conversation for them.

## Direct Emysa calls: callback semantics

The existing Twilio integration is an outbound telephone call with a server-side audio relay. It does **not** include Twilio Voice SDK browser audio. The previous browser microphone conversation with Emysa was a different transport.

To use the requested **same Twilio path**, Home → Call Emysa asks for **the user's own callback number**, then collects a script in chat. It clearly explains that Emysa will call that phone after confirmation. It neither dials a contact nor silently uses the browser-audio implementation. No new Voice SDK, provider, or phone-profile field is introduced.

Both Twilio relay implementations now recognize `calls.call_kind = 'emysa'`, greet the user as Emysa, and use an AI-assistant identity instead of the contact-call identity. The default `server/package.json` entry point is `patter-relay.js`; `relay.js` is also updated for installations still using it.

## Pre-call lifecycle and safety

1. Choose a contact's Phone action, an unknown keypad number, or an Emysa callback.
2. Home prompts for what Emysa should say. Sending the script generates a short summary via the existing Groq integration. No telephony request is made.
3. Store the original editable script, relay objective/instructions, summary, canonical destination, user, contact (if any), chat session, and summary message in `call_plans`.
4. Render **Call Now**, **Revise script**, and expandable instructions with the assistant's summary. A plan lasts 24 hours. A successful revision invalidates the old pending plan; cancellation also persists server-side.
5. Call Now conditionally claims the owned, unexpired pending plan in Postgres, then invokes the shared existing Twilio transport. Client-provided replacements for number/script are ignored at confirmation.
6. The transport retains monthly allowance checks (including bonus minutes), profile recording/ring settings, machine detection, voice cloning, callbacks and relay context. User language preferences are retained in the stored instructions.
7. Duplicate/concurrent confirmations cannot reuse a plan. A provider rejection consumes it; an ambiguous network failure is marked `uncertain` and does not unlock automatic retry. The call stays queued for webhook reconciliation rather than falsely reporting a definite rejection. Check Recent before preparing another call.

Natural-language Phone requests and retries now produce call plans too. Requests without instructions ask what to say instead of dialing with a default greeting. The legacy `/api/calls?action=create` entry point now requires `planId` and delegates to confirmation; raw `toNumber` + `objective` requests cannot bypass the review step.

Numbers must include an explicit country code (`+14155552671` or `00442079460958`). Formatting is normalized without guessing the user's country. `*`/`#` can be entered on the keypad, but are not valid destinations for this international outbound path.

## Required deployment steps

1. **Apply `sql/015_call_plans.sql` before deploying the web/API update.**
   - Adds `call_plans`, foreign keys to existing users/contacts/chat sessions/messages/calls, expiry/status checks, a per-session pending-plan unique index, and user/session lookup indexes.
   - Enables RLS with own-user reads only; authenticated clients have no write policy. All state changes go through the authenticated server APIs.
   - Adds `calls.call_kind`, defaulting existing calls to `contact`; direct callbacks use `emysa`.
   - No new contacts or chat-history tables are needed; existing data is retained. No destructive migration or backfill is performed.
   - Assumes existing assistant/chat, message-source, profile settings/language, and multi-platform call migrations are installed. For a fresh database, the legacy filename order is misleading: `007_assistant.sql` creates `assistant_messages` and must precede `006_chat_sessions.sql`.
2. **Redeploy the Twilio relay**, including `server/callIdentity.js`, then deploy the web app/API. Deploying only the web app leaves old relay identity behavior in place for callbacks.
3. Keep the existing Supabase, Groq, Twilio, `PUBLIC_APP_URL`, and `RELAY_WS_URL` environment configuration. WhatsApp/Telegram still require their existing linked accounts and deployed relay services. No new secrets are required.
4. Smoke-test with an authorized test account and phone number before production rollout. Migration execution and live provider calls were **not** performed in this coding environment.

## Validation

Node 22+:

```sh
npm install
npm test
npx playwright install --with-deps chromium
npm run test:mobile
```

`npm test` uses Node's test runner and isolated Supabase/provider doubles. The experimental VM-module flag is used to load the real API handlers with test-only auth/provider boundaries; it is not a production runtime requirement. Coverage includes ownership, no-dial preparation, raw-script preservation, concurrent confirmation, revision/cancellation/expiry, direct callbacks, language preferences, legacy endpoint enforcement, contact normalization, call-linked history, social target binding, usage limits and provider failures.

`npm run test:mobile` runs real app files and real API handlers with isolated fixtures at **320×568, 390×844 and 430×932**. It covers contact save/match, action sheets, no-dial summary, confirmed calls, callback setup, call/chat history, refresh/resume, revisions, cancellation, errors, profile navigation, runtime errors, and layout bounds. Screenshots go to ignored `test-results/`. `CHROMIUM_PATH` may point to a preinstalled Chromium binary when Playwright's browser download is unavailable.

These tests do not contact production Supabase, Groq, Twilio, WhatsApp or Telegram. They do not replace physical-device Safari/PWA and live relay testing. No UI/runtime libraries were added; Playwright is a development-only test dependency.
