-- 018: Answer timestamp for the unified call system.
--
-- Additive and repeatable: one nullable column + one index. No data is
-- modified or removed. Safe to run more than once.
--
-- What this column is for:
--   * answered_at — the moment the PROVIDER reported the actual answer
--                   (ACAF `call_active` / the relay's answered event). The
--                   conversation timer on the live call screen and the
--                   recorded talk duration both run from this instant —
--                   never from dial time and never from "first audio frame".
--                   Ring duration stays derivable as (answered_at -
--                   created_at); a call that never answered has NULL here.
--
-- Written by: pipecat-service (app/call_context.py set_in_progress) and
-- api/social-calling.js (relay-call-status answer transitions).
-- Read by:    api/calls.js hangup (duration), api/social-calling.js
--             (duration derivation), app.js (timer).

alter table calls add column if not exists answered_at timestamptz;

-- Answer events are looked up while a call is live (status transitions),
-- and the history view filters by user + answered time.
create index if not exists calls_user_answered_at
  on calls(user_id, answered_at desc)
  where answered_at is not null;
