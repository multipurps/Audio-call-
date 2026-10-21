-- New accounts start with 0 minutes. Only a purchase (or an admin credit) adds any.
--
-- Before this, an account with no user_usage row counted as having 60 minutes (the code fell back to 60),
-- and every row created for a new account (first call charge, first purchase, a referral) got
-- monthly_minute_limit = 60 from the column default. The code no longer invents minutes; this makes the
-- database agree. Safe to run more than once.

-- 1) Keep what existing people have today. Every account that was approved before this change and has
--    no usage row yet gets its 60 written down explicitly, so nobody loses minutes they already had.
insert into user_usage (user_id, monthly_minute_limit)
select a.user_id, 60
  from user_approvals a
 where a.approved = true
   and not exists (select 1 from user_usage u where u.user_id = a.user_id)
on conflict (user_id) do nothing;

-- 2) Every NEW row starts at 0 (first call charge, first purchase, anything else that creates a row).
alter table user_usage alter column monthly_minute_limit set default 0;

-- 3) Fix rows that were created for new accounts between the code deploy and this script running
--    (they picked up the old default of 60). Accounts approved before this change are left alone.
update user_usage u
   set monthly_minute_limit = 0,
       updated_at = now()
 where u.monthly_minute_limit = 60
   and not exists (select 1 from user_approvals a where a.user_id = u.user_id and a.approved = true);

-- Check (run after): the default should read 0, and only grandfathered accounts should have a limit of 60.
-- select column_default from information_schema.columns
--  where table_name = 'user_usage' and column_name = 'monthly_minute_limit';
-- select monthly_minute_limit, count(*) from user_usage group by 1 order by 1;
