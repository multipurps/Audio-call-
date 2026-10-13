-- Admin-controlled AI behavior and shared knowledge (global, not per user).
-- Run in the Supabase SQL editor. Safe to re-run.
-- This is configuration + retrieval injected into prompts. It does NOT train or fine-tune any model.

create table if not exists ai_config_versions (
  id bigserial primary key,
  version int not null unique,
  status text not null default 'draft' check (status in ('draft','published','archived')),
  config jsonb not null default '{}'::jsonb,
  note text,
  created_by text,
  created_at timestamptz not null default now(),
  published_by text,
  published_at timestamptz
);
create unique index if not exists ai_config_one_published on ai_config_versions ((status)) where status = 'published';

create table if not exists ai_knowledge (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('fact','rule','example','correction')),
  title text not null,
  body text not null default '',
  good_example text,
  bad_example text,
  why text,
  tags text[] not null default '{}',
  models text[] not null default '{live,luna}',
  modes text[] not null default '{phone,app,social}',
  always boolean not null default false,
  status text not null default 'draft' check (status in ('draft','published','archived')),
  created_by text,
  updated_by text,
  approved_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists ai_knowledge_status_idx on ai_knowledge (status, kind);

create table if not exists ai_knowledge_history (
  id bigserial primary key,
  knowledge_id uuid not null,
  snapshot jsonb not null,
  changed_by text,
  changed_at timestamptz not null default now()
);
create index if not exists ai_knowledge_history_idx on ai_knowledge_history (knowledge_id, changed_at desc);

create table if not exists ai_audit_log (
  id bigserial primary key,
  actor_email text,
  action text not null,
  entity text,
  entity_id text,
  detail jsonb,
  at timestamptz not null default now()
);
create index if not exists ai_audit_at_idx on ai_audit_log (at desc);

-- Service role only. No public or per-user read: this is admin-owned and may hold business rules.
alter table ai_config_versions enable row level security;
alter table ai_knowledge enable row level security;
alter table ai_knowledge_history enable row level security;
alter table ai_audit_log enable row level security;

-- Atomic publish / rollback: exactly one published version at any time.
create or replace function ai_publish_config(p_version int, p_actor text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from ai_config_versions where version = p_version) then
    raise exception 'version % not found', p_version;
  end if;
  update ai_config_versions set status = 'archived' where status = 'published' and version <> p_version;
  update ai_config_versions
     set status = 'published', published_by = p_actor, published_at = now()
   where version = p_version;
end $$;

-- The single retrieval + rendering function every runtime calls (Python pipecat service and Node).
-- Returns { version, block } where block is plain text ready to append to a prompt.
-- p_model: 'live' (GPT-Live) | 'luna' ; p_mode: 'phone' | 'app' | 'social'
drop function if exists ai_global_context(text, text, text, int, int);
create or replace function ai_global_context(
  p_model text, p_mode text, p_query text, p_limit int default 6, p_max_chars int default 3200,
  p_config jsonb default null, p_include_drafts boolean default false
) returns jsonb
language plpgsql security definer set search_path = public stable as $$
declare
  cfg jsonb; ver int; words text[]; tsq tsquery;
  out_text text := ''; part text; r record; used int := 0;
begin
  if p_config is not null then
    cfg := p_config; ver := -1;  -- admin preview/test of an unpublished draft
  else
    select config, version into cfg, ver from ai_config_versions where status = 'published' limit 1;
  end if;
  if cfg is null then cfg := '{}'::jsonb; end if;

  -- Behavior sections (admin-edited). Each key is optional.
  foreach part in array array['style','language','disagree','interrupt','jokes','reacts'] loop
    if coalesce(cfg #>> array['global', part], '') <> '' then
      out_text := out_text || initcap(part) || ': ' || (cfg #>> array['global', part]) || E'\n';
    end if;
  end loop;
  if jsonb_typeof(cfg -> 'must') = 'array' and jsonb_array_length(cfg -> 'must') > 0 then
    out_text := out_text || E'Always follow:\n';
    for part in select jsonb_array_elements_text(cfg -> 'must') loop out_text := out_text || '- ' || part || E'\n'; end loop;
  end if;
  if jsonb_typeof(cfg -> 'avoid') = 'array' and jsonb_array_length(cfg -> 'avoid') > 0 then
    out_text := out_text || E'Never say or use these words and phrases:\n';
    for part in select jsonb_array_elements_text(cfg -> 'avoid') loop out_text := out_text || '- ' || part || E'\n'; end loop;
  end if;
  if coalesce(cfg #>> array['models', p_model, 'extra'], '') <> '' then
    out_text := out_text || (cfg #>> array['models', p_model, 'extra']) || E'\n';
  end if;

  -- Always-on rules first, then the most relevant entries for this call.
  words := array(select w from unnest(regexp_split_to_array(lower(regexp_replace(coalesce(p_query,''), '[^[:alnum:]]+', ' ', 'g')), '\s+')) w where length(w) > 3 limit 12);
  if array_length(words, 1) is not null then
    tsq := to_tsquery('simple', array_to_string(array(select quote_literal(w) from unnest(words) w), ' | '));
  end if;

  for r in
    select k.*,
      case when k.always then 1000 else 0 end
      + case when tsq is not null then ts_rank(to_tsvector('simple', k.title || ' ' || k.body || ' ' || array_to_string(k.tags, ' ')), tsq) * 10 else 0 end
      + case when k.tags && words then 5 else 0 end as score
    from ai_knowledge k
    where (k.status = 'published' or (p_include_drafts and k.status = 'draft')) and p_model = any (k.models) and p_mode = any (k.modes)
      and (k.always or (tsq is not null and (to_tsvector('simple', k.title || ' ' || k.body || ' ' || array_to_string(k.tags, ' ')) @@ tsq or k.tags && words)))
    order by score desc, k.updated_at desc
    limit greatest(p_limit, 0)
  loop
    part := '- ' || r.title || case when r.body <> '' then ': ' || r.body else '' end;
    if r.kind in ('example','correction') then
      if coalesce(r.bad_example,'') <> '' then part := part || ' | Do not: ' || r.bad_example; end if;
      if coalesce(r.good_example,'') <> '' then part := part || ' | Do: ' || r.good_example; end if;
      if coalesce(r.why,'') <> '' then part := part || ' | Why: ' || r.why; end if;
    end if;
    if used + length(part) > p_max_chars then exit; end if;
    out_text := out_text || part || E'\n';
    used := used + length(part);
  end loop;

  return jsonb_build_object('version', coalesce(ver, 0), 'block', left(trim(out_text), p_max_chars + 2000));
end $$;

revoke all on function ai_global_context(text, text, text, int, int, jsonb, boolean) from public, anon, authenticated;
revoke all on function ai_publish_config(int, text) from public, anon, authenticated;
grant execute on function ai_global_context(text, text, text, int, int, jsonb, boolean) to service_role;
grant execute on function ai_publish_config(int, text) to service_role;
