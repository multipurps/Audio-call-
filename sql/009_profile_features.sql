-- Archive: hide a saved chat from the main list without deleting it.
alter table chat_sessions add column if not exists archived boolean not null default false;

-- Call Settings: real knobs read by api/assistant.js when placing a call.
alter table profiles add column if not exists auto_retry boolean not null default true;
alter table profiles add column if not exists record_calls boolean not null default true;
alter table profiles add column if not exists ring_seconds int not null default 25;

-- Memories: short facts distilled from calls (server/relay.js finalizeCall)
-- and fed back into future system prompts, per-contact where relevant.
create table if not exists memories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  contact_id uuid references contacts(id) on delete set null,
  content text not null,
  source_call_id uuid references calls(id) on delete set null,
  created_at timestamptz not null default now()
);
alter table memories enable row level security;
drop policy if exists "read own memories" on memories;
create policy "read own memories" on memories for select using (auth.uid() = user_id);

-- Referrals: every user gets a stable short code; signing up with someone's
-- code links referred_by and grants both sides bonus minutes once.
alter table profiles add column if not exists referral_code text unique;
alter table profiles add column if not exists referred_by uuid references auth.users(id) on delete set null;
alter table user_usage add column if not exists bonus_minutes numeric not null default 0;

-- Billing: Stripe Checkout-based Pro subscription. Status mirrors Stripe's
-- own subscription status strings (active, past_due, canceled, etc.) and is
-- kept in sync by api/stripe-webhook.js.
create table if not exists subscriptions (
  user_id uuid primary key references auth.users(id) on delete cascade,
  stripe_customer_id text,
  stripe_subscription_id text,
  status text not null default 'none', -- none | active | past_due | canceled
  current_period_end timestamptz,
  updated_at timestamptz not null default now()
);
alter table subscriptions enable row level security;
drop policy if exists "read own subscription" on subscriptions;
create policy "read own subscription" on subscriptions for select using (auth.uid() = user_id);

-- Call Answering: lets Emysa answer *inbound* calls to a Twilio number
-- provisioned for the user, using their own configured greeting/instructions
-- instead of a per-call objective from chat.
create table if not exists call_answering_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  enabled boolean not null default false,
  twilio_number text,
  twilio_number_sid text,
  greeting text not null default 'Hey, thanks for calling — how can I help?',
  instructions text,
  updated_at timestamptz not null default now()
);
alter table call_answering_settings enable row level security;
drop policy if exists "read own call answering settings" on call_answering_settings;
create policy "read own call answering settings" on call_answering_settings for select using (auth.uid() = user_id);

alter table calls add column if not exists direction text not null default 'outbound'; -- outbound | inbound

-- All writes to every table above happen server-side via the service-role
-- key (api/*.js), same pattern as the rest of this app — no insert/update/
-- delete policies needed for the client role.
