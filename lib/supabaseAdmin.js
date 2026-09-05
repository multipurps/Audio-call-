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

export async function requireAdmin(req, supabase) {
  const adminEmail = process.env.ADMIN_EMAIL;
  if (!adminEmail) return null;
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return null;
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) return null;
  const signedInEmail = (data.user.email || '').trim().toLowerCase();
  if (signedInEmail !== adminEmail.trim().toLowerCase()) return null;
  return data.user;
}
