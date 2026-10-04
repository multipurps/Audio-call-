-- Signal accounts linked through the signal-bridge service (QR link, like WhatsApp).
-- Run this once in the Supabase SQL editor.
create table if not exists signal_accounts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  signal_number text,                          -- e.g. +2348012345678, set once the QR is scanned
  link_id text,                                -- bridge link attempt id while status = pending_qr
  status text not null default 'disconnected', -- disconnected | pending_qr | connected | error
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table signal_accounts enable row level security;
drop policy if exists "read own signal account" on signal_accounts;
create policy "read own signal account" on signal_accounts for select using (auth.uid() = user_id);
