-- ONE-OFF CLEAN SLATE: deletes every chat in Recent -> Chats for every user.
-- Run in the Supabase SQL editor. Cascades to the chats' messages and call
-- plans. Call records themselves are kept (calls.session_id is set to null),
-- so call transcripts and summaries are not lost.
-- To wipe just your own account, add:  where user_id = 'YOUR-USER-UUID'
delete from chat_sessions;
