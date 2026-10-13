-- Training calls with Emysa (admin "Call Emysa") must never use up call minutes.
-- The charge_call_minutes trigger (sql/027) bills every calls row, so skip the training rows.
-- Run after 042. Safe to re-run.

create or replace function charge_call_minutes() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_total numeric; v_delta numeric;
begin
  if coalesce(NEW.to_number, '') = 'Emysa training' then
    return NEW;  -- training call: never billed
  end if;
  v_total := ceil(coalesce(NEW.duration_seconds, 0) / 60.0);
  v_delta := v_total - coalesce(NEW.billed_minutes, 0);
  if v_delta > 0 and NEW.user_id is not null then
    insert into user_usage (user_id, call_minutes_used) values (NEW.user_id, v_delta)
    on conflict (user_id) do update
      set call_minutes_used = user_usage.call_minutes_used + v_delta, updated_at = now();
    NEW.billed_minutes := v_total;
  end if;
  return NEW;
end $$;

-- One-off: give back any minutes already charged for training calls, then mark them unbilled.
with t as (
  select user_id, sum(billed_minutes) as m from calls
  where to_number = 'Emysa training' and billed_minutes > 0 and user_id is not null group by user_id
), refund as (
  update user_usage u set call_minutes_used = greatest(0, u.call_minutes_used - t.m), updated_at = now()
  from t where u.user_id = t.user_id returning u.user_id
)
update calls set billed_minutes = 0 where to_number = 'Emysa training' and billed_minutes > 0;
