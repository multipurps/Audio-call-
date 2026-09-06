-- Replaces the single app_settings.auth_background_url with a gallery table so
-- the admin can upload multiple images and the client auto-rotates through them
-- on the welcome/login/signup screens.

create table if not exists auth_backgrounds (
  id uuid primary key default gen_random_uuid(),
  url text not null,
  storage_path text not null,
  created_at timestamptz not null default now()
);

alter table auth_backgrounds enable row level security;
create policy "public read auth backgrounds" on auth_backgrounds for select using (true);
-- No insert/update/delete policy on purpose: writes only ever happen via
-- api/admin-upload-background.js using the service-role key.
