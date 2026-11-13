# Telnyx as the phone provider

SignalWire is the default phone provider. Phone calls go through Telnyx only when `TELEPHONY_PROVIDER=telnyx` is set (Vercel, and
on the relay host if you want its fallback hangup to use Telnyx env too). Nothing else changes: calls are placed
from the user's own line, the callee's audio streams to the relay, the assistant talks, status comes back.

## How it works

| Step | Twilio | Telnyx (TeXML) |
|---|---|---|
| Place a call | `POST api.twilio.com/.../Calls.json` | `POST api.telnyx.com/v2/texml/calls/{TELNYX_CONNECTION_ID}` with `Authorization: Bearer TELNYX_API_KEY` |
| Instructions | `/api/calls-twiml` returns `<Connect><Stream>` | same URL, with `bidirectionalMode="rtp"` `bidirectionalCodec="PCMU"` |
| Status | `/api/calls-status` | same URL, Twilio-style form fields |
| Voicemail | `MachineDetection=Enable` | same parameter |
| Webhook security | `X-Twilio-Signature` | per-call token in the URL (`t=`), see `lib/telephony.js` |
| Hang up | `Status=completed` on the call | `POST /v2/texml/Accounts/{TELNYX_ACCOUNT_ID}/Calls/{call_sid}` `Status=completed` |
| Media stream | `streamSid` on every frame | `stream_id` on frames Telnyx sends; none needed when sending (`server/streamProtocol.js`) |

The relay detects the provider from the first `start` frame, so it needs no setting of its own. It does need
`TELNYX_API_KEY` (and `TELNYX_ACCOUNT_ID`, or it uses the account id Telnyx puts in the stream) to hang a call up.

## Set up (once)

1. **Telnyx portal > Voice > Programmable Voice > TeXML Applications > Add.**
   - Voice method `POST`; Voice URL `https://YOUR-APP/api/calls-twiml`; status callback `https://YOUR-APP/api/calls-status`
     (each call also sends its own, so these are only defaults).
   - **Outbound** tab: attach an **Outbound Voice Profile** and allow the destination countries you will call.
   - The application's ID is `TELNYX_CONNECTION_ID`.
2. **Numbers**: buy (or port) a number and assign it to that TeXML application. This is the caller ID.
   Some countries need an address or ID document before Telnyx activates a number.
3. **API key** (portal > Account > Keys & Credentials): `TELNYX_API_KEY`. Your account id is `TELNYX_ACCOUNT_ID`.
4. **Give a user the line.** Telnyx cannot verify someone else's number the way Twilio's caller-ID check does, so with
   Telnyx the numbers on your own account are assigned by you:
   ```sql
   insert into phone_lines (user_id, mode, phone_number, status)
   values ('USER-UUID', 'rent', '+234XXXXXXXXXX', 'rented')
   on conflict (user_id) do update set mode = 'rent', phone_number = excluded.phone_number, status = 'rented';
   ```
5. **Environment**
   - Vercel: `TELNYX_API_KEY`, `TELNYX_CONNECTION_ID`, `TELNYX_ACCOUNT_ID`, then `TELEPHONY_PROVIDER=telnyx`. Redeploy.
   - Relay host (Render): `TELNYX_API_KEY` (and `TELNYX_ACCOUNT_ID`). Redeploy.
   - Optional: `TELNYX_WEBHOOK_VALIDATION=enforce` once a real call has worked (default `warn` only logs a bad token).
6. Place a call from the app. If the call does not connect, Telnyx's portal call logs (Reporting > Debugging) show
   why; the Vercel function logs show our side.

## Not switched yet

- **Bring-your-own-number verification and renting a number from the app** still use Twilio's API. With Telnyx,
  assign lines with the SQL above.
- **Call answering (inbound calls to a user's number)** is still provisioned through Twilio (`api/call-answering.js`).
