# Call System Implementation Report — Emysa

**Branch:** `arena/01a0f2e1-audio-call` · **Implementation commit:** `d3a07d2` ("Fix WhatsApp calling end-to-end: answer events, live monitoring, real transcripts, natural voice, A/B retry fix") · **Date:** 2026-09-30

This report covers what was implemented, what is verified, and what is not. Tests distinguish **mocked verification** (network fully faked) from **real-call verification** (a live line) — nothing below claims real-call verification unless it says so. **No live WhatsApp call could be placed from this sandbox** (no WhatsApp account/phone); the manual steps to verify one are in §8.

---

## 1. Root causes found and fixed (the reported symptoms)

| Symptom | Root cause | Fix |
| --- | --- | --- |
| Calls stuck on "Ringing", never showing answered | The provider's real **answer event** (ACAF `call_active` from WaCalls/mp-relay, `answered` from the relays) was not driving the call state. First inbound audio and relay-attach were being conflated with "answered". | Answer transitions come ONLY from the provider answer event (`pipecat-service/app/conversation.py note_call_active` → `call_context.set_in_progress` which stamps `calls.answered_at` exactly once; `api/social-calling.js relay-call-status` `answered`/`active` maps likewise). First-inbound-audio answering is an explicit opt-in (`ASSISTANT_ANSWER_ON_FIRST_AUDIO`, default `false`) for legacy relays only. Never fabricated, never inferred from an audio frame. |
| Timer starts before the person answers | The UI counted from dial time and the server derived durations from `created_at`. | `app.js` ring-vs-talk timer: counts ring time from `created_at`/placement, restarts at `answered_at` when the answer event lands. Server hangup durations = talk time from `answered_at` (a call that never connected records zero/none, never ring time). `sql/018` adds `calls.answered_at`. |
| Could not hear either side | There was **no monitoring path at all** into the WhatsApp/Pipecat audio; the call-screen "audio" button was decorative. | Real monitoring of **both** the caller's inbound audio and Emysa's TTS output: `pipecat-service/app/monitor.py` (MonitorHub fans out both directions' PCM from the bridge conversation), WS route `/monitor/{session_id}`, per-call short-lived HMAC tokens minted by `api/calls.js?action=monitor-token` and verified server-side (identical scheme, cross-tested). Browser player in `app.js` (`toggleCallMonitor`/`startCallMonitor`/`stopCallMonitor`) — playback-only, so it can never feed the line (no feedback, no duplicate audio to the recipient; "Mute Emysa" is a separate control that mutes TTS **for the other person**). One monitor at a time; AudioContext created in the tap gesture for iOS Safari/PWA. |
| Wrong person called on "call again" | The WhatsApp/Telegram retry path resolved the target from the user's **global most recent `social_calls` row**, so after calling B from B's chat, a retry in A's chat dialled B. | `api/assistant.js` retry resolves from **this conversation's own `calls` history** (channel-preferred row, then any-line row for identity, then this session's `call_plans`, then the contact's own number) — never global. Unidentified → Emysa asks "who do you mean" instead of guessing. Regression tests in `tests/retry-targeting.test.mjs` (the A/B bug, cross-line hijack, no-history behaviour, identity/platform/instruction inheritance). |
| Generic "Call finished" summaries | Terminal chat messages were hardcoded; summaries could claim success with nothing captured. | `maybeGenerateCallSummary` summarises the **persisted transcript** (objective/topics/decisions/commitments/followups, `incomplete` flag) before the chat message; the chat message carries the real summary. Empty transcripts state plainly that the conversation was not captured. Idempotent — duplicate callbacks can't double-post (`tests/relay-status.test.mjs`). |
| Robotic speech | Persona was neutralised ("gender-neutral"); no vocal expression anywhere in the real voice path. | §6 below. |
| Rejected/busy/unanswered/disconnected mishandled | `disconnected` and similar relay statuses could fall through unmapped → rows stuck forever. | Full status map in `relay-call-status` (`rejected`/`declined`→`no_answer`, `busy`, `unanswered`→`no_answer`, `disconnected`→`completed` with talk time else `failed`, …); every terminal path generates the summary and posts the truthful outcome; `hangupSocialCall`/`completeCall` write `completed` (with real duration) vs `canceled` depending on whether the call was ever answered, with status guards so late callbacks can't resurrect ended calls. |

---

## 2. Implemented items (against the brief)

| # | Requirement | Status | Where |
| --- | --- | --- | --- |
| 1 | WhatsApp calls work end-to-end (placement → answer → live audio → transcript → summary) | ✅ implemented | `api/assistant.js`/`api/social-calling.js` → `lib/wacallsClient.js` (start → persist `platform_call_id` → attach, 52 s deadline) → WaCalls ACAF → `pipecat-service`. **Real-call verification pending** (§8). |
| 2 | Answer state/timer driven by the real provider answer event; rejected/busy/unanswered/disconnected/failed handled | ✅ | §1 rows 1–2; `tests/relay-status.test.mjs` (7 scenarios), `pipecat-service/tests/test_conversation.py` (`call_active` gating). |
| 3 | Low-latency monitoring of BOTH sides for the authenticated user; recipient-safe mute; no feedback/dupes; iOS gesture support | ✅ | §1 row 3; `app/monitor.py`, `tests/test_monitor.py` (fan-out, isolation, frame layout, token, socket lifecycle), `tests/monitor-token.test.mjs`, `app.js` player. Mocked-verified; live-phone listen-in in §8. |
| 4 | Real-time transcript of both speakers with speaker labels + timestamps, persisted per call | ✅ | Pipecat `_TranscriptNote` (caller + AI turns, interruption flush) → `calls.transcript` [{speaker, content, ts}]; live screen renders persisted turns (`renderTranscript`) via realtime + 3 s poll; survives refresh (`resumeActiveCallIfAny`). |
| 5 | Groq gone; OpenAI LLM + verified OpenAI STT; Fish Audio TTS + cloned voices kept; no silent fallbacks; no secrets committed | ✅ | §5/§6 of previous pass retained: `lib/llmClient.js` (OpenAI/fal-OpenRouter only), `lib/sttClient.js` (OpenAI-only `gpt-4o-mini-transcribe` → `whisper-1`), Fish TTS untouched. `tests/emysa-audit.test.mjs` asserts Groq is gone. |
| 6 | Natural/expressive Emysa in the real voice pipeline (contextual laughter/chuckles/sighs/humming as real TTS, no literal tags, no extra LLM calls, emotion-engine + memory wired in) | ✅ | §6 below. |
| 7 | Wrong-person "call again" fixed + regression test | ✅ | §1 row 4; `tests/retry-targeting.test.mjs`. |
| 8 | Persistent person-centred history (per-conversation contacts/calls/transcripts/summaries/dates; each call its own session; stable IDs; RLS preserved) | ✅ | `calls.session_id` + `contact_id` on every row (create-before-dial), history dialog (contact-scoped), memory manager (RLS-aware, service-role only server-side). |
| 9 | Real summaries from persisted transcripts; incomplete marked; never generic; deduped | ✅ | §1 row 5; CAS-claimed `maybeGenerateCallSummary`. |
| 10 | Same core features across supported channels (WhatsApp, Twilio/PSTN; don't break messaging/Fish/Twilio; no unverified Telegram claims) | ✅ | Shared `lib/callSession.js` lifecycle for all three. Telegram remains env-opt-in (mp-relay must send `call_active` — not verified in its repo, so first-audio answering stays off by default for it). Monitoring covers WhatsApp/Telegram bridge calls; Twilio relays have no monitor stream and the API says so instead of failing silently. |
| 11 | Real regression tests (the listed areas), mocked vs real separated, both suites run, real-call limitation stated + manual steps | ✅ | §7/§8. |
| 12 | Implement directly; commit to dedicated branch; migration/env instructions | ✅ | This branch (`arena/01a0f2e1-audio-call` — the session's fixed branch; see §3), migrations §4a, env §4b. |

---

## 3. Files & commits

**Branch `arena/01a0f2e1-audio-call`** (Arena session branch — the requested `fix/emysa-whatsapp-end-to-end` name is not selectable in this environment; the PR title uses it). Implementation commit **`d3a07d2`**; report commit follows.

**New:** `pipecat-service/app/monitor.py`, `pipecat-service/app/vocal.py`, `pipecat-service/app/expressive_context.py`, `pipecat-service/tests/test_monitor.py`, `pipecat-service/tests/test_vocal.py`, `sql/018_call_answered_at.sql`, `tests/retry-targeting.test.mjs`, `tests/relay-status.test.mjs`, `tests/monitor-token.test.mjs`.

**Core edits:** `api/assistant.js` (session-scoped retry, `toFishTtsText` in `speakText`, VOCAL EXPRESSION prompt), `api/social-calling.js` (`relayCallStatus` answer/terminal semantics + truthful chat outcomes), `api/calls.js` (`completeCall(supabase, call)`, `monitor-token` action), `lib/callSession.js` (empty-transcript outcome wording), `lib/emotionEngine.js` (VOCAL_MARKERS, `extractAndStripControlTags`, `toFishTtsText`), `app.js` (ring-vs-talk timer, monitor player, monitor teardown), `index.html`/`styles.css` (Listen / Mute Emysa labels + states), `pipecat-service/app/{conversation,call_context,config,emotion,main,pipeline}.py` (answer-event gating, monitor route/publishing, expressive context, prompt), `pipecat-service/render.yaml`, `.env.example`, `tests/helpers.mjs` (builtin-module loader, Postgres-faithful `IS NULL`).

---

## 4a. SQL migrations (run in order, no secrets inside)

```sql
-- sql/018_call_answered_at.sql  (NEW — required; additive + idempotent)
alter table calls add column if not exists answered_at timestamptz;

create index if not exists calls_user_answered_at
  on calls(user_id, answered_at desc)
  where answered_at is not null;
```

`answered_at` is stamped once, only by the provider answer event (`call_context.set_in_progress`, `relay-call-status` answer transitions). Ring time = `answered_at − created_at`; talk duration runs from `answered_at`; unanswered calls keep NULL. (Prior migrations 001–017 unchanged and still required in order.)

## 4b. Environment variable changes (names only — never commit values)

**Vercel (app):**
- `PUBLIC_ASSISTANT_WS_URL` — browser-reachable websocket base of the pipecat service (e.g. `wss://…/stream`; the `/monitor` path is derived). Needed for in-app listening.
- `ASSISTANT_BRIDGE_SECRET` — must equal the pipecat service's value (monitor tokens are HMAC-signed with it; also authenticates the pipecat end-report to `relay-call-status`).
- Keep: `LUNA_API_KEY`/`OPENAI_API_KEY`, `LLM_MODEL=gpt-6-luna`, `STT_MODEL`, `FISH_API_KEY`, `WACALLS_RELAY_URL`, `WACALLS_INTERNAL_SECRET`, `RELAY_CALLBACK_SECRET`. Remove any `GROQ_API_KEY`.

**Render — pipecat-service** (`pipecat-service/render.yaml` updated):
- `ASSISTANT_ANSWER_ON_FIRST_AUDIO=false` (default; set `true` only for a legacy relay that cannot send the answer event).
- `ASSISTANT_BRIDGE_SECRET`, `OPENAI_API_KEY` (+optional `LUNA_API_KEY`), `FISH_API_KEY`, `ASSISTANT_STT_PROVIDER=openai`, `ASSISTANT_LLM_PROVIDER=luna`, `ASSISTANT_TTS_PROVIDER=fish`, optional `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` (context + transcripts + memory retrieval), `ASSISTANT_ENABLE_PERSISTENT_MEMORY=true`, `PUBLIC_APP_URL`, `ASSISTANT_STT_PROMPT`.

**Render — Twilio relays (`server/`):** `LUNA_API_KEY`/`OPENAI_API_KEY` required (no Groq branch exists anymore).

---

## 5. Exact OpenAI model IDs and endpoints

| Role | Model | Endpoint | Notes |
| --- | --- | --- | --- |
| Conversation LLM | `gpt-6-luna` | `POST https://api.openai.com/v1/chat/completions` | The deployment's intended OpenAI LLM (config `LLM_MODEL`/`LUNA_MODEL`/`ASSISTANT_LLM_MODEL`); JSON-mode intent + summaries; no tools. |
| STT (default) | `gpt-4o-mini-transcribe` | `POST https://api.openai.com/v1/audio/transcriptions` | Verified against OpenAI's model catalog (developers.openai.com) — $1.25/$5 per 1M audio/text tokens ≈ $0.003/min. `temperature=0`, noise-guidance prompt. Pipecat `OpenAISTTService` uses the same endpoint/model. |
| STT (fallback) | `whisper-1` | same | ≈$0.006/min; `STT_MODEL`/`ASSISTANT_STT_MODEL`. No Groq fallback at any tier. |
| TTS | Fish Audio (S1 app path / S2 service path) | Fish WebSocket + repo HTTP path | Cloned per-contact voices kept. |
| Vision | `gpt-6-luna` (text+image) | Chat Completions | — |

---

## 6. Natural voice: how vocalisations actually reach the ear

The model writes canonical markers (`[laughing]`, `[chuckling]`, `[giggling]`, `[sighing]`, `[clearing throat]`, `[gasping]`, `[humming]`, `[soft]`, `[whispering]`, `[emphasis]`) prompted contextually ("occasional, varied, never in serious moments"). No extra LLM call is made anywhere.

- **Pipecat/WhatsApp path:** `app/emotion.py` strips `[[END_CALL]]`/`[[MOOD:…]]`; `app/vocal.py` translates markers into the active Fish model's verified tag syntax — S2 `[bracket]` free-form; S1 fixed `(paren)` set `(laughing)(chuckling)(sighing)(clear throat)(gasping)(break)`. Unknown/unverified tags (e.g. humming on S1) are **dropped**, never spoken as literal text. Streaming `split_complete` holds back marker fragments that straddle LLM chunks.
- **Transcripts:** markers become quiet annotations `(laughs)`/`(chuckles)`/`(sighs)`/`(hums)`; delivery-only markers vanish; control tags never persist.
- **Policy (`VocalisationPolicy`):** at most one vocalisation per 25 s (global across kinds — a chuckle straight after a laugh is manic, not natural) and 24/hour; laughter/humming suppressed in serious emotional states (concerned/sad/empathetic/focused, or pleasure < −0.25). It only ever *removes* over-firing — it cannot invent sounds.
- **App chat/TTS path (JS):** `lib/emotionEngine.js` `toFishTtsText(text, {model:'s1'})` mirrors the same translation for `speakText`'s Fish S1 endpoint.
- **Personality:** `app/expressive_context.py` supplies the expressive-personality layer (identity, emotional presence, humour style, relationship memory) — kept in sync with the chat persona in `api/assistant.js` — appended to the voice system prompt (default prompt only; an operator-supplied `system_prompt` owns persona outright). Live emotion state (PAD summary + user mood) is composed into the turn prompt each turn; the emotion engine and memory manager remain wired into the WhatsApp path (pre-call retrieval into the prompt, post-call consolidation via the shared summary).

**Verified status:** unit-tested translation/policy/streaming (40 new Python tests + JS mirrors); mocked end-to-end. **A real call's Fish playback of `(laughing)`-style tags on a live line is pending** (§8).

---

## 7. Test results

| Suite | Command | Result | Nature |
| --- | --- | --- | --- |
| JS (Vercel/API/relays) | `npm test` | **58/58 pass** | All mocked (in-memory Supabase double, fake fetch, fake carrier). New: `retry-targeting` (4), `relay-status` (8), `monitor-token` (5, HMAC cross-checked against the Python verifier). Pre-existing: lifecycle, confirm-flow, Groq-removal audit, WaCalls protocol, summaries, memory, messaging, cloned-voice payload. |
| Python (pipecat-service) | `.venv/bin/python -m pytest tests/` | **413/413 pass** | All mocked. New: `test_monitor.py` (23 — tokens incl. JS-compat vector, frame layout, fan-out/isolation/queue shedding, socket delivery + `ended` + disconnect), `test_vocal.py` (17 — s1/s2 translation, unknown-tag stripping, transcript annotations, split_complete, policy). Pre-existing: conversation/answer-event gating, call-context resolution, transcript persistence/dedupe, termination, provider failures, memory, config. |

Test-area map (brief §11): answer state/timer (`relay-status`, `test_conversation`) · monitoring (`test_monitor`, `monitor-token`) · live transcription (`test_call_context`, `test_conversation`) · transcript persistence (same) · call/contact/session association (`retry-targeting`, `calls`) · A/B retry bug (`retry-targeting`) · summaries (`relay-status`, `callSession` tests) · history (`calls`, `emysa-audit`) · memory (`memoryManager`/`test_call_context`) · concurrent-call isolation (`test_conversation` session registry, `test_monitor` rooms) · termination (`test_conversation`) · provider failures (`calls`, `wacalls-ai`, `test_call_context`) · Groq removal (`emysa-audit`, config tests) · WhatsApp messaging + cloned voices (`emysa-audit`, `wacalls-ai`).

One transient JS flake was observed once under parallel load ("profile language…"); 16 subsequent full/hammer runs were clean. Noted for CI watch.

## 8. Manual steps & limitations (read before deploying)

**Deploy steps:** 1) run `sql/018_call_answered_at.sql`; 2) Vercel env per §4b (incl. `PUBLIC_ASSISTANT_WS_URL`, `ASSISTANT_BRIDGE_SECRET`); 3) redeploy Vercel; 4) Render pipecat env per `render.yaml`, redeploy, watch `/readyz`; 5) Twilio relay env (Luna/OpenAI key required); 6) restart WaCalls/wacalls-relay so it forwards `call_active` to pipecat (and `answered`/terminal statuses to `/api/social-calling?action=relay-call-status`).

**Real-call verification still to do (impossible from this sandbox — no WhatsApp account/line):**
1. Place a live WhatsApp call; confirm status goes `queued → ringing → in_progress` only when the callee actually answers, and the call-screen timer shows ring time until then, then restarts as talk time.
2. On the live screen tap **Listen** (user gesture — required for iOS): hear BOTH the person and Emysa, clearly, with no echo/feedback; verify "Mute Emysa for the other person" silences Emysa for the callee while monitoring still works; verify listening off/muted never affects the call audio.
3. Speak on both sides and watch labelled, timestamped transcript lines appear live and persist to `calls.transcript`.
4. End the call (and separately, let it go unanswered / get rejected / busy): confirm truthful terminal statuses, durations from the answer, one chat follow-up with the real summary (or an explicit "not captured").
5. In contact A's chat, call A; call B from B's chat; back in A's chat say "call him again" — A must be dialled.
6. Fish Audio cloned-voice + `(laughing)`/`(sighing)` audible on a real line (S1 app path and S2 service path).
7. iOS Safari + installed iOS PWA: monitor tap works first time (gesture-gated AudioContext).

**Known limitations / blockers:**
- **Real WhatsApp call untested here** (no line/account) — the single biggest open verification item; steps above.
- STT is batch-per-utterance; no mid-sentence partial transcripts.
- Twilio/PSTN calls have no monitoring stream (the API returns a clear 409 rather than a dead socket).
- `[[END_CALL]]` across token-chunk boundaries is mitigated but not bulletproof.
- Telegram works only where the deployment's mp-relay sends the answer event; otherwise leave `ASSISTANT_ANSWER_ON_FIRST_AUDIO=false` and Telegram answer detection stays honest-but-quiet.
- Vercel 12-function cap respected (no new `api/` files).
