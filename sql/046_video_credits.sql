-- Credits for calls. 1 credit = 1 audio minute. A video minute costs 2 credits (avatar and Live Swap).
-- user_usage.call_minutes_used now counts credits. Audio is unchanged (1 minute = 1 credit), so existing
-- balances keep their meaning.
--
-- Video calls are flagged on their row (is_video). The trigger charges the difference between the rounded
-- total and what was already billed, so it stays safe to repeat, as in sql/027.
-- Apply this BEFORE deploying the matching code.

alter table calls add column if not exists is_video boolean not null default false;

create or replace function charge_call_minutes() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_total numeric; v_delta numeric;
begin
  -- whole minutes, rounded up, times 2 for video
  v_total := ceil(coalesce(NEW.duration_seconds, 0) / 60.0) * (case when NEW.is_video then 2 else 1 end);
  v_delta := v_total - coalesce(NEW.billed_minutes, 0);
  if v_delta > 0 and NEW.user_id is not null then
    insert into user_usage (user_id, call_minutes_used) values (NEW.user_id, v_delta)
    on conflict (user_id) do update
      set call_minutes_used = user_usage.call_minutes_used + v_delta, updated_at = now();
    NEW.billed_minutes := v_total;
  end if;
  return NEW;
end $$;
