-- Home screen hero GIF. One row at a time: the admin panel uploads the GIF
-- straight to the existing public 'app-assets' storage bucket (under home-hero/)
-- and api/admin.js records it here. Uploading a new one replaces the old row.

create table if not exists home_hero (
  id uuid primary key default gen_random_uuid(),
  url text not null,
  storage_path text not null,
  created_at timestamptz not null default now()
);

alter table home_hero enable row level security;
drop policy if exists "public read home hero" on home_hero;
create policy "public read home hero" on home_hero for select using (true);
-- No insert/update/delete policy on purpose: writes only happen via
-- api/admin.js (action=confirm-hero / delete-hero) with the service-role key.
