// Runs the REAL sql/029 migration on a scratch Postgres: idempotent, one attempt per (chain, number),
// memories bound to a contact the same user owns, client writes blocked, owners isolated.
// Skipped (not failed) when no Postgres is reachable.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const DB = `emysa_029_${process.pid}`;
const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';
const KA = 'aaaaaaaa-0000-0000-0000-000000000001';
const KB = 'bbbbbbbb-0000-0000-0000-000000000001';
const ROOT = 'c0000000-0000-0000-0000-000000000001';
const psql = (args, input) => spawnSync('psql', ['-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', ...args], { encoding: 'utf8', input });
const reachable = !psql(['-d', 'postgres', '-c', 'select 1']).error && psql(['-d', 'postgres', '-c', 'select 1']).status === 0;
const skip = reachable ? false : 'no reachable Postgres/psql';
const file = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const as = (uid, sql) => psql(['-d', DB], `set role authenticated; set request.jwt.claim.sub='${uid}'; ${sql}`);

test.before(() => {
  if (skip) return;
  assert.equal(psql(['-d', 'postgres', '-c', `create database ${DB}`]).status, 0);
  const steps = [
    file('tests/rls/supabase_stub.sql'),
    'create table calls (id uuid primary key default gen_random_uuid(), user_id uuid, status text, platform text);',
    file('sql/026_contact_memory.sql'),
    `create table memories (id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade,
       contact_id uuid references contacts(id) on delete set null, content text not null, source_call_id uuid references calls(id) on delete set null, created_at timestamptz not null default now());
     alter table memories enable row level security; create policy "read own memories" on memories for select using (auth.uid() = user_id);`,
    file('sql/029_call_attempts_and_memory_integrity.sql'),
    file('sql/029_call_attempts_and_memory_integrity.sql'), // repeatable
    `insert into auth.users(id,email) values ('${A}','a@x'),('${B}','b@x');
     insert into contacts(id,user_id,name,phone_number) values ('${KA}','${A}','A','+1'),('${KB}','${B}','B','+1');
     insert into calls(id,user_id) values ('${ROOT}','${A}');`,
  ];
  for (const sql of steps) { const r = psql(['-d', DB], sql); assert.equal(r.status, 0, r.stderr); }
});
test.after(() => { if (!skip) psql(['-d', 'postgres', '-c', `drop database if exists ${DB}`]); });

test('a retry chain admits exactly one row per attempt number', { skip }, () => {
  const ins = `insert into calls(user_id,retry_of,attempt_number) values ('${A}','${ROOT}',2)`;
  assert.equal(psql(['-d', DB, '-c', ins]).status, 0);
  const dup = psql(['-d', DB, '-c', ins]);
  assert.notEqual(dup.status, 0);
  assert.match(dup.stderr, /calls_retry_attempt_unique/);
});

test('a memory cannot point at another owner\'s contact, and status is constrained', { skip }, () => {
  const cross = psql(['-d', DB, '-c', `insert into memories(user_id,contact_id,content) values ('${A}','${KB}','x')`]);
  assert.match(cross.stderr, /memories_contact_owner_fk/);
  const bad = psql(['-d', DB, '-c', `insert into memories(user_id,contact_id,content,status) values ('${A}','${KA}','x','guess')`]);
  assert.match(bad.stderr, /memories_status_check/);
  assert.equal(psql(['-d', DB, '-c', `insert into memories(user_id,contact_id,content) values ('${A}','${KA}','Lives in Lagos')`]).status, 0);
});

test('clients cannot write memories; each owner reads only their own', { skip }, () => {
  const forged = as(A, `insert into memories(user_id,contact_id,content) values ('${A}','${KA}','forged')`);
  assert.match(forged.stderr, /row-level security/);
  assert.equal(as(A, 'select count(*) from memories').stdout.trim().split('\n').pop(), '1');
  assert.equal(as(B, 'select count(*) from memories').stdout.trim().split('\n').pop(), '0');
});
