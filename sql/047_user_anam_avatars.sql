-- Run once in the Supabase SQL editor for the Emysa (audio call) project. Safe to re-run.
-- Each person's own Anam avatars. Only the server writes here (service role). API keys are NOT
-- stored here: they live in the server environment (ANAM_API_KEY, XMAX_API_KEY).
create table if not exists user_video_settings (
  user_id uuid primary key,
  anam_avatar_id text,
  anam_avatar_name text,
  updated_at timestamptz default now()
);
alter table user_video_settings enable row level security;

create table if not exists user_anam_avatars (
  anam_avatar_id text primary key,
  user_id uuid not null,
  display_name text not null,
  source text not null default 'upload',   -- 'upload' = created from the Video call avatar picture; 'linked' = an existing Anam avatar linked by the owner
  created_at timestamptz default now()
);
create index if not exists user_anam_avatars_user_idx on user_anam_avatars (user_id);
alter table user_anam_avatars enable row level security;
