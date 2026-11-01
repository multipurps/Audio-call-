-- Run once in the Supabase SQL editor for the Emysa (audio call) project. Safe to re-run.
-- Each person saves their own Anam and Xmax keys (encrypted in Vault) and picks their Anam avatar.
-- Same approach as the live-call app. Only the server (service role) can reach these.

create extension if not exists supabase_vault;

create table if not exists user_video_settings (
  user_id uuid primary key,
  anam_api_key_secret_id uuid,
  xmax_api_key_secret_id uuid,
  anam_avatar_id text,
  anam_avatar_name text,
  updated_at timestamptz default now()
);
alter table user_video_settings enable row level security;

create or replace function public.vault_create_secret(secret text, name text default null)
returns uuid language plpgsql security definer set search_path = public as $$
begin return vault.create_secret(secret, name); end; $$;

create or replace function public.vault_update_secret(p_id uuid, p_secret text)
returns void language plpgsql security definer set search_path = public as $$
begin perform vault.update_secret(p_id, p_secret); end; $$;

create or replace function public.vault_decrypt_secret(p_id uuid)
returns text language plpgsql security definer set search_path = public as $$
declare result text;
begin
  select decrypted_secret into result from vault.decrypted_secrets where id = p_id;
  return result;
end; $$;

revoke all on function public.vault_create_secret(text, text) from public, anon, authenticated;
revoke all on function public.vault_update_secret(uuid, text) from public, anon, authenticated;
revoke all on function public.vault_decrypt_secret(uuid) from public, anon, authenticated;
