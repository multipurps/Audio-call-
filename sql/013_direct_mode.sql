-- Direct Caller Mode + the real-time voice changer.
--
-- Two call modes now exist, and they share one Twilio call:
--   'ai'     — Emysa talks (the original behaviour, unchanged)
--   'direct' — the user talks; no STT, no LLM, no TTS, no transcript.
-- The relay reads call_mode when the media stream opens and the app can flip
-- it mid-call, so it lives on `calls` rather than only in the browser.
--
-- Every column is added with a default that reproduces today's behaviour for
-- rows written before this migration ran: call_mode='ai' means an in-flight
-- call keeps running exactly as it was.

alter table calls add column if not exists call_mode text not null default 'ai';
-- Voice changer on/off for this call. Only ever consulted in direct mode;
-- off means the user's unconverted microphone goes straight to the caller.
alter table calls add column if not exists vc_enabled boolean not null default true;
-- w-okada model slot (RVC voice) selected for this call. NULL = use the
-- account default below.
alter table calls add column if not exists vc_model_slot int;

-- Profile-level defaults, edited in Profile -> Call Settings and read by
-- api/calls.js and api/assistant.js when a call is placed, so the mode
-- selector on the call screen starts in the right place.
alter table profiles add column if not exists default_call_mode text not null default 'ai';
alter table profiles add column if not exists vc_enabled boolean not null default true;
alter table profiles add column if not exists vc_model_slot int;

-- No new tables, so no new RLS policies: writes to both tables already go
-- through the service-role key in api/*.js and the relay, and the existing
-- "read own calls" / "read own profile" select policies cover the new
-- columns automatically.
