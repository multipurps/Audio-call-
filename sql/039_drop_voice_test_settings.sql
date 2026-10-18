-- Removes the Test-a-voice feature (ElevenLabs / Cartesia with a user's own key).
-- The table held each user's own provider API key. Run once in Supabase.
-- sql/038 stays in place as history.
drop table if exists voice_test_settings;
