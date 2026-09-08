create table if not exists app_settings (
  key text primary key,
  value text,
  updated_at timestamptz not null default now()
);
alter table app_settings enable row level security;
drop policy if exists "anyone can read settings" on app_settings;
create policy "anyone can read settings" on app_settings for select using (true);
-- No insert/update/delete policy on purpose: writes only ever happen via
-- api/admin-upload-background.js using the service-role key.

insert into storage.buckets (id, name, public)
values ('app-assets', 'app-assets', true)
on conflict (id) do nothing;

drop policy if exists "public read app-assets" on storage.objects;
create policy "public read app-assets" on storage.objects
  for select using (bucket_id = 'app-assets');
