-- Add time: minutes bought through Bachs hosted checkout.
-- Apply BEFORE deploying the app/API update.
--
-- A purchase row is created (pending) when the user taps a pack, and is flipped
-- to paid exactly once by credit_minute_purchase(), which also adds the minutes
-- to user_usage.bonus_minutes in the same transaction. The balance shown in the
-- app is: monthly_minute_limit + bonus_minutes - call_minutes_used.

create table if not exists minute_purchases (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  reference text not null unique,
  pack_id text not null,
  minutes numeric not null check (minutes > 0),
  amount numeric not null check (amount > 0),
  currency text not null,
  checkout_id text unique,
  checkout_url text,
  status text not null default 'pending' check (status in ('pending', 'paid', 'expired', 'cancelled')),
  created_at timestamptz not null default now(),
  paid_at timestamptz
);

create index if not exists minute_purchases_user_idx on minute_purchases (user_id, created_at desc);

alter table minute_purchases enable row level security;
-- Users may read their own purchases; every write goes through the server API.
drop policy if exists "read own purchases" on minute_purchases;
create policy "read own purchases" on minute_purchases for select using (auth.uid() = user_id);

-- Idempotent and atomic: a replayed webhook, or a webhook racing the app's own
-- verify call, credits the minutes once. Returns the minutes credited (0 when
-- the purchase was already paid or does not exist).
create or replace function credit_minute_purchase(p_reference text)
returns numeric
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid;
  v_minutes numeric;
begin
  update minute_purchases
     set status = 'paid', paid_at = now()
   where reference = p_reference and status = 'pending'
  returning user_id, minutes into v_user, v_minutes;

  if v_user is null then
    return 0;
  end if;

  insert into user_usage (user_id, bonus_minutes)
  values (v_user, v_minutes)
  on conflict (user_id) do update
    set bonus_minutes = user_usage.bonus_minutes + excluded.bonus_minutes,
        updated_at = now();

  return v_minutes;
end;
$$;

revoke all on function credit_minute_purchase(text) from public, anon, authenticated;
grant execute on function credit_minute_purchase(text) to service_role;
