-- Social Calling: per-user Telegram and WhatsApp account links, so each end
-- user can place 1-to-1 calls through their own linked account instead of
-- one shared app account.
--
-- Session data (Telegram MTProto session string / WhatsApp Baileys auth
-- state) is the equivalent of full account access — more sensitive than a
-- password, since it skips login entirely. It is:
--   * never written by api/*.js (Vercel) — only the always-on relay service
--     (server-social/) holds the encryption key and reads/writes it, via
--     the service-role key.
--   * stored as bytea, encrypted with pgcrypto (AES via pgp_sym_encrypt) at
--     the relay layer before insert, never as plaintext in Postgres.
--   * never returned to the client — api/social-calling.js only ever
--     exposes connection status (connected/not, display name/phone),
--     never the session itself.
create extension if not exists pgcrypto;

create table if not exists telegram_accounts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  telegram_user_id text,
  display_name text,
  phone_last4 text,
  session_encrypted bytea, -- pgp_sym_encrypt'd MTProto session string; written only by the relay
  status text not null default 'disconnected', -- disconnected | pending_otp | connected | error
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists whatsapp_accounts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  whatsapp_jid text,
  display_name text,
  auth_state_encrypted bytea, -- pgp_sym_encrypt'd Baileys multi-file auth state (serialized), written only by the relay
  status text not null default 'disconnected', -- disconnected | pending_qr | connected | error
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Short-lived call records for social calls, separate from `calls` (Twilio)
-- since these have no twilio_call_sid / recording_url and use a different
-- status vocabulary.
create table if not exists social_calls (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  platform text not null, -- 'telegram' | 'whatsapp'
  peer_identifier text not null, -- phone number or username being called
  status text not null default 'queued', -- queued | ringing | in_progress | completed | failed
  duration_seconds int,
  created_at timestamptz not null default now(),
  ended_at timestamptz
);

alter table telegram_accounts enable row level security;
alter table whatsapp_accounts enable row level security;
alter table social_calls enable row level security;

-- Clients may read their own connection status; all writes (including the
-- encrypted session columns) happen server-side via the service-role key,
-- same pattern as the rest of this app.
drop policy if exists "read own telegram account" on telegram_accounts;
create policy "read own telegram account" on telegram_accounts for select using (auth.uid() = user_id);
drop policy if exists "read own whatsapp account" on whatsapp_accounts;
create policy "read own whatsapp account" on whatsapp_accounts for select using (auth.uid() = user_id);
drop policy if exists "read own social calls" on social_calls;
create policy "read own social calls" on social_calls for select using (auth.uid() = user_id);

-- Belt-and-suspenders: even though api/social-calling.js is written to never
-- select these columns for the client, strip them from anything the
-- anon/authenticated roles could ever select directly.
revoke select (session_encrypted) on telegram_accounts from anon, authenticated;
revoke select (auth_state_encrypted) on whatsapp_accounts from anon, authenticated;
