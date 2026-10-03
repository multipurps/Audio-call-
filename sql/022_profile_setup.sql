-- First-run profile step (name, language, country) shown after the calling-line
-- step. Existing users predate it, so they are marked complete once, when the
-- column is first added; new accounts start incomplete.
alter table profiles add column if not exists country text;

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'profiles' and column_name = 'setup_completed'
  ) then
    alter table profiles add column setup_completed boolean not null default false;
    update profiles set setup_completed = true;
  end if;
end $$;
