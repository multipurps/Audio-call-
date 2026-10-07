// Row-level-security and isolation tests that run the REAL migration
// (sql/026_contact_memory.sql) on a real Postgres + pgvector, acting as the
// anon / authenticated / service_role roles Supabase uses.
//
// Needs `psql` and a server it can create a scratch database on:
//   PGHOST / PGUSER / PGPORT / PGPASSWORD as usual (defaults: local socket, user postgres).
// With no reachable Postgres the whole file is skipped, not failed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const DB = `emysa_rls_${process.pid}`;
const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';
const A_CONTACT = 'aaaaaaaa-0000-0000-0000-000000000001';
const A_CONTACT_2 = 'aaaaaaaa-0000-0000-0000-000000000002';
const B_CONTACT = 'bbbbbbbb-0000-0000-0000-000000000001';
const A_IMPORT = 'a1a1a1a1-0000-0000-0000-000000000001';
const A_MEMORY = 'a2a2a2a2-0000-0000-0000-000000000001';
const SHARED_NUMBER = '+2348012345678';

function psql(args, input) {
  return spawnSync('psql', ['-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', ...args], { encoding: 'utf8', input });
}
const reachable = !psql(['-d', 'postgres', '-c', 'select 1']).error && psql(['-d', 'postgres', '-c', 'select 1']).status === 0;
const skip = reachable ? false : 'no reachable Postgres/psql for RLS tests';

// Runs SQL inside a transaction as the given role/user, then rolls back.
function as(role, uid, sql) {
  const claim = uid ? `set local request.jwt.claim.sub = '${uid}';` : '';
  const r = psql(['-d', DB], `begin; ${role ? `set local role ${role};` : ''} ${claim} ${sql}; rollback;`);
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}
const rows = (r) => r.out.split('\n').filter(Boolean);

test.before(() => {
  if (skip) return;
  assert.equal(psql(['-d', 'postgres', '-c', `create database ${DB}`]).status, 0);
  for (const file of ['tests/rls/supabase_stub.sql', 'sql/026_contact_memory.sql']) {
    const r = psql(['-d', DB], readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'));
    assert.equal(r.status, 0, `${file}: ${r.stderr}`);
  }
  // Two users, who even saved the SAME phone number as a contact.
  const seed = psql(['-d', DB], `
    insert into auth.users (id, email) values ('${A}', 'a@example.com'), ('${B}', 'b@example.com');
    insert into contacts (id, user_id, name, phone_number) values
      ('${A_CONTACT}', '${A}', 'Marilyn', '${SHARED_NUMBER}'),
      ('${A_CONTACT_2}', '${A}', 'Marilyn (work)', '${SHARED_NUMBER}'),
      ('${B_CONTACT}', '${B}', 'Someone else', '${SHARED_NUMBER}');
    insert into whatsapp_imports (id, user_id, contact_id, original_filename, source_kind, sha256)
      values ('${A_IMPORT}', '${A}', '${A_CONTACT}', 'chat.zip', 'zip', 'sha-a');
    insert into contact_memories (id, user_id, contact_id, import_id, memory_type, memory_text, status, is_inferred)
      values ('${A_MEMORY}', '${A}', '${A_CONTACT}', '${A_IMPORT}', 'preferences', 'Prefers voice notes to calls', 'approved', false),
             (gen_random_uuid(), '${A}', '${A_CONTACT}', '${A_IMPORT}', 'identity', 'Goes by Lyn', 'candidate', true);
    insert into whatsapp_import_chunks (user_id, contact_id, import_id, chunk_index, content)
      values ('${A}', '${A_CONTACT}', '${A_IMPORT}', 0, 'Marilyn: the pottery class is on Saturday');
  `);
  assert.equal(seed.status, 0, seed.stderr);
});
test.after(() => { if (!skip) psql(['-d', 'postgres', '-c', `drop database if exists ${DB}`]); });

test('RLS: each user reads only their own memories, imports and chunks', { skip }, () => {
  for (const table of ['contact_memories', 'whatsapp_imports', 'whatsapp_import_chunks']) {
    assert.equal(rows(as('authenticated', A, `select count(*) from ${table}`))[0] > 0, true, `A sees own ${table}`);
    assert.equal(rows(as('authenticated', B, `select count(*) from ${table}`))[0], '0', `B must see none of A's ${table}`);
  }
});

test('RLS: anon sees nothing and cannot call the lookup functions', { skip }, () => {
  assert.equal(rows(as('anon', null, 'select count(*) from contact_memories'))[0], '0');
  const fn = as('anon', null, `select * from find_contact_by_phone('${A}', '${SHARED_NUMBER}')`);
  assert.equal(fn.ok, false);
  assert.match(fn.err, /permission denied/i);
});

test("RLS: B cannot read, change, approve or delete A's memory", { skip }, () => {
  assert.equal(rows(as('authenticated', B, `select id from contact_memories where id = '${A_MEMORY}'`)).length, 0);
  const upd = as('authenticated', B, `update contact_memories set status = 'rejected' where id = '${A_MEMORY}' returning id`);
  assert.equal(rows(upd).length, 0);
  const del = as('authenticated', B, `delete from contact_memories where id = '${A_MEMORY}' returning id`);
  assert.equal(rows(del).length, 0);
  // and A's row is untouched
  assert.equal(rows(as(null, null, `select status from contact_memories where id = '${A_MEMORY}'`))[0], 'approved');
});

test('RLS: B cannot insert a memory as A, or onto A\'s contact as B', { skip }, () => {
  const asA = as('authenticated', B, `insert into contact_memories (user_id, contact_id, memory_type, memory_text) values ('${A}', '${A_CONTACT}', 'identity', 'planted')`);
  assert.equal(asA.ok, false);
  assert.match(asA.err, /row-level security/i);
  const onA = as('authenticated', B, `insert into contact_memories (user_id, contact_id, memory_type, memory_text) values ('${B}', '${A_CONTACT}', 'identity', 'planted')`);
  assert.equal(onA.ok, false);
  assert.match(onA.err, /foreign key/i);
});

test('service role (RLS bypass) still cannot attach rows to another user\'s contact', { skip }, () => {
  for (const sql of [
    `insert into contact_memories (user_id, contact_id, memory_type, memory_text) values ('${B}', '${A_CONTACT}', 'identity', 'x')`,
    `insert into whatsapp_imports (user_id, contact_id, original_filename, source_kind) values ('${B}', '${A_CONTACT}', 'x.txt', 'txt')`,
    `insert into whatsapp_import_chunks (user_id, contact_id, import_id, chunk_index, content) values ('${B}', '${A_CONTACT}', '${A_IMPORT}', 9, 'x')`,
    `insert into whatsapp_import_chunks (user_id, contact_id, import_id, chunk_index, content) values ('${A}', '${A_CONTACT}', '${A_IMPORT}', 9, 'x'), ('${B}', '${B_CONTACT}', '${A_IMPORT}', 10, 'x')`,
  ]) {
    const r = as('service_role', null, sql);
    assert.equal(r.ok, false, sql);
    assert.match(r.err, /foreign key/i);
  }
});

test('phone lookup: only the caller\'s own contacts; same number for two users never crosses', { skip }, () => {
  const mine = as('service_role', null, `select contact_id from find_contact_by_phone('${B}', '${SHARED_NUMBER}')`);
  assert.deepEqual(rows(mine), [B_CONTACT]);
  const own = as('authenticated', A, `select contact_id from find_contact_by_phone('${A}', '${SHARED_NUMBER}') order by 1`);
  assert.deepEqual(rows(own), [A_CONTACT, A_CONTACT_2]); // two contacts, one number: caller must treat as ambiguous
  const cross = as('authenticated', B, `select contact_id from find_contact_by_phone('${A}', '${SHARED_NUMBER}')`);
  assert.deepEqual(rows(cross), [], 'B cannot look up A\'s contacts by passing A\'s id');
});

test('phone lookup: formatting differences match, near-misses and empty input do not', { skip }, () => {
  const fmt = as('service_role', null, `select count(*) from find_contact_by_phone('${B}', '+234 801 234 5678')`);
  assert.equal(rows(fmt)[0], '1');
  for (const number of ['+2348012345679', '+234801234567', '8012345678', '', 'abc']) {
    assert.equal(rows(as('service_role', null, `select count(*) from find_contact_by_phone('${B}', '${number}')`))[0], '0', number);
  }
});

test('history search: scoped to user AND contact; another user cannot reach it', { skip }, () => {
  const ok = as('service_role', null, `select content from search_contact_history('${A}', '${A_CONTACT}', 'pottery')`);
  assert.equal(rows(ok).length, 1);
  const wrongContact = as('service_role', null, `select content from search_contact_history('${A}', '${A_CONTACT_2}', 'pottery')`);
  assert.deepEqual(rows(wrongContact), []);
  const wrongUser = as('service_role', null, `select content from search_contact_history('${B}', '${A_CONTACT}', 'pottery')`);
  assert.deepEqual(rows(wrongUser), []);
  const impersonate = as('authenticated', B, `select content from search_contact_history('${A}', '${A_CONTACT}', 'pottery')`);
  assert.deepEqual(rows(impersonate), []);
});

test('the user pin holds even where RLS would not apply (RLS-bypassing role carrying a user session)', { skip }, () => {
  // service_role bypasses RLS. If it ever runs a lookup on behalf of user B (a
  // session claim is present), asking for A's data must still return nothing:
  // this is what protects the functions if they are ever made SECURITY DEFINER.
  const cases = [
    `select count(*) from find_contact_by_phone('${A}', '${SHARED_NUMBER}')`,
    `select count(*) from search_contact_history('${A}', '${A_CONTACT}', 'pottery')`,
  ];
  for (const sql of cases) {
    assert.equal(rows(as('service_role', B, sql))[0], '0', sql);
    assert.notEqual(rows(as('service_role', A, sql))[0], '0', `${sql} (the owner still gets results)`);
  }
});

test('vector search is scoped the same way', { skip }, () => {
  const vec = `[${Array.from({ length: 1536 }, (_, i) => (i === 0 ? 1 : 0)).join(',')}]`;
  const seed = psql(['-d', DB], `update whatsapp_import_chunks set embedding = '${vec}'::vector where import_id = '${A_IMPORT}'`);
  assert.equal(seed.status, 0, seed.stderr);
  const mine = as('service_role', null, `select count(*) from match_contact_history('${A}', '${A_CONTACT}', '${vec}'::vector)`);
  assert.equal(rows(mine)[0], '1');
  const other = as('authenticated', B, `select count(*) from match_contact_history('${A}', '${A_CONTACT}', '${vec}'::vector)`);
  assert.equal(rows(other)[0], '0');
  psql(['-d', DB], `update whatsapp_import_chunks set embedding = null`);
});

test('data rules: statuses, types, confidence and duplicate text are enforced', { skip }, () => {
  const base = (cols, vals) => `insert into contact_memories (user_id, contact_id, ${cols}) values ('${A}', '${A_CONTACT}', ${vals})`;
  assert.equal(as('service_role', null, base('memory_type, memory_text, status', `'identity', 'ok', 'approved'`)).ok, true);
  assert.equal(as('service_role', null, base('memory_type, memory_text, status', `'identity', 'ok', 'maybe'`)).ok, false);
  assert.equal(as('service_role', null, base('memory_type, memory_text', `'gossip', 'ok'`)).ok, false);
  assert.equal(as('service_role', null, base('memory_type, memory_text, confidence', `'identity', 'ok', 1.5`)).ok, false);
  assert.equal(as('service_role', null, base('memory_type, memory_text', `'identity', '   '`)).ok, false);
  assert.equal(as('service_role', null, base('memory_type, memory_text', `'identity', '${'x'.repeat(501)}'`)).ok, false);
  const dup = as('service_role', null, `${base('memory_type, memory_text', `'preferences', ' PREFERS voice notes to calls '`)}`);
  assert.equal(dup.ok, false, 'same text (case/space-insensitive) is a duplicate');
  assert.match(dup.err, /duplicate key|unique/i);
});

test('new memories default to candidate and inferred', { skip }, () => {
  const r = as('service_role', null, `insert into contact_memories (user_id, contact_id, memory_type, memory_text) values ('${A}', '${A_CONTACT}', 'identity', 'brand new') returning status, is_inferred`);
  assert.equal(rows(r)[0], 'candidate|t');
});

test('deleting an import keeps reviewed memories (and their owner); deleting a contact removes everything', { skip }, () => {
  const imp = as('service_role', null, `delete from whatsapp_imports where id = '${A_IMPORT}'; select import_id is null, user_id = '${A}' from contact_memories where id = '${A_MEMORY}'; select count(*) from whatsapp_import_chunks where import_id = '${A_IMPORT}'`);
  assert.deepEqual(rows(imp).filter((l) => l !== 'DELETE 1'), ['t|t', '0']);
  const gone = as('service_role', null, `delete from contacts where id = '${A_CONTACT}'; select count(*) from contact_memories where contact_id = '${A_CONTACT}'; select count(*) from whatsapp_imports where contact_id = '${A_CONTACT}'`);
  assert.deepEqual(rows(gone).filter((l) => l !== 'DELETE 1'), ['0', '0']);
});
