-- Apply before deploying the nav/call redesign. Requires the existing contacts,
-- assistant_messages, chat_sessions and calls migrations (007_assistant must
-- precede 006_chat_sessions on a fresh database despite the legacy filenames).
-- Contacts and chat history reuse existing tables; no replacement or data reset.
create table if not exists call_plans (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  session_id uuid not null references chat_sessions(id) on delete cascade,
  message_id uuid not null unique references assistant_messages(id) on delete cascade,
  contact_id uuid references contacts(id) on delete set null,
  call_id uuid references calls(id) on delete set null,
  to_number text not null,
  objective text not null,
  script text not null,
  summary text not null,
  label text not null,
  kind text not null default 'contact' check (kind in ('contact', 'emysa')),
  status text not null default 'pending' check (status in ('pending', 'placing', 'placed', 'failed', 'cancelled', 'uncertain')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '24 hours')
);
create unique index if not exists call_plans_one_pending_per_session on call_plans(user_id, session_id) where status = 'pending';
create index if not exists call_plans_user_session on call_plans(user_id, session_id);
create index if not exists calls_user_session on calls(user_id, session_id);
alter table call_plans enable row level security;
drop policy if exists "read own call plans" on call_plans;
create policy "read own call plans" on call_plans for select using (auth.uid() = user_id);
-- No client write policies: only authenticated API handlers using service role
-- can create/claim a plan or set its destination, script, expiry and status.

-- Lets the voice relay distinguish Emysa-to-user callbacks from contact calls.
alter table calls add column if not exists call_kind text not null default 'contact'
  check (call_kind in ('contact', 'emysa'));
