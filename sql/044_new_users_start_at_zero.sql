-- No free minutes for anyone: an account has exactly the minutes it bought (or that you credited by hand).
-- Safe to run more than once, and safe whether or not an earlier version of this file was already run.
--
-- Background: the balance is monthly_minute_limit + bonus_minutes - call_minutes_used. Every account used
-- to carry a free monthly_minute_limit of 60 (the column default), and purchases land in bonus_minutes.
-- Minutes are spent from the free part first, so just setting the limit to 0 would wrongly charge the
-- earlier free usage to what people paid for. The update below prevents that.

-- 1) Every NEW row starts at 0 (first call charge, first purchase, anything that creates a row).
alter table user_usage alter column monthly_minute_limit set default 0;

-- 2) Remove the free 60 from every existing account.
--    Before: balance = 60 + bought - used.   After: balance = bought - (used beyond the free 60).
--    Only the unspent part of the free 60 disappears. Minutes people bought are never reduced.
--    Limits other than 60 (ones you set by hand in the admin) are left exactly as they are.
update user_usage
   set call_minutes_used = greatest(0, call_minutes_used - monthly_minute_limit),
       monthly_minute_limit = 0,
       updated_at = now()
 where monthly_minute_limit = 60;

-- Preview, if you want to see the effect BEFORE running 2 (read-only):
-- select count(*) as accounts_with_free_60,
--        coalesce(sum(greatest(0, monthly_minute_limit - call_minutes_used)), 0) as free_minutes_removed
--   from user_usage where monthly_minute_limit = 60;
-- Limits you set by hand (these are NOT changed):
-- select user_id, monthly_minute_limit, bonus_minutes, call_minutes_used
--   from user_usage where monthly_minute_limit > 0 and monthly_minute_limit <> 60;
--
-- Check (run after): the default should read 0 and no row should show 60.
-- select column_default from information_schema.columns
--  where table_name = 'user_usage' and column_name = 'monthly_minute_limit';
-- select monthly_minute_limit, count(*) from user_usage group by 1 order by 1;
