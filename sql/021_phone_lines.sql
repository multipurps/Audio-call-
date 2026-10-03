-- Per-user phone line for Twilio calls ("Bring your own number" or "Rent").
--
-- Before this, every Twilio call used one shared TWILIO_FROM_NUMBER. Now a
-- user can only place a phone (Twilio) call from THEIR OWN line:
--   * mode 'own'  : the user's existing number, proven by Twilio's
--                   verification call (a Verified Outgoing Caller ID).
--                   Outbound caller ID only; the number stays with their
--                   carrier and inbound calls still go there.
--   * mode 'rent' : a Twilio number bought for the user.
-- No usable row (status verified|rented) = no Twilio access at all, enforced
-- in lib/phoneCalls.js and api/assistant.js, not just hidden in the UI.
--
-- All writes happen server-side with the service role (api/calls.js).
create table if not exists phone_lines (
  user_id uuid primary key references auth.users(id) on delete cascade,
  mode text not null check (mode in ('own', 'rent')),
  phone_number text not null,                       -- E.164
  status text not null default 'pending'
    check (status in ('pending', 'verified', 'rented', 'failed')),
  validation_code text,                             -- Twilio's 6-digit code while pending
  twilio_sid text,                                  -- OutgoingCallerId or IncomingPhoneNumber sid
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table phone_lines enable row level security;
drop policy if exists "read own phone line" on phone_lines;
create policy "read own phone line" on phone_lines for select using (auth.uid() = user_id);
-- The Twilio sid is internal; the client reads status through the API.
revoke select (twilio_sid) on phone_lines from anon, authenticated;
