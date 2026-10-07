-- Phase 3: imported WhatsApp history -> reviewed per-contact memories.
-- Apply BEFORE deploying the matching API/app code. Safe to re-run.
--
-- Flow:  export (.txt/.zip) -> private storage (original kept as the source)
--        -> parsed -> candidate memories -> user review -> approved memories
-- At call time only APPROVED/EDITED memories (plus a few short retrieved
-- snippets when relevant) reach the live model. The raw chat never does.
--
-- Isolation is enforced three ways, so no single bug can leak a contact's data:
--   1. every row carries user_id and RLS only allows auth.uid() = user_id;
--   2. composite foreign keys (contact_id, user_id) -> contacts(id, user_id)
--      make it impossible to attach a row to ANOTHER user's contact, even for
--      code running with the service role (which bypasses RLS);
--   3. every lookup function takes user_id AND contact_id and re-checks them.

create extension if not exists vector;

-- Needed as the target of the composite foreign keys below.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'contacts_id_user_id_key') then
    alter table contacts add constraint contacts_id_user_id_key unique (id, user_id);
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Imported exports. The original file lives in the private 'whatsapp-imports'
-- bucket (service role only: no storage policies exist, so anon/authenticated
-- users are denied by default). This row is the reference to it.
-- ---------------------------------------------------------------------------
create table if not exists whatsapp_imports (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  contact_id uuid not null,
  original_filename text not null,
  source_kind text not null check (source_kind in ('txt', 'zip')),
  size_bytes bigint,
  sha256 text,
  storage_path text,            -- original export, exactly as uploaded
  chat_text_path text,          -- the chat .txt extracted from a zip (or the txt itself)
  status text not null default 'uploading'
    check (status in ('uploading', 'uploaded', 'parsed', 'analyzing', 'analyzed', 'failed')),
  error text,
  participants jsonb not null default '[]'::jsonb,
  contact_participant text,     -- which sender in the chat is this contact
  self_participant text,        -- which sender is the app user
  identified_by text check (identified_by in ('phone', 'name', 'only_other', 'user')),
  is_group boolean not null default false,
  date_order text check (date_order in ('dmy', 'mdy', 'ymd')),
  date_order_ambiguous boolean not null default false,
  message_count integer not null default 0,
  media_count integer not null default 0,
  has_media boolean not null default false,
  first_message_at timestamptz,
  last_message_at timestamptz,
  ai_consent_at timestamptz,    -- user agreed to send message text to the AI provider
  analysis_cursor integer not null default 0,
  analysis_total integer not null default 0,
  chunk_count integer not null default 0,
  indexed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, user_id),
  unique (user_id, contact_id, sha256),
  foreign key (contact_id, user_id) references contacts (id, user_id) on delete cascade
);
create index if not exists whatsapp_imports_contact_idx on whatsapp_imports (user_id, contact_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Optional semantic/keyword index of the whole conversation, in small chunks.
-- Retrieval pulls a few relevant chunks; nothing ever sends the full chat.
-- 'simple' text search config: language-agnostic (WhatsApp chats mix languages).
-- ---------------------------------------------------------------------------
create table if not exists whatsapp_import_chunks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  contact_id uuid not null,
  import_id uuid not null,
  chunk_index integer not null,
  started_at timestamptz,
  ended_at timestamptz,
  first_message_index integer,
  last_message_index integer,
  content text not null,
  fts tsvector generated always as (to_tsvector('simple', content)) stored,
  embedding vector(1536),       -- filled only when an embeddings key is configured
  created_at timestamptz not null default now(),
  unique (import_id, chunk_index),
  foreign key (contact_id, user_id) references contacts (id, user_id) on delete cascade,
  foreign key (import_id, user_id) references whatsapp_imports (id, user_id) on delete cascade
);
create index if not exists whatsapp_import_chunks_contact_idx on whatsapp_import_chunks (user_id, contact_id);
create index if not exists whatsapp_import_chunks_fts_idx on whatsapp_import_chunks using gin (fts);
create index if not exists whatsapp_import_chunks_embedding_idx
  on whatsapp_import_chunks using hnsw (embedding vector_cosine_ops);

-- ---------------------------------------------------------------------------
-- The memories themselves. Everything extracted starts as 'candidate' and is
-- never used on a call until the user approves (or edits) it.
-- ---------------------------------------------------------------------------
create table if not exists contact_memories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  contact_id uuid not null,
  import_id uuid,
  memory_type text not null check (memory_type in (
    'identity', 'preferences', 'communication_style', 'important_relationships',
    'recurring_facts', 'previous_context', 'unresolved_issues', 'commitments',
    'important_dates', 'caller_preferences'
  )),
  memory_text text not null check (char_length(btrim(memory_text)) between 1 and 500),
  confidence numeric(3, 2) not null default 0.5 check (confidence between 0 and 1),
  is_inferred boolean not null default true,  -- true = the model concluded it, it was not stated outright
  source_message text,          -- the message that supports it, copied from the export
  source_message_index integer,
  source_date timestamptz,
  status text not null default 'candidate' check (status in ('candidate', 'approved', 'rejected', 'edited')),
  original_text text,           -- what the extractor wrote, kept when the user edits
  text_hash text generated always as (md5(lower(btrim(memory_text)))) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  reviewed_at timestamptz,
  foreign key (contact_id, user_id) references contacts (id, user_id) on delete cascade,
  -- deleting an import keeps reviewed memories; only the pointer is cleared
  foreign key (import_id, user_id) references whatsapp_imports (id, user_id) on delete set null (import_id)
);
create index if not exists contact_memories_contact_idx on contact_memories (user_id, contact_id, status);
-- A re-run never resurfaces something already rejected or duplicated.
create unique index if not exists contact_memories_unique_text on contact_memories (user_id, contact_id, text_hash);

create or replace function contact_memory_touch() returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;
drop trigger if exists whatsapp_imports_touch on whatsapp_imports;
create trigger whatsapp_imports_touch before update on whatsapp_imports for each row execute function contact_memory_touch();
drop trigger if exists contact_memories_touch on contact_memories;
create trigger contact_memories_touch before update on contact_memories for each row execute function contact_memory_touch();

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------
alter table whatsapp_imports enable row level security;
alter table whatsapp_import_chunks enable row level security;
alter table contact_memories enable row level security;

drop policy if exists "own imports" on whatsapp_imports;
create policy "own imports" on whatsapp_imports for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own chunks" on whatsapp_import_chunks;
create policy "own chunks" on whatsapp_import_chunks for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own contact memories" on contact_memories;
create policy "own contact memories" on contact_memories for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- Private bucket for the original exports. No storage.objects policies on
-- purpose: only the server (service role, signed upload URLs) can touch it.
-- Keep each file under the bucket/project upload limit (50 MB by default).
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('whatsapp-imports', 'whatsapp-imports', false)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Lookups. SECURITY INVOKER (the default), so RLS applies to user sessions,
-- and each one also pins user_id to the caller: a user JWT can never ask for
-- another user's id. The service role has no auth.uid(), so the server passes
-- both ids explicitly.
-- ---------------------------------------------------------------------------

-- Which of THIS user's contacts has this phone number? Digits only, exact
-- match (never a partial/suffix match: a wrong match would leak another
-- person's memories into a call). More than one row = ambiguous.
create or replace function find_contact_by_phone(p_user_id uuid, p_phone text)
returns table (contact_id uuid, contact_name text)
language sql stable
as $$
  select c.id, c.name
    from contacts c
   where c.user_id = p_user_id
     and p_user_id = coalesce(auth.uid(), p_user_id)
     and nullif(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g'), '') is not null
     and regexp_replace(coalesce(c.phone_number, ''), '\D', '', 'g') = regexp_replace(p_phone, '\D', '', 'g')
   limit 5;
$$;

-- Keyword retrieval over one contact's imported history.
create or replace function search_contact_history(p_user_id uuid, p_contact_id uuid, p_query text, p_limit integer default 3)
returns table (chunk_id uuid, started_at timestamptz, content text, rank real)
language sql stable
as $$
  select k.id, k.started_at, k.content, ts_rank(k.fts, q.query) as rank
    from whatsapp_import_chunks k,
         lateral (select websearch_to_tsquery('simple', p_query) as query) q
   where k.user_id = p_user_id
     and k.contact_id = p_contact_id
     and p_user_id = coalesce(auth.uid(), p_user_id)
     and k.fts @@ q.query
   order by rank desc, k.started_at desc
   limit least(greatest(coalesce(p_limit, 3), 1), 8);
$$;

-- Semantic retrieval (only chunks that have an embedding).
create or replace function match_contact_history(p_user_id uuid, p_contact_id uuid, p_embedding vector(1536), p_limit integer default 3)
returns table (chunk_id uuid, started_at timestamptz, content text, similarity double precision)
language sql stable
as $$
  select k.id, k.started_at, k.content, 1 - (k.embedding <=> p_embedding) as similarity
    from whatsapp_import_chunks k
   where k.user_id = p_user_id
     and k.contact_id = p_contact_id
     and p_user_id = coalesce(auth.uid(), p_user_id)
     and k.embedding is not null
   order by k.embedding <=> p_embedding
   limit least(greatest(coalesce(p_limit, 3), 1), 8);
$$;

revoke all on function find_contact_by_phone(uuid, text) from public, anon;
revoke all on function search_contact_history(uuid, uuid, text, integer) from public, anon;
revoke all on function match_contact_history(uuid, uuid, vector, integer) from public, anon;
grant execute on function find_contact_by_phone(uuid, text) to authenticated, service_role;
grant execute on function search_contact_history(uuid, uuid, text, integer) to authenticated, service_role;
grant execute on function match_contact_history(uuid, uuid, vector, integer) to authenticated, service_role;
