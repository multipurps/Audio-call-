import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;

export function getServiceClient() {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !serviceKey) throw new Error('Supabase env vars missing');
  return createClient(SUPABASE_URL, serviceKey, { auth: { persistSession: false } });
}

// Reads the caller's Supabase auth token from the Authorization header and
// resolves it to a user id via the service client. Every api/*.js handler
// that touches user data calls this first — never trust a userId passed
// in the request body.
export async function getAuthedUserId(req, supabase) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return null;
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) return null;
  return data.user.id;
}

// Same as getAuthedUserId but returns the full user object (id, email, ...)
// for the rare handler that needs more than just the id — e.g. billing,
// which needs an email to hand Stripe for a brand-new customer.
export async function getAuthedUser(req, supabase) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return null;
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) return null;
  return data.user;
}

export const normEmail = (value) => String(value || '').trim().toLowerCase();

// Owners already written to admin_access by this server instance, so the
// bookkeeping row is written once, not on every admin request.
const ownerRecorded = new Set();

/**
 * Where does the signed-in account stand as an admin?
 *   role 'owner'  the ADMIN_EMAIL account: every admin feature, and the only
 *                 one who can approve other admins
 *   role 'admin'  an account the owner approved: every admin feature except
 *                 approving admins
 *   role null     not an admin; `status` says why:
 *                 none | pending | revoked | unverified
 * Returns null when nobody is signed in.
 *
 * The owner path never touches the database, so a missing or broken
 * admin_access table can never lock the owner out.
 */
export async function getAdminAccess(req, supabase, env = process.env) {
  const user = await getAuthedUser(req, supabase);
  if (!user) return null;
  const email = normEmail(user.email);
  const base = { user, email };
  const owner = normEmail(env.ADMIN_EMAIL);

  if (owner && email === owner) {
    const key = `${email}:${user.id}`;
    if (!ownerRecorded.has(key)) {
      // Best effort: lets purchase alerts find the owner's push subscriptions.
      // Only remembered once it worked, so it retries after the table exists.
      try {
        const { error } = await supabase.from('admin_access').upsert(
          { email, user_id: user.id, status: 'approved', decided_at: new Date().toISOString(), decided_by: 'owner' },
          { onConflict: 'email' },
        );
        if (!error) ownerRecorded.add(key);
      } catch { /* table may not exist yet */ }
    }
    return { ...base, role: 'owner', status: 'approved' };
  }
  if (!email) return { ...base, role: null, status: 'none' };

  let row = null;
  try {
    const { data, error } = await supabase.from('admin_access').select('status, user_id').eq('email', email).maybeSingle();
    if (error) {
      console.error('admin access lookup failed:', error.message);
      return { ...base, role: null, status: 'none', unavailable: true };
    }
    row = data;
  } catch (err) {
    console.error('admin access lookup failed:', err?.message);
    return { ...base, role: null, status: 'none', unavailable: true };
  }
  if (!row) return { ...base, role: null, status: 'none' };
  if (row.status !== 'approved') return { ...base, role: null, status: row.status };
  // Anyone can type any address into an email sign-up. Approval only counts
  // for an address the account has actually confirmed.
  if (!user.email_confirmed_at) return { ...base, role: null, status: 'unverified' };
  if (row.user_id !== user.id) {
    try { await supabase.from('admin_access').update({ user_id: user.id }).eq('email', email); } catch { /* best effort */ }
  }
  return { ...base, role: 'admin', status: 'approved' };
}

// Kept for callers that only need "is this an admin": returns the user (with
// the role on it) or null.
export async function requireAdmin(req, supabase, env = process.env) {
  const access = await getAdminAccess(req, supabase, env);
  if (!access?.role) return null;
  return { ...access.user, adminRole: access.role };
}
