-- 029: call-attempt state, retry chain, and call-derived memory integrity.
--
-- Additive and repeatable (IF NOT EXISTS / conditional DO blocks). Nothing is
-- dropped except one redundant foreign key that is replaced by a stricter one
-- (see "memories ownership" below). NOT applied by merging this file: run it in
-- the Supabase SQL editor. The app and the assistant service both degrade to the
-- old behaviour (no attempt facts, unfiltered memory status) until it is applied,
-- and log that they did.
--
-- 1. CALL ATTEMPTS
--    A retry ("try again") is a NEW calls row that points at the first attempt of
--    the same request. Each row keeps its own provider events, so a late event
--    from attempt 1 can never be read as part of attempt 2.
--      retry_of        the first attempt of this request (the chain root)
--      attempt_number  1, 2, 3 ... within the chain
--      attempt_events  append-only provider events for THIS row:
--                      [{"state": "requested|initiated|ringing|answered|ended|failed|unknown",
--                        "at": iso, "source": "app|relay|carrier|assistant", "code": optional}]
--      failure_scope   why an attempt failed, for the OWNER's screens only:
--                      owner_link (the owner's own WhatsApp link), provider_temporary,
--                      provider, recipient, unknown. Never read into a call prompt.
alter table calls add column if not exists retry_of uuid references calls(id) on delete set null;
alter table calls add column if not exists attempt_number integer not null default 1;
alter table calls add column if not exists attempt_events jsonb not null default '[]'::jsonb;
alter table calls add column if not exists failure_scope text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'calls_failure_scope_check') then
    alter table calls add constraint calls_failure_scope_check
      check (failure_scope is null or failure_scope in ('owner_link', 'provider_temporary', 'provider', 'recipient', 'unknown'));
  end if;
end $$;

-- One row per (chain, attempt number): two simultaneous "try again" requests race
-- on this index and exactly one wins; the loser reads the winner's row.
create unique index if not exists calls_retry_attempt_unique
  on calls (retry_of, attempt_number) where retry_of is not null;
create index if not exists calls_retry_of_idx on calls (retry_of) where retry_of is not null;

-- 2. CALL-DERIVED MEMORIES (table `memories`, written by the app after a call)
--    These are facts learned from a conversation with one contact. `status`
--    separates what was said clearly (confirmed) from an interpretation
--    (uncertain); only confirmed rows are ever put in a call prompt. A correction
--    updates the row in place and keeps what it replaced.
--      observed_at       when the fact was said (the call), not when it was saved
--      evidence          the short caller utterance that supports it
--      previous_content  the text this row replaced, when a later call corrected it
-- updated_at normally exists from sql/016; repeated here so this file never depends on it.
alter table memories add column if not exists updated_at timestamptz not null default now();
alter table memories add column if not exists status text not null default 'confirmed';
alter table memories add column if not exists observed_at timestamptz;
alter table memories add column if not exists evidence text;
alter table memories add column if not exists previous_content text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'memories_status_check') then
    alter table memories add constraint memories_status_check
      check (status in ('confirmed', 'uncertain', 'superseded'));
  end if;
end $$;

create index if not exists memories_contact_status_idx
  on memories (user_id, contact_id, status, updated_at desc) where contact_id is not null;

-- memories ownership: a memory must reference a contact owned by the SAME user.
-- The old single-column foreign key allowed a row for user A to point at user B's
-- contact. It is replaced by the composite key (contacts_id_user_id_key comes from
-- sql/026). NOT VALID: new and updated rows are checked immediately; existing rows
-- are validated by the statement at the end of this file, which you can run once
-- you have reviewed any rows it reports.
do $$
begin
  if exists (select 1 from pg_constraint where conname = 'contacts_id_user_id_key')
     and not exists (select 1 from pg_constraint where conname = 'memories_contact_owner_fk') then
    alter table memories drop constraint if exists memories_contact_id_fkey;
    alter table memories add constraint memories_contact_owner_fk
      foreign key (contact_id, user_id) references contacts (id, user_id) on delete cascade not valid;
  end if;
end $$;

-- RLS: `memories` is readable by its owner and written only by the server
-- (service role, which bypasses RLS). There is deliberately no insert/update
-- policy for end users: a client can never write or alter what Emysa "remembers".
alter table memories enable row level security;
drop policy if exists "read own memories" on memories;
create policy "read own memories" on memories for select using (auth.uid() = user_id);

-- After reviewing: select id, user_id, contact_id from memories m
--   where contact_id is not null and not exists
--   (select 1 from contacts c where c.id = m.contact_id and c.user_id = m.user_id);
-- then: alter table memories validate constraint memories_contact_owner_fk;
