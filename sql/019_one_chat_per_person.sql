-- One conversation per person.
-- chat_sessions.peer_key is the digits of the person's number ("p:2349038226059")
-- or "c:<contact id>" for contacts with no number. lib/personSession.js folds any
-- chat a call is placed from into the person's single conversation.
alter table chat_sessions add column if not exists peer_key text;

create unique index if not exists chat_sessions_one_per_person
  on chat_sessions(user_id, peer_key)
  where peer_key is not null;

-- Backfill from existing calls, as separate statements (a single statement
-- that moves rows and deletes their old parent in one go is fragile).
drop table if exists _peer_map;
create temp table _peer_map as
with call_peers as (
  select distinct on (c.session_id)
         c.session_id, c.user_id,
         'p:' || regexp_replace(c.to_number, '\D', '', 'g') as peer_key
  from calls c
  where c.session_id is not null and c.to_number ~ '^\+?[0-9]{7,15}$'
  order by c.session_id, c.created_at desc
)
select cp.session_id, cp.user_id, cp.peer_key,
       first_value(cp.session_id) over (
         partition by cp.user_id, cp.peer_key order by s.updated_at desc, cp.session_id
       ) as keep_id
from call_peers cp join chat_sessions s on s.id = cp.session_id;

update assistant_messages m set session_id = r.keep_id
  from _peer_map r where m.session_id = r.session_id and r.session_id <> r.keep_id;
update calls c set session_id = r.keep_id
  from _peer_map r where c.session_id = r.session_id and r.session_id <> r.keep_id;
update call_plans p set session_id = r.keep_id
  from _peer_map r where p.session_id = r.session_id and r.session_id <> r.keep_id;
delete from chat_sessions s using _peer_map r
  where s.id = r.session_id and r.session_id <> r.keep_id;
update chat_sessions s set peer_key = r.peer_key
  from _peer_map r
  where s.id = r.session_id and r.session_id = r.keep_id and s.peer_key is null;

drop table if exists _peer_map;
