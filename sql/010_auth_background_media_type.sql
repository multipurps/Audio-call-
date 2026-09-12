alter table auth_backgrounds add column if not exists media_type text not null default 'image';
