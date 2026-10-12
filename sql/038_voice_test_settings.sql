-- A voice the user is TESTING (ElevenLabs or Cartesia), with the user's own API
-- key. Saved from the app (Profile > Voice > Test a voice); nothing about it
-- lives in Render. When a row exists, that user's calls speak this voice
-- through the classic pipeline (STT -> Luna -> TTS); GPT-Live is never used.
--
-- The key is write-only for the app: api/voice-clone.js never returns it, and
-- row-level security with no client policies means only the service role
-- (api/voice-clone.js, pipecat-service) can read the table.
create table if not exists voice_test_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  provider text not null check (provider in ('elevenlabs', 'cartesia')),
  voice_id text not null,
  api_key text not null,
  updated_at timestamptz not null default now()
);

alter table voice_test_settings enable row level security;
