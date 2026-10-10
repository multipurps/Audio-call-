-- Public landing media. Only the service-role API can write. No public table
-- policy: the API returns a curated projection, never storage paths.
create table if not exists landing_media (
  id uuid primary key default gen_random_uuid(),
  slot text not null check (slot in (
    'hero_background','hero_overlay','objective_background','objective_overlay',
    'conversation_background','conversation_overlay','call_screenshots',
    'voice_orb','feature_media','demo_video'
  )),
  url text not null,
  storage_path text not null unique,
  media_type text not null check (media_type in ('image/gif','image/png','image/jpeg','image/webp','video/mp4','video/webm')),
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists landing_media_order on landing_media(slot, sort_order, created_at);
alter table landing_media enable row level security;
-- No browser write policy; signed URLs are issued by the admin-only API.
