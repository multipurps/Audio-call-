-- Allow iPhone .mov (video/quicktime) uploads for landing media.
do $$
declare c text;
begin
  for c in select conname from pg_constraint
           where conrelid = 'landing_media'::regclass and contype = 'c' and pg_get_constraintdef(oid) ilike '%media_type%'
  loop execute format('alter table landing_media drop constraint %I', c); end loop;
end $$;
alter table landing_media add constraint landing_media_media_type_check check (media_type in (
  'image/gif','image/png','image/jpeg','image/webp','video/mp4','video/webm','video/quicktime'
));
