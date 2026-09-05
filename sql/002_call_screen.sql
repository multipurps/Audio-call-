alter table calls add column if not exists ai_muted boolean not null default false;

-- Lets the call screen subscribe to live transcript/status updates via
-- Supabase Realtime instead of polling.
alter publication supabase_realtime add table calls;
