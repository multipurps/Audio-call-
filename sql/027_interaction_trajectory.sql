-- Caller interaction-state trajectory, written by the assistant service when a
-- GPT-Live call ends. Apply BEFORE deploying the service update (the write is
-- best-effort and just logs a warning if the column is missing).
alter table calls add column if not exists interaction_trajectory jsonb;
