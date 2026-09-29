-- Tiered persistent memory (Letta-inspired: semantic, episodic, emotional, working)
-- and OpenFeelz-based persistent emotional state (PAD + OCEAN + rumination).

alter table memories
  add column if not exists memory_type text not null default 'semantic'
    check (memory_type in ('semantic', 'episodic', 'emotional', 'working')),
  add column if not exists subject_key text,
  add column if not exists importance real not null default 0.7,
  add column if not exists confidence real not null default 0.85,
  add column if not exists emotional_valence real not null default 0,
  add column if not exists emotional_arousal real not null default 0,
  add column if not exists updated_at timestamptz not null default now();

create index if not exists idx_memories_user_type
  on memories(user_id, memory_type, created_at desc);

create index if not exists idx_memories_user_subject
  on memories(user_id, subject_key)
  where subject_key is not null;

-- Persistent affective & relationship state per user (and optional contact)
create table if not exists user_emotional_states (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  contact_id uuid references contacts(id) on delete cascade,
  state_json jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  unique nulls not distinct (user_id, contact_id)
);

create index if not exists idx_user_emotional_states_lookup
  on user_emotional_states(user_id, contact_id);

alter table user_emotional_states enable row level security;

drop policy if exists "read own emotional states" on user_emotional_states;
create policy "read own emotional states"
  on user_emotional_states for select
  using (auth.uid() = user_id);
