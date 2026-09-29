-- 017: Call context + persistent summaries for the unified call system.
--
-- Additive and repeatable: only new nullable columns and indexes, no data is
-- modified or removed. Safe to run more than once (every statement uses
-- IF NOT EXISTS / conditional DO blocks).
--
-- What these columns are for:
--   * instructions    — the user's own pre-call instructions for THIS call,
--                       stored separately from `objective` so the AI pipeline
--                       receives "why" (objective) and "how" (instructions)
--                       exactly as the user wrote them. Written by
--                       api/assistant.js and api/social-calling.js when a
--                       WhatsApp/Telegram call is placed, read by the
--                       pipecat-service when it builds the per-call prompt.
--   * summary_status  — async summary lifecycle: NULL (never attempted),
--                       'pending' (a worker claimed it), 'completed',
--                       'failed' (retryable), 'skipped' (no transcript to
--                       summarise). Used as a compare-and-set claim so two
--                       triggers (relay callback + hangup webhook) cannot
--                       both generate a summary for the same call.
--   * summary_json    — structured summary (topics, decisions, commitments,
--                       follow-ups, unresolved questions, uncertainty flag),
--                       shown in the conversation history / call detail view.
--                       Also carries the transient `claimedAt` timestamp used
--                       for the CAS claim.

alter table calls add column if not exists instructions text;
alter table calls add column if not exists summary_status text;
alter table calls add column if not exists summary_json jsonb;

-- pipecat-service resolves "which calls row is this bridge connection for?"
-- with: platform = X AND platform_call_id = Y (the bridge session id is
-- "call-" + the provider call id, which is what we store here).
create index if not exists calls_platform_call_id
  on calls(platform, platform_call_id)
  where platform_call_id is not null;

-- Person-centred conversation history: every call with the same contact,
-- newest first, scoped to the authenticated user.
create index if not exists calls_user_contact_created
  on calls(user_id, contact_id, created_at desc);

-- Recents / status reconciliation lookups by platform call id alone
-- (relay-call-status can arrive with only a platform id).
create index if not exists calls_user_platform_created
  on calls(user_id, platform, created_at desc);

-- Transcript status transitions are checked before every update by the
-- assistant service and the summary claim path.
create index if not exists calls_user_status_created
  on calls(user_id, status, created_at desc);
