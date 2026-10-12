-- Call mood (Home screen "Mood" button). The app stores ONE short value per call:
--   angry | angry_argue | sassy | sweet | jovial | sad | talkative   (natural = null)
-- Run in the Supabase SQL editor. Safe to run more than once.
alter table calls add column if not exists mood text;
alter table call_plans add column if not exists mood text;

-- If an earlier version of this migration added a CHECK that does not know "sassy", drop it:
-- otherwise a Sassy call would be placed WITHOUT its mood. The server validates the value.
alter table calls drop constraint if exists calls_mood_check;
alter table call_plans drop constraint if exists call_plans_mood_check;
