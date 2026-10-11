-- Per-feature upload slots for the landing page, plus an optional footer background.
-- Drops whatever check currently limits landing_media.slot (whatever it is named) and replaces it.
do $$
declare c text;
begin
  for c in select conname from pg_constraint
           where conrelid = 'landing_media'::regclass and contype = 'c' and pg_get_constraintdef(oid) ilike '%slot%'
  loop execute format('alter table landing_media drop constraint %I', c); end loop;
end $$;
alter table landing_media add constraint landing_media_slot_check check (slot in (
  'hero_background','hero_overlay','objective_background','objective_overlay',
  'conversation_background','conversation_overlay','call_screenshots',
  'voice_orb','feature_media','demo_video','live_call_video',
  'how_it_works','calls_for_you','your_voice','call_summary','call_in_app','import_chats','channels','footer_background'
));
