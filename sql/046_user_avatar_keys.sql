-- Run once in the Supabase SQL editor for the Emysa (audio call) project. Safe to re-run.
-- Stores only which Anam avatar a person picked. API keys are NOT stored here: they live in
-- the server environment (ANAM_API_KEY, XMAX_API_KEY on Vercel / Render).
create table if not exists user_video_settings (
  user_id uuid primary key,
  anam_avatar_id text,
  anam_avatar_name text,
  updated_at timestamptz default now()
);
alter table user_video_settings enable row level security;
