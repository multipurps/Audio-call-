-- WhatsApp calling moved from the Baileys-based relay to WaCalls
-- (github.com/multipurps/WaCalls, a whatsmeow-based Go service).
-- WaCalls manages its own session storage internally - we only need to
-- remember which WaCalls session id belongs to which of our users.
-- auth_state_encrypted (the old Baileys blob) is left in place but unused
-- going forward; nothing reads it anymore.
alter table whatsapp_accounts add column if not exists wacalls_session_id text;
