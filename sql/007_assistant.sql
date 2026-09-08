-- Home-screen assistant chat: named contacts (so you can say "call Juicy Jay"
-- instead of typing a phone number) + a persisted message thread + a link
-- from calls back to the contact/message that triggered them, so the Twilio
-- status webhook can post a natural-language follow-up ("busy", "no answer",
-- etc.) into the same thread asynchronously.

create table if not exists contacts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  phone_number text not null,
  created_at timestamptz not null default now()
);

create table if not exists assistant_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('user','assistant')),
  content text not null,
  call_id uuid references calls(id) on delete set null,
  created_at timestamptz not null default now()
);

alter table calls add column if not exists contact_id uuid references contacts(id) on delete set null;

alter table contacts enable row level security;
alter table assistant_messages enable row level security;

-- Reads happen directly from the client (so the chat can be shown without a
-- round trip through an api/*.js poll-only endpoint); all writes go through
-- api/contacts.js and api/assistant.js using the service-role key, same
-- pattern as the rest of this app.
drop policy if exists "read own contacts" on contacts;
create policy "read own contacts" on contacts for select using (auth.uid() = user_id);
drop policy if exists "write own contacts" on contacts;
create policy "write own contacts" on contacts for all using (auth.uid() = user_id);
drop policy if exists "read own assistant messages" on assistant_messages;
create policy "read own assistant messages" on assistant_messages for select using (auth.uid() = user_id);
