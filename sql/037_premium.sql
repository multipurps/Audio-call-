-- 037: Premium plans (1/3/6/12 months) and credit expiry.
-- Apply BEFORE deploying the matching code. Safe to run more than once.
--
--  * Free users: credits (bought, granted or referral) expire one month after the
--    last time they were topped up.
--  * Premium users: credits never expire.
--  * Both can buy credit. A premium plan is a purchase row with plan_months set and
--    minutes = 0; paying for it extends user_usage.premium_until.

alter table user_usage add column if not exists premium_until timestamptz;
alter table user_usage add column if not exists credit_expires_at timestamptz;

alter table minute_purchases add column if not exists plan_months integer;
alter table minute_purchases drop constraint if exists minute_purchases_minutes_check;
alter table minute_purchases drop constraint if exists minute_purchases_plan_check;
alter table minute_purchases
  add constraint minute_purchases_plan_check check (
    (plan_months is null and minutes > 0) or (plan_months in (1, 3, 6, 12) and minutes = 0)
  );

-- Every path that adds credit (purchase, admin grant, referral) goes through
-- user_usage.bonus_minutes, so the expiry is set here once for all of them.
create or replace function user_usage_credit_expiry() returns trigger
language plpgsql as $$
begin
  if coalesce(NEW.premium_until, '-infinity'::timestamptz) > now() then
    NEW.credit_expires_at := null;
  elsif NEW.bonus_minutes > coalesce(case when TG_OP = 'UPDATE' then OLD.bonus_minutes end, 0) then
    NEW.credit_expires_at := now() + interval '1 month';
  end if;
  return NEW;
end $$;

drop trigger if exists user_usage_credit_expiry on user_usage;
create trigger user_usage_credit_expiry
  before insert or update on user_usage
  for each row execute function user_usage_credit_expiry();

-- Lets a free user's expired credits lapse. Idempotent; called whenever a balance is read.
create or replace function expire_free_credits(p_user uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  -- Credits with no expiry yet (they predate this, or premium just ended): start the month now
  -- (from the premium end date if there was one).
  update user_usage
     set credit_expires_at = coalesce(premium_until, now()) + interval '1 month'
   where user_id = p_user and bonus_minutes > 0 and credit_expires_at is null
     and coalesce(premium_until, '-infinity'::timestamptz) <= now();

  -- Expire: keep only the part of the bonus already spent.
  update user_usage
     set bonus_minutes = least(bonus_minutes, greatest(0, call_minutes_used - monthly_minute_limit)),
         credit_expires_at = null
   where user_id = p_user and bonus_minutes > 0
     and credit_expires_at is not null and credit_expires_at <= now()
     and coalesce(premium_until, '-infinity'::timestamptz) <= now();
end $$;
revoke all on function expire_free_credits(uuid) from public, anon, authenticated;
grant execute on function expire_free_credits(uuid) to service_role;

-- Idempotent and atomic, as before; now also activates a premium plan.
-- Returns minutes credited (minute packs) or plan months (premium); 0 if already paid.
create or replace function credit_minute_purchase(p_reference text)
returns numeric
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid;
  v_minutes numeric;
  v_months integer;
begin
  update minute_purchases
     set status = 'paid', paid_at = now()
   where reference = p_reference and status = 'pending'
  returning user_id, minutes, plan_months into v_user, v_minutes, v_months;

  if v_user is null then
    return 0;
  end if;

  if v_months is not null then
    insert into user_usage (user_id, premium_until)
    values (v_user, now() + make_interval(months => v_months))
    on conflict (user_id) do update
      set premium_until = greatest(coalesce(user_usage.premium_until, now()), now()) + make_interval(months => v_months),
          updated_at = now();
    return v_months;
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
