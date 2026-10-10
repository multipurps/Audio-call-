-- Allow a "live call sample" video on the public landing page.
-- Upload it in Admin > Landing media > "Live call sample video" (MP4 or WebM, up to 50 MB).
alter table landing_media drop constraint if exists landing_media_slot_check;
alter table landing_media add constraint landing_media_slot_check check (slot in (
  'hero_background','hero_overlay','objective_background','objective_overlay',
  'conversation_background','conversation_overlay','call_screenshots',
  'voice_orb','feature_media','demo_video','live_call_video'
));
