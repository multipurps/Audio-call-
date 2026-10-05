-- Voice preferences. The call engine is automatic and is NOT stored here:
--   * use_custom_voice = true AND the user has a ready cloned voice  -> classic (STT -> Luna -> Fish clone)
--   * otherwise                                                      -> GPT-Live with live_voice_id
-- live_* is the GPT-Live voice (audio.output.voice). It is separate from the Fish clone id,
-- which stays in voice_profiles.provider_voice_id.
create table if not exists voice_preferences (
  user_id uuid primary key references auth.users(id) on delete cascade,
  live_voice_id text,
  live_voice_name text,
  live_voice_gender text,          -- 'feminine' | 'masculine'
  use_custom_voice boolean not null default true,  -- true keeps today's behaviour for users who already cloned a voice
  updated_at timestamptz not null default now()
);

alter table voice_preferences enable row level security;
-- All access goes through the service-role key (api/voice-clone.js, pipecat-service); no client policies.
