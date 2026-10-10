-- 031: linked-account logins survive deploys. mp-relay creates this itself on first use;
-- run it here to create it ahead of time. Service-role/DB-user only (RLS on, no policies).
create table if not exists linked_account_sessions (
  provider   text not null,
  user_id    text not null,
  archive    text not null,
  sha        text not null,
  updated_at timestamptz not null default now(),
  primary key (provider, user_id)
);
alter table linked_account_sessions enable row level security;
