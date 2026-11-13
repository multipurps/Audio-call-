# SignalWire as the phone provider (default)

Twilio is gone from the code. Phone calls use SignalWire's Twilio-compatible API unless `TELEPHONY_PROVIDER=telnyx`.

| Step | How |
|---|---|
| Place a call | `POST https://{SIGNALWIRE_SPACE}/api/laml/2010-04-01/Accounts/{SIGNALWIRE_PROJECT_ID}/Calls.json`, Basic auth `project id : API token` |
| Instructions | `/api/calls-twiml` returns `<Connect><Stream url="RELAY_WS_URL"><Parameter name="callId" .../></Stream></Connect>` |
| Why a `<Parameter>` | SignalWire rejects a query string on the stream URL, so the call id arrives in the stream's `start` frame (`customParameters.callId`). The relays read it there. |
| Status | `/api/calls-status` (Twilio-style form fields) |
| Webhook security | per-call token `t=` in the URL we give SignalWire (see `lib/telephony.js`); `WEBHOOK_VALIDATION=enforce` rejects a bad one |
| Hang up | `POST .../Calls/{sid}.json` `Status=completed` |

## Environment

- Vercel: `SIGNALWIRE_SPACE` (e.g. `yourname.signalwire.com`), `SIGNALWIRE_PROJECT_ID`, `SIGNALWIRE_API_TOKEN`, `RELAY_WS_URL`, `PUBLIC_APP_URL`.
- Relay (Render, `server/relay.js`): the same three `SIGNALWIRE_*` variables, used to hang a call up.
- After one real call works, set `WEBHOOK_VALIDATION=enforce` on Vercel.

## Notes

- The relay now starts `server/relay.js`. The old `server/patter-relay.js` used the Patter SDK's Twilio carrier, and Patter has no SignalWire carrier.
- Database columns such as `calls.twilio_call_sid` and `phone_lines.twilio_sid` keep their names (renaming needs a migration); they hold SignalWire ids now.
- The `TWILIO_VIA_PIPECAT` flag keeps its name so existing deployments keep working; it only turns on the Pipecat assistant path.
- Verified caller IDs ("bring your own number") use the compatibility API's `OutgoingCallerIds`. Check that this works on your SignalWire project before relying on it.
