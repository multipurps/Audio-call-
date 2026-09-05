-- Audio Call: core schema
-- Mirrors the approval-gate pattern used in Live Call (user_approvals table,
-- ADMIN_EMAIL checked server-side in api/admin-set-approval.js).

create table if not exists user_approvals (
  user_id uuid primary key references auth.users(id) on delete cascade,
  approved boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  name text,
  region text,
  theme text default 'coffee-emerald',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One cloned voice per user for now (matches "clone my voice" MVP flow).
create table if not exists voice_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  provider text not null default 'fish', -- 'fish' | 'cartesia'
  provider_voice_id text,
  status text not null default 'pending', -- pending | ready | failed
  created_at timestamptz not null default now()
);

create table if not exists ai_callers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  personality text not null default 'natural', -- natural | professional | friendly | direct
  instructions text,
  voice_source text not null default 'cloned', -- 'cloned' | 'library'
  library_voice_id text,
  created_at timestamptz not null default now()
);

create table if not exists calls (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  caller_id uuid references ai_callers(id) on delete set null,
  to_number text not null,
  objective text not null,
  twilio_call_sid text,
  status text not null default 'queued', -- queued | ringing | in_progress | completed | failed | no_answer
  outcome_summary text,
  transcript jsonb,
  duration_seconds int,
  recording_url text,
  created_at timestamptz not null default now(),
  ended_at timestamptz
);

create table if not exists user_usage (
  user_id uuid primary key references auth.users(id) on delete cascade,
  call_minutes_used numeric not null default 0,
  monthly_minute_limit numeric not null default 60,
  period_start date not null default date_trunc('month', now()),
  updated_at timestamptz not null default now()
);

alter table user_approvals enable row level security;
alter table profiles enable row level security;
alter table voice_profiles enable row level security;
alter table ai_callers enable row level security;
alter table calls enable row level security;
alter table user_usage enable row level security;

-- Users can read their own rows; all writes to approvals/usage happen via
-- the service-role key in api/*.js (same pattern as Live Call), never
-- directly from the client.
create policy "read own approval" on user_approvals for select using (auth.uid() = user_id);
create policy "read own profile" on profiles for select using (auth.uid() = user_id);
create policy "write own profile" on profiles for all using (auth.uid() = user_id);
create policy "read own voice" on voice_profiles for select using (auth.uid() = user_id);
create policy "read own callers" on ai_callers for select using (auth.uid() = user_id);
create policy "write own callers" on ai_callers for all using (auth.uid() = user_id);
create policy "read own calls" on calls for select using (auth.uid() = user_id);
create policy "read own usage" on user_usage for select using (auth.uid() = user_id);
