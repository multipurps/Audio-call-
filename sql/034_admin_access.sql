-- Admin access for more than one person. Safe to re-run.
--
-- The owner is still the account whose email is ADMIN_EMAIL (Vercel env). The
-- owner approves other accounts here. An approved admin gets every admin
-- feature (including revenue) except approving other admins.
--
-- Matched on the lower-cased email of a signed-in account whose email is
-- confirmed. Only the server (service role) reads or writes this table: RLS is
-- on with no policies, so the app's anon/authenticated keys cannot touch it.

create table if not exists admin_access (
  email text primary key,
  user_id uuid references auth.users(id) on delete set null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'revoked')),
  requested_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by text
);

alter table admin_access drop constraint if exists admin_access_email_lowercase;
alter table admin_access add constraint admin_access_email_lowercase check (email = lower(email));

alter table admin_access enable row level security;
