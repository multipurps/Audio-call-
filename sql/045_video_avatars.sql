-- Avatar pictures for Emysa video calls and Live Swap.
-- Uploaded from Profile > Avatar into the existing public "avatars" bucket (sql/006_avatars.sql),
-- under "<user_id>/video-avatar.<ext>" and "<user_id>/live-swap.<ext>". Safe to re-run.

alter table profiles add column if not exists video_avatar_url text;
alter table profiles add column if not exists live_swap_url text;
