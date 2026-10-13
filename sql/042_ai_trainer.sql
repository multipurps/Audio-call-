-- Admin training calls: let ai_global_context read the latest DRAFT config and draft knowledge,
-- so the admin can talk to the raw Emysa with unpublished changes. Run after 041. Safe to re-run.
-- Only the service role may call it; user calls never pass p_use_draft.

drop function if exists ai_global_context(text, text, text, int, int, jsonb, boolean);
create or replace function ai_global_context(
  p_model text, p_mode text, p_query text, p_limit int default 6, p_max_chars int default 3200,
  p_config jsonb default null, p_include_drafts boolean default false, p_use_draft boolean default false
) returns jsonb
language plpgsql security definer set search_path = public stable as $$
declare
  cfg jsonb; ver int; words text[]; tsq tsquery;
  out_text text := ''; part text; r record; used int := 0; with_drafts boolean := p_include_drafts;
begin
  if p_config is not null then
    cfg := p_config; ver := -1;  -- admin preview/test of an unpublished draft
  elsif p_use_draft then
    -- Training call: newest draft if there is one, otherwise what is published.
    select config, version into cfg, ver from ai_config_versions
      where status in ('draft','published') order by (status = 'draft') desc, version desc limit 1;
    with_drafts := true;
  else
    select config, version into cfg, ver from ai_config_versions where status = 'published' limit 1;
  end if;
  if cfg is null then cfg := '{}'::jsonb; end if;

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
    where (k.status = 'published' or (with_drafts and k.status = 'draft')) and p_model = any (k.models) and p_mode = any (k.modes)
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

revoke all on function ai_global_context(text, text, text, int, int, jsonb, boolean, boolean) from public, anon, authenticated;
grant execute on function ai_global_context(text, text, text, int, int, jsonb, boolean, boolean) to service_role;
