# signal-bridge

Signal voice calls for linked accounts: signal-cli (master 13d603d3 + PR #2117) + signal-call-tunnel (02c84e9b) + PulseAudio.

## Deploy (Fly.io)
    fly launch --no-deploy --copy-config
    fly volumes create signal_data --size 1
    fly secrets set BRIDGE_SECRET=<long random string>
    fly deploy

## Link a test account (needs a second screen)
Open `https://<app>.fly.dev/link?key=<BRIDGE_SECRET>` on a laptop/other device, then on the phone:
Signal > Settings > Linked devices > + > scan. The code expires in about 2 minutes.

## API (header `x-bridge-secret`)
- POST /signal/link/start -> {id, qr (data URL), uri}
- GET  /signal/link/:id   -> {status: pending|linked|failed|expired, number}
- GET  /signal/accounts
- POST /signal/calls {account, to} -> {callId, state, ...}
- POST /signal/calls/:callId/hangup

## Test order
1. Link the account, then call a contact you have saved, with ASSISTANT_MODE=echo (default).
   Answering should play your own voice back about 1s late. That proves the audio path.
2. Only then wire the Pipecat/ACAF adapter (audio-bridge.mjs, attachAssistant).

## Verified vs not
Verified: PR #2117 applies cleanly to the pinned master commit; link/QR/status/auth logic runs against a stub signal-cli.
NOT verified (needs the Fly build + a real call): Docker build of the Rust tunnel (RingRTC download),
Java 25 image tags, PulseAudio device names, the JSON-RPC param shapes for startCall/hangupCall,
and whether PR #2117 alone makes a linked-device call connect (its own test only checks the config JSON).

## Known limits
- Linking or removing any account restarts the shared signal-cli daemon, which drops calls in progress for every user. Fine for testing; needs a fix (one daemon per account, or restart only when idle) before real traffic.
- Disconnect deletes only this server's copy. The user should also remove "Live Call" under Signal > Linked devices on their phone.
- Placing Signal calls from the app (api/social-calling.js `place-call`) is intentionally not wired yet.
