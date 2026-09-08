create table if not exists chat_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null default 'New chat',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table assistant_messages add column if not exists session_id uuid references chat_sessions(id) on delete cascade;
alter table calls add column if not exists session_id uuid references chat_sessions(id) on delete set null;

alter table chat_sessions enable row level security;
create policy "read own chat sessions" on chat_sessions for select using (auth.uid() = user_id);
-- No insert/update/delete policy on purpose: writes only ever happen via
-- api/assistant.js using the service-role key.
