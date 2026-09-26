-- Lets WhatsApp/Telegram calls placed from chat use the SAME calls row
-- (and therefore the same call-screen/header-spinner UI) that Twilio phone
-- calls already use, instead of only living in social_calls with no UI.
alter table calls add column if not exists platform text not null default 'phone';
alter table calls add column if not exists platform_call_id text;
