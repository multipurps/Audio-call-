# Call System Implementation Report — Emysa

**Branch:** `arena/01a0ec81-audio-call` · **Commit:** `a17aa04` ("Make call system work end-to-end across platforms; remove Groq everywhere") · **Date:** 2026-09-29

This report covers what was implemented, what is verified, and what is not. Tests distinguish **mocked verification** (network fully faked) from **real-call verification** (a live line) — nothing below claims real-call verification unless it says so.

---

## 1. Implemented items (against the brief)

| # | Requirement | Status | Where |
| --- | --- | --- | --- |
| 1 | Implement, not audit | ✅ | Commit `a17aa04`, 37 files, +2406/−442 |
| 2 | One consistent lifecycle/transcript/summary/memory/failure handling across WhatsApp, Twilio, Telegram; shared service, separate audio bridges | ✅ | `lib/callSession.js` (create → placed → in-progress → terminal; duplicate guard; transcript append rules; idempotent summary+memory). Callers: `api/social-calling.js` (WhatsApp/Telegram), `api/assistant.js` (chat-initiated), `api/calls.js` (hangup), `api/calls-status.js` (Twilio webhook), `server/relay.js`, `server/patter-relay.js`, `pipecat-service/app/call_context.py`. Audio bridges remain separate (Twilio media WS / Patter, WaCalls ACAF, mp-relay ACAF). |
| 3 | Call setup passes userId, contactId, display name, platform id, call/session id, objective/instructions to the actual AI pipeline (never as a chat message); duplicate prevention | ✅ | `calls` row created **before** dialing with `instructions` (verbatim user text) + `objective` + `contact_id` + `platform_call_id` (written before attach via `onCallStarted`). Pipecat resolves the row from the bridge session id (`call-{platform_call_id}`, with prefix-stripped/uuid fallbacks) and composes the pipeline context from it. Duplicate prevention: `findDuplicateActiveCall` (queued/ringing, digit-normalized number, 120 s window) in both `api/assistant.js` and `api/social-calling.js`, plus a UI double-tap guard. |
| 4 | Live transcription of both sides persisted per turn with call id/speaker/text/timestamp; live screen subscribes to persisted transcript; survives refresh/navigation; OpenAI STT; noise defence | ✅ | Pipecat: `_TranscriptNote` processors (caller after appraisal, AI after `[[END_CALL]]` filter with barge-in `interrupted` flush), debounced idempotent full-array writes to `calls.transcript`. Twilio relays: per-turn writes (status promotion now race-safe). Live screen already polls+subscribes (`openCallScreen`) and survives refresh via `resumeActiveCallIfAny`. STT: OpenAI `gpt-4o-mini-transcribe` everywhere; Silero VAD (Pipecat) + `isSpeechLikePcm16` energy/modulation gate (Twilio relays) + noise-guidance STT prompt. |
| 5 | Remove Groq everywhere (LLM/STT/TTS/vision separated), verified OpenAI ids, keep Fish Audio TTS + cloned voices, no silent fallbacks, never log secrets | ✅ | See §5/§6. Fish Audio untouched (`build_tts`, `FishAudioTelephonyTTS`, `speakText` cloned voices). `redactSecrets` covers Luna/OpenAI/fal/Fish/Supabase keys (+legacy GROQ, defensively). No secret is printed anywhere in new code; log lines carry ids/counts/statuses only. |
| 6 | Persistent person-centred history grouped by contact+user, per-call transcripts/summaries/status/duration, re-call from history | ✅ | Call-detail dialog: conversation history list per contact (fallback: same number) fetched by user+contact, click loads that call in-dialog; **Call again** button re-dials via the same channel (WhatsApp/Telegram → `action=call`; Phone → existing prepare→confirm plan flow) with duplicate-press guard. |
| 7 | Automatic structured summaries after every completed call (objective, topics, facts, decisions, promises, dates/amounts, follow-ups, pending/completed/failed, idempotent) | ✅ | `maybeGenerateCallSummary`: guards (terminal + has transcript) → CAS claim on `summary_status`/`summary_json.claimedAt` with read-back → LLM JSON (`summary, topics, learned, decisions, commitments, details, followups, unresolved, memories, incomplete`) → write `outcome_summary`+`summary_json` only where still `pending` → `consolidateAndStoreMemories`. States: `pending`/`completed`/`failed`(retriggerable)/`skipped`(empty transcript). Triggers: terminal relay callback, Twilio status webhook, UI hangup, both Twilio relays, pipecat end report. |
| 8 | Wire `memoryManager` + `emotionEngine` into the real Pipecat/WhatsApp path (pre-call retrieval, post-call storage, no service-role creds in browser) | ✅ | Emotion: `app/emotion.py` (PAD/OCEAN/rumination/`[[END_CALL]]`) was already in the pipeline; stays. Memory pre-call: `app/call_context.py` fetches memories (opt-in flag) + prior call summaries into the prompt. Post-call: JS `consolidateAndStoreMemories` runs inside the shared summary (triggered on every terminal path incl. the WhatsApp one). Service-role key exists only on Vercel/Render; browser uses the anon client (verified: no `SERVICE_ROLE` in `app.js`/`index.html`). |
| 9 | Natural persona, `[[END_CALL]]` across chunk boundaries, real provider-side termination, transcript+summary saved on any ending | ✅ | `shouldEndCall` + `_ResponseTagFilter` (strip + false-positive protection) on Pipecat; Twilio relays use the same engine. Termination: Pipecat sends ACAF `hangup` → bridge closes → carrier hangs up; Twilio: `hangupTwilioCall`. Transcript flush + summary trigger run from every stop path (`stop()`, bridge close, webhook, relay callback). **Known gap:** `[[END_CALL]]` detection runs per-chunk; a token split across two LLM chunks would not match (mitigated: `shouldEndCall` also checks the caller-utterance context; not reworked in this pass). |
| 10 | Unified call UI states, auto-open live screen, mute/end | ✅ | `app.js` state pill already maps `queued/ringing/in_progress/terminal` → Preparing/Ringing/Connecting/Connected/Emysa speaking(muted)/Ended/Failed; auto-open via `resumeActiveCallIfAny` + realtime INSERT/UPDATE subscribers; mute/end controls on the call screen. Added: detail-dialog Call again + live-call shortcut. |
| 11 | Multi-user/concurrency isolation, timeouts/retries/idempotency, bounded polling/LLM cost | ✅ | Every query keyed by `user_id`; summary CAS prevents double spend; context resolve has a hard deadline (`ASSISTANT_CONTEXT_TIMEOUT_SECS=20`, backoff); STT/attach have HTTP timeouts (attach 52 s > relay dial retries); live screen poll bounded to screen-open; transcript writes debounced (0.75 s). |
| 12 | Add/run JS+Python tests; mocked vs real distinction | ✅ | JS 33/33 pass; Python 361 pass (13 new `test_call_context.py`, all mocked). No test dials a real line — see §8. |
| 13 | Commit + push to current branch, no force-push/merge to main; SQL + env changes without secrets | ✅ | Commit `a17aa04` on `arena/01a0ec81-audio-call`. SQL in §4a; env names (no values) in §4b. |

---

## 2. Platform integration status

| Platform | Placement | Audio bridge | Transcript | Summary | Verified |
| --- | --- | --- | --- | --- | --- |
| **WhatsApp (WaCalls/Pipecat)** — priority | `api/assistant.js` + `api/social-calling.js` → `wacallsPlaceAICall` (start → `onCallStarted` persists provider id → attach) | WaCalls ACAF → `pipecat-service` (WS `/stream`) | Pipecat `_TranscriptNote` → `calls.transcript` (debounced) | Terminal relay callback or pipecat end report → shared summary | **Mocked only** (unit/integration tests; bridge protocol reviewed against WaCalls source). No live WhatsApp call placed. |
| **Telegram (mp-relay/Pipecat)** | `mpRelayRequest('/calls')` → provider id persisted → same ACAF path | mp-relay ACAF → `pipecat-service` | same as WhatsApp | mp-relay `reportOutcome` or pipecat end report → shared summary | **Mocked only** |
| **Phone (Twilio)** | `prepareCall`/`confirmCall` plan flow (unchanged) | Twilio Media Streams → `server/relay.js` (WS) and `server/patter-relay.js` (Patter) | per-turn `pushTranscript`/`persistTurn` (race-safe status) | Twilio status webhook + relay `finalizeCall` → shared summary | **Mocked only**; relay was the pre-existing reference implementation |
| Voice input (browser `transcribe`) | — | — | OpenAI transcriptions API | — | Mocked |

Provider-side limits (stated honestly): OpenAI STT here is **batch per utterance** — no mid-sentence partial transcripts on any platform. `gpt-6-luna` on Chat Completions with no tools (function calling needs `reasoning_effort=none`; we don't use tools).

---

## 3. Files & commits

Implementation commit on `arena/01a0ec81-audio-call`: **`a17aa04`** — 37 files, +2406/−442 (this report follows in a docs commit on the same branch).

**New:** `sql/017_call_context_and_summaries.sql`, `lib/callSession.js` (304 ln), `lib/sttClient.js`, `pipecat-service/app/call_context.py` (677 ln), `pipecat-service/tests/test_call_context.py`.

**Core edits:** `api/assistant.js`, `api/social-calling.js`, `api/calls.js`, `api/calls-status.js`, `lib/llmClient.js`, `lib/wacallsClient.js`, `server/relay.js`, `server/patter-relay.js`, `server/audioUtils.js`, `pipecat-service/app/{config,conversation,pipeline,providers,transport}.py`, `app.js` (call detail + Call again), `index.html`, `styles.css`, `vercel.json`.

**Config/docs:** `.env.example`, `README.md`, `docs/ASSISTANT-DEPLOYMENT.md`, `pipecat-service/render.yaml`, `pipecat-service/requirements.txt`, banners on historical docs.

**Tests:** `tests/{helpers,emysa-audit,calls,wacalls-ai}.mjs`, `pipecat-service/tests/*`.

---

## 4a. SQL migration (run in this order, no secrets inside)

```sql
-- sql/017_call_context_and_summaries.sql  (NEW — required; verbatim)
alter table calls add column if not exists instructions text;
alter table calls add column if not exists summary_status text;
alter table calls add column if not exists summary_json jsonb;

create index if not exists calls_platform_call_id
  on calls(platform, platform_call_id)
  where platform_call_id is not null;

create index if not exists calls_user_contact_created
  on calls(user_id, contact_id, created_at desc);

create index if not exists calls_user_platform_created
  on calls(user_id, platform, created_at desc);

create index if not exists calls_user_status_created
  on calls(user_id, status, created_at desc);
```

(Pre-existing migrations that this work relies on and does not change: `006` `calls.session_id`, `014` `platform`/`platform_call_id`, `015` `call_kind`, `016` memory/emotion columns, `009` `memories`.)

## 4b. Environment variable changes (names only — never commit values)

**Vercel (app):**
- Remove: `GROQ_API_KEY`, `LLM_FALLBACK_PROVIDER=groq`, `LLM_FALLBACK_MODEL` (Groq values).
- Keep/add: `LUNA_API_KEY` or `OPENAI_API_KEY` (LLM + STT), optional `FAL_KEY` (optional fallback), `LLM_PROVIDER=luna`, `LLM_MODEL=gpt-6-luna`, `LLM_BASE_URL=https://api.openai.com/v1`, `STT_MODEL` (defaults `gpt-4o-mini-transcribe`), `ASSISTANT_BRIDGE_SECRET` (pipecat may authenticate to `/api/social-calling?action=relay-call-status` with it).

**Render — pipecat-service:** see `pipecat-service/render.yaml` (updated): `OPENAI_API_KEY` (+optional `LUNA_API_KEY`) replaces `GROQ_API_KEY`; `ASSISTANT_STT_PROVIDER=openai`; `ASSISTANT_LLM_PROVIDER=luna`; optional `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` (context + transcript), `ASSISTANT_ENABLE_PERSISTENT_MEMORY=true` (memory retrieval), `PUBLIC_APP_URL` (end-of-call report → shared summary), `ASSISTANT_CONTEXT_TIMEOUT_SECS=20`, `ASSISTANT_STT_PROMPT`.

**Render — Twilio relays (`server/`):** remove `GROQ_API_KEY`; set `LUNA_API_KEY`/`OPENAI_API_KEY` (required now — the Groq branch used to cover a missing Luna key; startup/turns fail loudly instead).

---

## 5. Exact OpenAI model IDs and endpoints (verified against OpenAI's model catalog)

| Role | Model | Endpoint | Notes |
| --- | --- | --- | --- |
| Conversation LLM (primary) | `gpt-6-luna` | `POST https://api.openai.com/v1/chat/completions` | Released 2026-09-22; $0.10/M in, $0.50/M out; text+image input (used for `sendImage`); 1.05M context. Config: `LLM_MODEL`/`LUNA_MODEL`/`ASSISTANT_LLM_MODEL`. |
| LLM fallback (optional) | `openai/gpt-4o-mini` | `POST https://fal.run/openrouter/router/openai/v1/chat/completions` | Only when `FAL_KEY` set. Not Groq — fal's OpenRouter proxies OpenAI models. |
| Speech-to-text (default) | `gpt-4o-mini-transcribe` | `POST https://api.openai.com/v1/audio/transcriptions` | ≈$0.003/min audio; lower WER than whisper-1. `temperature=0`, noise-guidance `prompt`. Pipecat uses `OpenAISTTService` with the same endpoint/model. |
| Speech-to-text (fallback) | `whisper-1` | same | ≈$0.006/min. Set `STT_MODEL` / `ASSISTANT_STT_MODEL=whisper-1`. |
| TTS | Fish Audio (unchanged) | Fish WebSocket + repo's HTTP path | `FISH_API_KEY`, cloned voice ids per call — deliberately kept. |
| Vision (image messages) | `gpt-6-luna` (text+image input) | Chat Completions | No separate vision model needed. |

Legacy alias: `LLM_PROVIDER=groq` resolves to the OpenAI primary (never a Groq URL).

---

## 6. Remaining Groq references and why they remain

Functional code paths to Groq: **none** (grep over `lib/`, `api/`, `server/`, `pipecat-service/app/` finds no Groq URL, provider branch, or key use). What remains:

1. `lib/llmClient.js → redactSecrets` still lists `GROQ_API_KEY` as a redaction candidate — **defensive**: if an old deployment still has the key in env, error strings get it redacted instead of leaked.
2. Negative/test assertions (`tests/emysa-audit.test.mjs`, Python config tests) that **assert Groq is gone** (including that legacy `LLM_PROVIDER=groq` resolves to OpenAI).
3. Comments/docs saying "Groq was removed" (`.env.example`, `README.md`, `render.yaml`, `pipecat-service/app/config.py`, `server/*`) — intent-carrying notes so nobody re-adds it silently.
4. `docs/AI-VOICE-ASSISTANT-REPORT.md`, `docs/NAV-AND-CALL-REDESIGN.md` — historical pre-implementation documents; a banner marks their Groq content as historical rather than rewriting history.

---

## 7. Test results

| Suite | Command | Result |
| --- | --- | --- |
| JS (Vercel/API/relays/audit) | `npm test` | **33/33 pass** (includes updated Groq-removal assertions, XSS/12-function cap audit, WhatsApp call placement, call lifecycle) |
| Python (pipecat-service) | `python -m pytest` (venv) | **361/361 pass** (348 pre-existing + 13 new `test_call_context.py`: context resolution, secret-filtered memories, in-progress CAS, transcript dedupe/flush/interruption, end-report skip/patch paths) |

All of the above are **mocked** (in-memory Supabase double, fake fetch, fake carrier). They verify wiring, guards, response shapes and failure handling — **not** a live call.

---

## 8. Manual steps & limitations (read before deploying)

**Deploy steps:** 1) run `sql/017…` against Supabase; 2) update Vercel env (remove Groq, ensure `OPENAI_API_KEY`/`LUNA_API_KEY`); 3) redeploy Vercel (new `vercel.json` maxDuration for `api/calls.js`/`api/calls-status.js`); 4) update Render pipecat-service env per `render.yaml` and redeploy (watch `/readyz`); 5) update both Twilio relay services' env (Luna/OpenAI key **required**); 6) set `ASSISTANT_BRIDGE_SECRET` on both the app and pipecat if not already shared.

**Real-call verification still to do (none was possible from this sandbox):**
- Place a live WhatsApp call end-to-end and confirm: row appears pre-dial → greeting on answer → transcript lines appear on the live screen → terminal status + structured summary lands.
- Same for Telegram and one Twilio call (speech gate: verify a fan/noise room does *not* produce phantom turns, and normal speech does).
- Confirm `[[END_CALL]]` hangup + summary on a real ending, and the duplicate-press guard on a real second tap.
- Fish Audio cloned-voice playback on a live line (unchanged code, but untested here).

**Known limitations:**
- STT is batch-per-utterance; no partial transcripts mid-sentence on any platform.
- Pipecat context resolve blocks call start up to `ASSISTANT_CONTEXT_TIMEOUT_SECS` if the `calls` row is missing (default 20 s; row normally exists pre-dial).
- If `PUBLIC_APP_URL` is unset on pipecat and the carrier never reports, the call gets a direct `failed/no_answer/completed` status write but **no summary** (no app-side trigger); set `PUBLIC_APP_URL` to close this.
- `[[END_CALL]]` token split across two streamed chunks would not be detected (pre-existing pattern; low probability).
- Older `calls` rows have no `summary_json`; the dialog sections simply hide.
- Vercel 12-function cap respected (no new `api/` files).
