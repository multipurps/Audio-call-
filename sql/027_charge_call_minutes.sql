-- Deduct call minutes for EVERY call type (Twilio, WhatsApp, Telegram, Signal,
-- in-app Emysa calls) in one place: the database.
--
-- Until now only the Twilio status callback charged minutes, and a retried
-- callback could charge twice. This trigger fires whenever a call row's
-- duration_seconds is written, rounds up to whole minutes (same as before),
-- and charges only the part not yet billed, so it is safe to repeat.
--
-- Apply this BEFORE deploying the matching code (which stops the old charge).

alter table calls add column if not exists billed_minutes numeric not null default 0;

-- Existing calls are marked billed so nobody is charged retroactively.
update calls set billed_minutes = ceil(duration_seconds / 60.0) where coalesce(duration_seconds, 0) > 0;

create or replace function charge_call_minutes() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_total numeric; v_delta numeric;
begin
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

drop trigger if exists calls_charge_minutes on calls;
create trigger calls_charge_minutes
  before insert or update of duration_seconds on calls
  for each row execute function charge_call_minutes();
