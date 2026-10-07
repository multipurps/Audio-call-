# Phase 5 report — Telegram private calls ⇄ PCM bridge

Scope: real Telegram **user account**, **private** (1:1) calls, raw PCM, ready for GPT Live later (not connected).
Evidence levels used below: **SOURCE** (read in code), **RUN** (executed here), **UNVERIFIED** (not checkable in the build sandbox).

## 1. Reference repos (commits inspected)

| Repo | Commit | Verdict |
|---|---|---|
| MarshalX/tgcalls | `2556b03` (2023-01-09) | Old C++ binding, **not NTgCalls**. Private calls are **unreleased/dev**, not usable for PCM. |
| foobar26/tg2sip | `fab2613` (2026-09-30) | Modern Python gateway on NTgCalls 3.x. Private calls both directions implemented in source. No tests. |
| pytgcalls/ntgcalls | `dc09eae` (2026-10-06) | The actual media engine (`pip install ntgcalls`). Group **and** private calls. |

### MarshalX/tgcalls — capability separation
* **Private calls — unreleased/dev (SOURCE).** README:115 "already there and working, but not in the release version". Only code is the scratch script `pytgcalls/test.py`: hard-coded `/Users/marshal/...` paths; `main()` (test.py:470) never calls `start()` (test.py:406); it calls `tgcalls.NativeInstance()` (test.py:429,447) but the binding requires `(bool, string)` (NativeInstance.h:37) → `TypeError`. `startCall` hard-codes `audioInputId = "VB-Cable"` and the system speaker (NativeInstance.cpp:261): **no raw-PCM path for private calls**; the raw PCM device exists only for `startGroupCall`. Layer 92, versions "2.7.7"/"3.0.0" only (Instance.cpp:42-44); vendored `lib_tgcalls` last touched Aug 2021.
* **Group calls — released** (README): raw PCM in/out via `GroupCallRaw`. Out of scope.
* **Video — group-call beta only.** Not evaluated for private calls.
* Its Python package is named `pytgcalls`; not used here.

### foobar26/tg2sip — what it proves (SOURCE)
* Outgoing: `request_call` (telegram_signaling.py:166) → `wait_accepted` (:192) → `confirm_call` (:207).
* Incoming: `PhoneCallRequested` → `received_call` → `accept_call` (:250) → `wait_established` (:264).
* Signaling blobs: `phone.sendSignalingData` ⇄ `updatePhoneCallSignalingData`. NTgCalls owns DH and the key.
* PCM: NTgCalls **EXTERNAL** source/sink, 48 kHz mono s16le, 10 ms frames; `send_external_frame` / `on_frames`.
* Quirk: playback sink goes on the **microphone** slot, not speaker (telegram_media.py ~443-448). **RUN-confirmed**: with `speaker` zero frames arrive.
* One call at a time: asyncio lock + busy decline (gateway.py:106, :219).
* **SIP provides only** the far-end audio source/sink and a PBX integration; everything Telegram-side is NTgCalls + Pyrogram. SIP/PJSUA2 (GPLv2) is not used here.
* Caveats: no tests in repo; a stale docstring says NTgCalls 1.3.4; its "tested clients" table is the author's claim (UNVERIFIED by me).

### NTgCalls (SOURCE + RUN)
* DH checks in `p2p_call.cpp`: `Hash mismatch` (:77), `Fingerprint mismatch` (:94). Supported protocol versions 8/9/12/13 (signaling.cpp:35-38); anything else → `SignalingUnsupported`.
* Outgoing side cannot verify the peer's fingerprint locally (no `ga_hash`); Telegram's server does.

## 2. What was RUN

Environment: Python 3.12, ntgcalls 3.0.0 (3.0.1 also loopback-tested), Pyrogram 2.0.106. **No Telegram servers were contacted.**

* Real NTgCalls↔NTgCalls loopback with real DH (valid 2048-bit safe prime, Miller-Rabin checked) and relayed signaling: both sides reach `CONNECTED` on v9 and v13; ~1,200 × 960-byte frames per direction in 12 s.
* Full manager flow on the **real engine** with a **fake signaling hub** (`tests/test_real_ntgcalls.py`): outgoing call, acceptance, two-way PCM with Goertzel tone verification (callee hears caller's 300 Hz probe; caller hears the callee's known 500→700→900 Hz clip, in order, every frame 960 bytes), v13 negotiated, hangup, engines hold no calls afterwards; tampered key rejected (`Hash mismatch`); one-call busy limit; protocol-version rejection; relay→RTCServer mapping.
* Fast suite: **56 tests pass** (PCM, bridge pacing/threading, state machine, incoming/outgoing/accept/deny/video-decline, local/remote/cancel hangup, one-call limits incl. during ringing, failed signaling: RPC errors with codes, timeouts, confirm/accept failures, tampered key, mid-call media death, discard failure). Pyrogram transport: 10 tests build the main requests (requestCall, confirmCall, acceptCall, discardCall, sendSignalingData) against the **real TL schema** (`.write()` serialises) with a mocked client.
* Mutation check: 5 injected bugs (no busy check, allow-all default, no key-hash check, no Telegram discard, no pacing) → each made the suite fail.

## 3. Engine behaviour found (RUN, raw ntgcalls, no Emysa code)

1. **Segfault when stopped very early**: `stop()` ~20 ms after setup crashed 2/20; ≥100 ms 0/20. Mitigation: `NTgCallsMedia` enforces a 250 ms minimum call age → 0/30 crashes. (An earlier theory — in-flight `send_external_frame` — did not fix it; the in-flight tracking is kept as defensive.)
2. **Missed `CONNECTED` callback on back-to-back calls in one process** (audio still flowed). A 0.5 s post-stop settle avoided it in a small sample (0/4 vs 4/4 misses).
3. **Residual flake**: real-engine suite still fails ~4 runs in 40 (a 15 s `media TIMEOUT`, mostly `test_real_engine_one_call_limit_busy`). Loopback has no STUN/relay, so this may not predict Telegram behaviour — unknown. Tests are left strict.

## 4. Status table

| Capability | Status |
|---|---|
| Private incoming/outgoing signaling logic, accept/deny/busy/terminate/failure handling | **Verified** vs fake Telegram (shared production state code) |
| Pyrogram wire objects well-formed | **Verified** vs real TL schema, mocked client |
| NTgCalls DH, WebRTC media, 48k PCM both ways | **Verified** in loopback; ~10% connect flake |
| PCM bridge pacing / re-chunking / barge-in hook | **Verified** |
| **Live Telegram call (either direction)** | **UNVERIFIED — never run.** Use `scripts/live_smoke.py` |
| Telegram-side behaviour: privacy settings, flood limits, real RPC errors, relays/TURN, Pyrogram 2.0.106 vs current layer | **UNVERIFIED / experimental** |
| Private-call video | **Not implemented** (requests declined) |
| Group calls | **Out of scope** |
| GPT Live | **Not connected**; its PCM format not checked — resample inside the adapter |
| Multiple simultaneous calls | **Not supported by design** |

## 5. Risks / next steps
1. Run `scripts/live_smoke.py` with two real accounts (cannot call yourself; callee must allow calls from the gateway account). Expect surprises.
2. Automating a user account can be restricted by Telegram; use a dedicated account.
3. Pyrogram 2.0.106 is old; if live calls fail on TL layer, evaluate a maintained fork.
4. Then: write the GPT Live `AudioAdapter` (resample, `clear_outbound()` on barge-in), re-run the same tests with a fake model.
