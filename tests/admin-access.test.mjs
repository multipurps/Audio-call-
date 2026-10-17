import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

// A small in-memory Supabase for the admin tables. (tests/helpers.mjs upserts by
// user_id; admin_access is keyed by email.)
function fakeSupabase({ users = {}, admin_access = [], push_subscriptions = [], failAccess = false } = {}) {
  const tables = { admin_access: structuredClone(admin_access), push_subscriptions: structuredClone(push_subscriptions) };
  const byId = Object.fromEntries(Object.values(users).map((u) => [u.id, u]));
  const from = (name) => {
    tables[name] ||= [];
    let mode = 'select'; let values; let one = false; const filters = []; let ignoreDup = false; let key = 'id';
    const q = {
      select() { return q; },
      eq(k, v) { filters.push((r) => r[k] === v); return q; },
      in(k, vs) { filters.push((r) => vs.includes(r[k])); return q; },
      order() { return q; }, limit() { return q; }, range() { return q; },
      gte(k, v) { filters.push((r) => r[k] >= v); return q; },
      maybeSingle() { one = true; return q; },
      upsert(v, o = {}) { mode = 'upsert'; values = v; key = o.onConflict || 'id'; ignoreDup = Boolean(o.ignoreDuplicates); return q; },
      update(v) { mode = 'update'; values = v; return q; },
      delete() { mode = 'delete'; return q; },
      then(ok, fail) {
        if (failAccess && name === 'admin_access') return Promise.resolve({ data: null, error: { message: 'relation "admin_access" does not exist' } }).then(ok, fail);
        let rows = tables[name].filter((r) => filters.every((f) => f(r)));
        if (mode === 'upsert') {
          const hit = tables[name].find((r) => r[key] === values[key]);
          if (hit) { if (!ignoreDup) Object.assign(hit, values); } else tables[name].push({ ...values });
          rows = [];
        }
        if (mode === 'update') rows.forEach((r) => Object.assign(r, values));
        if (mode === 'delete') tables[name] = tables[name].filter((r) => !rows.includes(r));
        return Promise.resolve({ data: structuredClone(one ? rows[0] || null : rows), error: null }).then(ok, fail);
      },
    };
    return q;
  };
  return {
    tables, from,
    auth: {
      getUser: async (token) => (users[token] ? { data: { user: users[token] }, error: null } : { data: null, error: { message: 'bad token' } }),
      admin: {
        getUserById: async (id) => ({ data: { user: byId[id] || null }, error: null }),
        listUsers: async () => ({ data: { users: Object.values(users) }, error: null }),
      },
    },
  };
}

const confirmed = '2026-01-01T00:00:00Z';
const U = {
  owner: { id: 'u-owner', email: 'Owner@Example.com', email_confirmed_at: confirmed },
  investor: { id: 'u-inv', email: 'investor@example.com', email_confirmed_at: confirmed },
  stranger: { id: 'u-str', email: 'stranger@example.com', email_confirmed_at: confirmed },
  unverified: { id: 'u-unv', email: 'late@example.com', email_confirmed_at: null },
};
const users = { t_owner: U.owner, t_investor: U.investor, t_stranger: U.stranger, t_unverified: U.unverified };
const env = { ADMIN_EMAIL: 'owner@example.com' };
const req = (token, extra = {}) => ({ headers: token ? { authorization: `Bearer ${token}` } : {}, query: {}, method: 'GET', ...extra });

// Import the real auth helpers first, then swap only getServiceClient so the admin
// API runs against the fake database. One mock, one handler, a database per test.
const real = await import('../lib/supabaseAdmin.js');
const { getAdminAccess, requireAdmin, normEmail } = real;
let currentDb;
mock.module(new URL('../lib/supabaseAdmin.js', import.meta.url).href, {
  namedExports: { ...real, getServiceClient: () => currentDb },
});
const { notifyAdminsOfPurchase, buildPurchasePushPayload, adminUserIds } = await import('../lib/adminPush.js');
const adminApi = (await import('../api/admin.js')).default;

test('owner: matched by ADMIN_EMAIL ignoring case, never needs the table, and is recorded for alerts', async () => {
  const db = fakeSupabase({ users, failAccess: true });
  const a = await getAdminAccess(req('t_owner'), db, env);
  assert.equal(a.role, 'owner');
  const ok = fakeSupabase({ users });
  await getAdminAccess(req('t_owner'), ok, { ADMIN_EMAIL: 'OWNER@example.com ' });
  assert.deepEqual(ok.tables.admin_access.map((r) => [r.email, r.user_id, r.status]), [['owner@example.com', 'u-owner', 'approved']]);
});

test('approved admin: full access once the email is confirmed; every other state is refused', async () => {
  const rows = (status, email = 'investor@example.com', user_id = null) => [{ email, status, user_id }];
  const check = async (token, admin_access) => getAdminAccess(req(token), fakeSupabase({ users, admin_access }), env);

  const approved = await check('t_investor', rows('approved'));
  assert.deepEqual([approved.role, approved.status], ['admin', 'approved']);
  assert.deepEqual([(await check('t_investor', rows('pending'))).role, (await check('t_investor', rows('pending'))).status], [null, 'pending']);
  assert.equal((await check('t_investor', rows('revoked'))).status, 'revoked');
  assert.equal((await check('t_investor', rows('revoked'))).role, null);
  assert.equal((await check('t_stranger', rows('approved'))).role, null, 'approval is per email address');
  assert.equal((await check('t_stranger', [])).status, 'none');
  // An approved address that was never confirmed does not count: anyone can type any email at sign-up.
  const unv = await check('t_unverified', rows('approved', 'late@example.com'));
  assert.deepEqual([unv.role, unv.status], [null, 'unverified']);
  assert.equal(await getAdminAccess(req(null), fakeSupabase({ users }), env), null, 'signed out');
  assert.equal(await getAdminAccess(req('bad'), fakeSupabase({ users }), env), null, 'bad token');
});

test('a broken table locks out approved admins, never grants access and never locks out the owner', async () => {
  const broken = fakeSupabase({ users, admin_access: [{ email: 'investor@example.com', status: 'approved' }], failAccess: true });
  const inv = await getAdminAccess(req('t_investor'), broken, env);
  assert.equal(inv.role, null);
  assert.equal(inv.unavailable, true);
  assert.equal((await getAdminAccess(req('t_owner'), broken, env)).role, 'owner');
});

test('an approved admin gets their user id recorded on first sign-in', async () => {
  const db = fakeSupabase({ users, admin_access: [{ email: 'investor@example.com', status: 'approved', user_id: null }] });
  await getAdminAccess(req('t_investor'), db, env);
  assert.equal(db.tables.admin_access[0].user_id, 'u-inv');
});

test('requireAdmin still answers "is this an admin" for older callers', async () => {
  const db = fakeSupabase({ users, admin_access: [{ email: 'investor@example.com', status: 'approved' }] });
  assert.equal((await requireAdmin(req('t_owner'), db, env)).adminRole, 'owner');
  assert.equal((await requireAdmin(req('t_investor'), db, env)).adminRole, 'admin');
  assert.equal(await requireAdmin(req('t_stranger'), db, env), null);
});

// ---- the admin API: who can call what ----
async function adminHandler(db) { currentDb = db; return adminApi; }
const res = () => ({ code: 200, data: null, status(c) { this.code = c; return this; }, json(d) { this.data = d; return this; } });
async function call(handler, token, action, { method = 'GET', body = {} } = {}) {
  const r = res();
  process.env.ADMIN_EMAIL = env.ADMIN_EMAIL;
  await handler({ method, query: { action }, headers: { authorization: `Bearer ${token}` }, body }, r);
  return r;
}

test('API: an approved admin reaches admin features but not admin management; the owner reaches both', async () => {
  const db = fakeSupabase({ users, admin_access: [{ email: 'investor@example.com', status: 'approved', user_id: 'u-inv' }] });
  const handler = await adminHandler(db);

  assert.equal((await call(handler, 't_investor', 'access-status')).data.role, 'admin');
  for (const action of ['admin-list']) assert.equal((await call(handler, 't_investor', action)).code, 403, action);
  const tryApprove = await call(handler, 't_investor', 'admin-decide', { method: 'POST', body: { email: 'friend@example.com', decision: 'approve' } });
  assert.equal(tryApprove.code, 403);
  assert.equal(db.tables.admin_access.some((r) => r.email === 'friend@example.com'), false, 'nothing was written');
  // Past the gate only on purpose: an action nobody listed for them is refused, not "unknown".
  assert.equal((await call(handler, 't_investor', 'no-such-action')).code, 403);

  assert.equal((await call(handler, 't_stranger', 'list-users')).code, 403);
  assert.equal((await call(handler, 't_stranger', 'grant-credit', { method: 'POST' })).code, 403);
  assert.equal((await call(handler, 't_stranger', 'admin-list')).code, 403);

  const owner = await call(handler, 't_owner', 'admin-list');
  assert.equal(owner.code, 200);
  assert.deepEqual(owner.data.admins.map((r) => r.email), ['investor@example.com']);
});

test('API: owner approves, removes and re-approves; the owner row cannot be changed; bad emails are refused', async () => {
  const db = fakeSupabase({ users });
  const handler = await adminHandler(db);
  const decide = (email, decision) => call(handler, 't_owner', 'admin-decide', { method: 'POST', body: { email, decision } });

  assert.equal((await decide(' Friend@Example.com ', 'approve')).data.status, 'approved');
  assert.equal(db.tables.admin_access.find((r) => r.email === 'friend@example.com').status, 'approved');
  assert.equal((await decide('friend@example.com', 'revoke')).data.status, 'revoked');
  assert.equal((await decide('friend@example.com', 'approve')).data.status, 'approved');
  assert.equal((await decide('owner@example.com', 'revoke')).code, 400, 'the owner cannot be removed');
  assert.equal((await decide('not-an-email', 'approve')).code, 400);
  assert.equal((await decide('friend@example.com', 'promote')).code, 400);
  assert.equal((await call(handler, 't_owner', 'admin-decide', { method: 'GET' })).code, 405);
});

test('API: anyone signed in can ask for access once; unconfirmed emails cannot; asking never grants it', async () => {
  const db = fakeSupabase({ users });
  const handler = await adminHandler(db);
  const ask = (token) => call(handler, token, 'request-access', { method: 'POST' });

  assert.equal((await ask('t_stranger')).data.status, 'pending');
  assert.equal((await ask('t_stranger')).data.status, 'pending');
  assert.equal(db.tables.admin_access.filter((r) => r.email === 'stranger@example.com').length, 1);
  assert.equal((await call(handler, 't_stranger', 'list-users')).code, 403, 'a pending request is not access');
  assert.equal((await ask('t_unverified')).code, 403);
  assert.equal(db.tables.admin_access.some((r) => r.email === 'late@example.com'), false);

  await call(handler, 't_owner', 'admin-decide', { method: 'POST', body: { email: 'stranger@example.com', decision: 'revoke' } });
  assert.equal((await ask('t_stranger')).data.status, 'revoked', 'a removed person cannot re-request their way back in');
  assert.equal((await call(handler, 't_stranger', 'access-status')).data.role, null);
});

// ---- purchase alerts ----
const purchase = { id: 'p1', user_id: 'u-stranger-buyer', reference: 'emy_9', minutes: 60, amount: '28000.00', currency: 'NGN' };
const vapid = { VAPID_PUBLIC_KEY: 'pub', VAPID_PRIVATE_KEY: 'priv', VAPID_SUBJECT: 'mailto:a@b.co', ADMIN_EMAIL: 'owner@example.com' };
const sub = (id, user_id) => ({ id, user_id, endpoint: `https://push.example/${id}`, p256dh: 'k', auth: 'a' });
function sender(fail = {}) {
  const sent = [];
  return { sent, setVapidDetails() {}, async sendNotification(s, payload) { if (fail[s.endpoint]) throw Object.assign(new Error('gone'), { statusCode: fail[s.endpoint] }); sent.push({ endpoint: s.endpoint, payload: JSON.parse(payload) }); } };
}

test('alert text: amount, length of time and buyer', () => {
  const p = buildPurchasePushPayload({ minutes: 60, amount: '28000.00', currency: 'NGN', reference: 'emy_9' }, 'buyer@example.com');
  assert.match(p.title, /28,000/);
  assert.match(p.title, /NGN|₦/);
  assert.equal(p.body, '1 hour of call time · buyer@example.com');
  assert.equal(p.url, '/admin/');
  assert.equal(buildPurchasePushPayload({ minutes: 30, amount: 15000, currency: 'NGN' }).body, '30 min of call time');
  assert.equal(buildPurchasePushPayload({ minutes: 180, amount: 56000, currency: 'NGN' }).body, '3 hours of call time');
});

test('alerts go to the owner and approved admins only, never to other users or removed admins', async () => {
  const db = fakeSupabase({
    users: { ...users, t_buyer: { id: 'u-stranger-buyer', email: 'buyer@example.com', email_confirmed_at: confirmed } },
    admin_access: [
      { email: 'owner@example.com', status: 'approved', user_id: 'u-owner' },
      { email: 'investor@example.com', status: 'approved', user_id: 'u-inv' },
      { email: 'gone@example.com', status: 'revoked', user_id: 'u-gone' },
      { email: 'wait@example.com', status: 'pending', user_id: 'u-wait' },
    ],
    push_subscriptions: [sub('s-owner', 'u-owner'), sub('s-inv', 'u-inv'), sub('s-gone', 'u-gone'), sub('s-wait', 'u-wait'), sub('s-buyer', 'u-stranger-buyer')],
  });
  const s = sender();
  const out = await notifyAdminsOfPurchase(db, purchase, { env: vapid, sender: s });
  assert.deepEqual(out, { status: 'sent', sent: 2, failed: 0 });
  assert.deepEqual(s.sent.map((x) => x.endpoint).sort(), ['https://push.example/s-inv', 'https://push.example/s-owner']);
  assert.match(s.sent[0].payload.body, /buyer@example.com/);
});

test('the owner is found even before they have opened the admin page', async () => {
  const db = fakeSupabase({ users, push_subscriptions: [sub('s-owner', 'u-owner')] });
  assert.deepEqual(await adminUserIds(db, vapid), ['u-owner']);
  const s = sender();
  assert.equal((await notifyAdminsOfPurchase(db, purchase, { env: vapid, sender: s })).sent, 1);
});

test('alerts never throw: missing keys, no admins, no devices, a dead device and a broken table are all handled', async () => {
  const db = fakeSupabase({ users, push_subscriptions: [sub('s-owner', 'u-owner'), sub('s-dead', 'u-owner')] });
  assert.equal((await notifyAdminsOfPurchase(db, purchase, { env: { ADMIN_EMAIL: 'owner@example.com' }, sender: sender() })).status, 'not-configured');
  assert.equal((await notifyAdminsOfPurchase(db, null, { env: vapid, sender: sender() })).status, 'noop');
  assert.equal((await notifyAdminsOfPurchase(fakeSupabase({ users: {} }), purchase, { env: vapid, sender: sender() })).status, 'no-admins');
  assert.equal((await notifyAdminsOfPurchase(fakeSupabase({ users }), purchase, { env: vapid, sender: sender() })).status, 'no-subscriptions');
  const dead = await notifyAdminsOfPurchase(db, purchase, { env: vapid, sender: sender({ 'https://push.example/s-dead': 410 }) });
  assert.deepEqual([dead.sent, dead.failed], [1, 1]);
  assert.equal(db.tables.push_subscriptions.some((r) => r.id === 's-dead'), false, 'an expired device is removed');
  const broken = fakeSupabase({ users, failAccess: true, push_subscriptions: [sub('s-owner', 'u-owner')] });
  assert.equal((await notifyAdminsOfPurchase(broken, purchase, { env: vapid, sender: sender() })).sent, 1, 'the owner still gets alerts if the admin table is down');
  const exploding = { ...sender(), setVapidDetails() { throw new Error('bad key'); } };
  assert.equal((await notifyAdminsOfPurchase(db, purchase, { env: vapid, sender: exploding })).status, 'error');
});

test('normEmail trims and lower-cases', () => {
  assert.equal(normEmail('  A@B.Co '), 'a@b.co');
  assert.equal(normEmail(null), '');
});


// ---- approved admins are read-only investors ----
const investorDb = () => fakeSupabase({ users, admin_access: [{ email: 'investor@example.com', status: 'approved', user_id: 'u-inv' }] });

test('API: an approved admin is refused everything that changes data or is owner-only, on the server', async () => {
  const handler = await adminHandler(investorDb());
  const blocked = [
    ['GET', 'list-users'], ['POST', 'set-approval'], ['POST', 'grant-credit'], ['GET', 'credit-ledger'], ['POST', 'send-announcement'],
    ['POST', 'create-background-upload'], ['POST', 'confirm-background'], ['POST', 'delete-background'],
    ['POST', 'create-hero-upload'], ['POST', 'confirm-hero'], ['POST', 'delete-hero'],
    ['POST', 'create-landing-upload'], ['POST', 'confirm-landing-upload'], ['POST', 'delete-landing-media'], ['POST', 'reorder-landing-media'],
    ['GET', 'admin-list'], ['POST', 'admin-decide'],
    ['POST', 'rates'], // reading the rates is allowed, changing them is not
    // AI behavior and Call Emysa
    ['GET', 'ai-overview'], ['POST', 'ai-config-save'], ['POST', 'ai-config-publish'], ['POST', 'ai-config-rollback'], ['GET', 'ai-knowledge-list'],
    ['POST', 'ai-knowledge-save'], ['POST', 'ai-knowledge-status'], ['POST', 'ai-knowledge-delete'], ['GET', 'ai-knowledge-history'],
    ['POST', 'ai-knowledge-restore'], ['POST', 'ai-preview'], ['POST', 'ai-test'], ['GET', 'ai-audit'],
    ['POST', 'ai-train-call-start'], ['POST', 'ai-train-learn'],
  ];
  for (const [method, action] of blocked) {
    const r = await call(handler, 't_investor', action, { method });
    assert.equal(r.code, 403, `${method} ${action} must be refused for an approved admin`);
  }
  // The same calls are not blocked by the gate for the owner (they get past it and fail later or succeed).
  for (const [method, action] of [['POST', 'ai-train-call-start'], ['GET', 'admin-list']]) {
    assert.notEqual((await call(handler, 't_owner', action, { method })).code, 403, `${action} for the owner`);
  }
});

test('API: an approved admin can read the investor figures, and only those', async () => {
  const handler = await adminHandler(investorDb());
  assert.equal((await call(handler, 't_investor', 'access-status')).data.role, 'admin');
  for (const action of ['overview', 'analytics', 'rates']) {
    let code; try { code = (await call(handler, 't_investor', action)).code; } catch { code = 'ran'; }
    assert.notEqual(code, 403, `${action} must stay open to an approved admin`);
  }
});

test('analytics: customers are masked for an approved admin and shown in full to the owner', async () => {
  const now = new Date().toISOString();
  const db = fakeSupabase({ users: { ...users, t_cust: { id: 'u-cust', email: 'jane.doe@gmail.com', email_confirmed_at: confirmed } }, admin_access: [{ email: 'investor@example.com', status: 'approved', user_id: 'u-inv' }] });
  db.tables.calls = [{ user_id: 'u-cust', duration_seconds: 120, created_at: now }];
  const handler = await adminHandler(db);
  const inv = await call(handler, 't_investor', 'analytics');
  assert.equal(inv.code, 200);
  assert.deepEqual(inv.data.users.map((u) => u.email), ['ja***@gmail.com']);
  assert.equal(JSON.stringify(inv.data).includes('jane.doe'), false);
  const owner = await call(handler, 't_owner', 'analytics');
  assert.deepEqual(owner.data.users.map((u) => u.email), ['jane.doe@gmail.com']);
});

test('maskEmail hides the name but keeps the domain', () => {
  assert.equal(real.maskEmail('jane.doe@gmail.com'), 'ja***@gmail.com');
  assert.equal(real.maskEmail('a@x.io'), 'a***@x.io');
  assert.equal(real.maskEmail(''), '***');
});

import { readFileSync } from 'node:fs';
test('admin page: investors only get Overview, Usage and Costs, read-only, with no purchase-alert setup', () => {
  const src = readFileSync(new URL('../admin/admin.js', import.meta.url), 'utf8');
  assert.match(src, /const INVESTOR_SECTIONS = \['overview', 'usage', 'costs'\]/);
  assert.match(src, /if \(myRole !== 'owner' && !INVESTOR_SECTIONS\.includes\(el\.dataset\.s\)\) el\.style\.display = 'none'/);
  assert.match(src, /if \(myRole === 'owner'\) \{\s*const usersResp/, 'only the owner loads the user list');
  assert.match(src, /if \(myRole === 'owner'\) renderAlertsCard\(el\)/);
  assert.match(src, /const ro = myRole !== 'owner'/);
  const api = readFileSync(new URL('../api/admin.js', import.meta.url), 'utf8');
  assert.match(api, /const INVESTOR_ACTIONS = new Set\(\['overview', 'analytics', 'rates'\]\)/);
});
