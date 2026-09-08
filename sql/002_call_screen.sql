alter table calls add column if not exists ai_muted boolean not null default false;

-- Lets the call screen subscribe to live transcript/status updates via
-- Supabase Realtime instead of polling. Wrapped in a check since
-- ALTER PUBLICATION ... ADD TABLE has no IF NOT EXISTS form and errors on
-- a re-run otherwise.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'calls'
  ) then
    alter publication supabase_realtime add table calls;
  end if;
end $$;
