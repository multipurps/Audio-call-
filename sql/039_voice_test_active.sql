-- The test voice can now be switched on and off without deleting the saved key.
-- Only an active test voice is used on calls; selecting a Standard or Custom voice
-- in the app turns it off.
alter table voice_test_settings add column if not exists active boolean not null default true;
