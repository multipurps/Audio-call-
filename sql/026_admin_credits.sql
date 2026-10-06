-- Admin credits + provider cost rates.
-- Apply BEFORE deploying the admin update.
--
-- credit_ledger records every manual grant/removal made from the admin panel.
-- Purchased minutes are already recorded in minute_purchases, so the panel
-- merges the two when it shows a user's history.
-- admin_settings is service-role only (no policies on purpose), unlike
-- app_settings which anyone can read.

create table if not exists credit_ledger (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  minutes numeric not null check (minutes <> 0),
  source text not null default 'admin',
  note text,
  created_at timestamptz not null default now()
);
create index if not exists credit_ledger_user_idx on credit_ledger (user_id, created_at desc);
alter table credit_ledger enable row level security;

create table if not exists admin_settings (
  key text primary key,
  value jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
alter table admin_settings enable row level security;

-- Atomic: adjusts bonus_minutes (never below 0) and logs it in one transaction.
create or replace function admin_grant_minutes(p_user uuid, p_minutes numeric, p_note text)
returns numeric
language plpgsql
security definer
set search_path = public
as $$
declare v_bonus numeric;
begin
  insert into user_usage (user_id, bonus_minutes)
  values (p_user, greatest(0, p_minutes))
  on conflict (user_id) do update
    set bonus_minutes = greatest(0, user_usage.bonus_minutes + p_minutes),
        updated_at = now()
  returning bonus_minutes into v_bonus;

  insert into credit_ledger (user_id, minutes, source, note)
  values (p_user, p_minutes, 'admin', nullif(trim(p_note), ''));
  return v_bonus;
end;
$$;
revoke all on function admin_grant_minutes(uuid, numeric, text) from public, anon, authenticated;
grant execute on function admin_grant_minutes(uuid, numeric, text) to service_role;
