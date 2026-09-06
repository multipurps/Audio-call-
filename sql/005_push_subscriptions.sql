create table if not exists push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now()
);

create table if not exists announcements (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  body text not null,
  created_at timestamptz not null default now()
);

alter table push_subscriptions enable row level security;
alter table announcements enable row level security;

create policy "write own push subscription" on push_subscriptions for all using (auth.uid() = user_id);
create policy "read announcements" on announcements for select using (true);
-- No insert/update/delete policy on announcements on purpose: writes only
-- ever happen via api/send-announcement.js using the service-role key.
