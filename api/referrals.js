import { getServiceClient, getAuthedUser } from '../lib/supabaseAdmin.js';
import {
  getUnit, priceFor, remainingMinutes, createCheckoutSession, getCheckout,
  verifyWebhookSignature, checkoutIdFromEvent, eventType, sameAmount, classifyCheckoutState, purchaseInProgress, PURCHASE_NO_CHECKOUT_GRACE_MS } from '../lib/billing.js';
import { randomUUID } from 'node:crypto';

// Referrals AND minutes billing (Add time, paid through Bachs) live in this one
// file on purpose: Vercel's Hobby plan caps a deployment at 12 serverless
// functions and api/ is already at 12, so billing is multiplexed by ?action=
// instead of getting its own function. Actions:
//   (default)        referral code + count
//   redeem           apply a referral code
//   billing          balance + price of one unit for the Home screen
//   checkout         create a Bachs hosted checkout for N units of time
//   billing-verify   re-check this user's pending purchases with Bachs
//   billing-cancel   the provider's cancel page: close a still-pending purchase (no session)
//   webhook          signed Bachs events (no user session; also at /api/bachs-webhook)
//
// The raw request body is needed to verify the webhook signature, so body
// parsing is off for this file and JSON is parsed by hand below.
export const config = { api: { bodyParser: false } };

const BONUS_MINUTES = 30;

export async function readRawBody(req) {
  if (typeof req.rawBody === 'string' || Buffer.isBuffer(req.rawBody)) return Buffer.from(req.rawBody);
  if (typeof req.on !== 'function') {
    if (req.body == null) return Buffer.alloc(0);
    return Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body));
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no O/0/I/1 confusion
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

export default async function handler(req, res, deps = {}) {
  const supabase = deps.supabase || getServiceClient();
  const action = req.query?.action;

  const raw = await readRawBody(req);
  if (action === 'webhook') return webhook(req, res, supabase, raw, deps);

  let body = {};
  try { body = raw.length ? JSON.parse(raw.toString('utf8')) : {}; } catch { return res.status(400).json({ error: 'Invalid JSON' }); }
  req.body = body;

  if (action === 'billing-cancel') return cancelPurchase(req, res, supabase, deps);

  const user = deps.user !== undefined ? deps.user : await getAuthedUser(req, supabase);
  if (!user) return res.status(401).json({ error: 'Not signed in' });
  const userId = user.id;

  if ((action || body.action) === 'redeem') return redeem(req, res, supabase, userId);
  if (action === 'billing') return billingStatus(req, res, supabase, userId, deps);
  if (action === 'checkout') return startCheckout(req, res, supabase, user, deps);
  if (action === 'billing-verify') return verifyPending(req, res, supabase, userId, deps);
  return status(req, res, supabase, userId);
}

async function status(req, res, supabase, userId) {
  let { data: profile } = await supabase.from('profiles').select('referral_code').eq('user_id', userId).maybeSingle();

  let code = profile?.referral_code;
  if (!code) {
    // Extremely unlikely to collide given the alphabet/length, but retry once if it does.
    for (let attempt = 0; attempt < 3 && !code; attempt++) {
      const candidate = generateCode();
      const { error } = await supabase.from('profiles').upsert({ user_id: userId, referral_code: candidate }, { onConflict: 'user_id' });
      if (!error) code = candidate;
    }
  }

  const { count } = await supabase
    .from('profiles')
    .select('user_id', { count: 'exact', head: true })
    .eq('referred_by', userId);

  return res.status(200).json({ code, referralCount: count || 0, bonusPerReferral: BONUS_MINUTES });
}

async function redeem(req, res, supabase, userId) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const { code } = req.body || {};
  if (!code || !code.trim()) return res.status(400).json({ error: 'code required' });

  const { data: me } = await supabase.from('profiles').select('referred_by').eq('user_id', userId).maybeSingle();
  if (me?.referred_by) return res.status(200).json({ ok: true, note: 'already redeemed' });

  const { data: referrer } = await supabase
    .from('profiles')
    .select('user_id')
    .eq('referral_code', code.trim().toUpperCase())
    .maybeSingle();
  if (!referrer) return res.status(404).json({ error: 'Invalid referral code' });
  if (referrer.user_id === userId) return res.status(400).json({ error: "That's your own code" });

  await supabase.from('profiles').update({ referred_by: referrer.user_id }).eq('user_id', userId);

  for (const uid of [referrer.user_id, userId]) {
    const { data: usage } = await supabase.from('user_usage').select('bonus_minutes').eq('user_id', uid).maybeSingle();
    await supabase.from('user_usage').upsert(
      { user_id: uid, bonus_minutes: (usage?.bonus_minutes || 0) + BONUS_MINUTES },
      { onConflict: 'user_id' }
    );
  }

  return res.status(200).json({ ok: true, bonusMinutes: BONUS_MINUTES });
}

// ---------- Add time (Bachs) ----------

async function balanceFor(supabase, userId) {
  const { data: usage } = await supabase.from('user_usage').select('*').eq('user_id', userId).maybeSingle();
  return remainingMinutes(usage);
}

async function startCheckout(req, res, supabase, user, deps) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const env = deps.env || process.env;
  if (!env.BACHS_API_KEY) return res.status(503).json({ error: 'Payments are not set up yet.' });
  const appUrl = String(env.PUBLIC_APP_URL || '').replace(/\/+$/, '');
  if (!appUrl) return res.status(503).json({ error: 'Payments are not set up yet.' });

  const pack = priceFor(req.body?.quantity, env);
  if (!pack) return res.status(400).json({ error: 'Choose how much time to add.' });

  // A double tap, or coming back to the sheet, reuses the open checkout
  // instead of creating a second one.
  const since = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const { data: open } = await supabase
    .from('minute_purchases').select('*').eq('user_id', user.id).eq('pack_id', pack.id).eq('status', 'pending').limit(5);
  const reusable = (open || []).find((r) => r.checkout_url && r.created_at >= since);
  if (reusable) return res.status(200).json({ url: reusable.checkout_url, reused: true });

  const reference = `emy_${randomUUID()}`;
  const { data: purchase, error: insertErr } = await supabase.from('minute_purchases').insert({
    user_id: user.id, reference, pack_id: pack.id, minutes: pack.minutes,
    amount: Number(pack.amount), currency: pack.currency, status: 'pending',
  }).select().single();
  if (insertErr || !purchase) return res.status(500).json({ error: 'Could not start checkout. Try again.' });

  const { data: profile } = await supabase.from('profiles').select('name').eq('user_id', user.id).maybeSingle();
  const email = user.email || '';
  const name = (profile?.name || '').trim() || (email.split('@')[0] || 'Emysa user');

  try {
    const session = await (deps.createCheckoutSession || createCheckoutSession)({
      pack, reference, userId: user.id,
      customer: { email, name },
      // Same-scope pages (the PWA's scope is "./"), so the installed app never
      // lands on a page it can't leave.
      // Bachs appends ?checkout_id=<id> to the success URL, so that URL carries no
      // query of its own; the cancel URL does, which is how the page tells them apart.
      successUrl: `${appUrl}/pay-return.html`,
      cancelUrl: `${appUrl}/pay-return.html?pay=cancel&ref=${encodeURIComponent(reference)}`,
    }, { env, fetchImpl: deps.fetchImpl });
    const url = session?.checkout_url;
    if (!url) throw new Error('no checkout url');
    await supabase.from('minute_purchases').update({ checkout_id: session.checkout_id || null, checkout_url: url }).eq('id', purchase.id);
    return res.status(200).json({ url });
  } catch (err) {
    await supabase.from('minute_purchases').update({ status: 'cancelled' }).eq('id', purchase.id);
    console.error('bachs checkout failed:', err.message, err.status || '', err.detail || '');
    return res.status(502).json({ error: 'Could not open checkout. Try again in a moment.' });
  }
}

// Moves a pending purchase to a terminal state. `failed` needs sql/028; on a
// database that has not been migrated it is recorded as cancelled instead, which
// is the same thing to the user (nothing was charged).
async function markTerminal(supabase, purchase, state) {
  const { error } = await supabase.from('minute_purchases').update({ status: state }).eq('id', purchase.id).eq('status', 'pending');
  if (error && state === 'failed') {
    await supabase.from('minute_purchases').update({ status: 'cancelled' }).eq('id', purchase.id).eq('status', 'pending');
    return 'cancelled';
  }
  return state;
}

// Credits a purchase only after Bachs itself says the checkout is COMPLETED
// for the amount we expect. A webhook body or a client request is never
// trusted on its own. A purchase we had already closed locally (cancelled,
// expired, failed) is still credited if the provider later says it was paid:
// somebody who really paid must never lose their minutes to our bookkeeping.
async function settlePurchase(supabase, purchase, deps, known = null) {
  if (purchase.status === 'paid') return { credited: 0 };
  if (!purchase.checkout_id) return { credited: 0 };
  const checkout = known || await (deps.getCheckout || getCheckout)(purchase.checkout_id, { env: deps.env || process.env, fetchImpl: deps.fetchImpl });
  const cls = classifyCheckoutState(checkout?.status);
  if (cls === 'paid') {
    const refOk = !checkout.reference || checkout.reference === purchase.reference;
    const amountOk = sameAmount(checkout.amount, purchase.amount) && String(checkout.currency || '').toUpperCase() === String(purchase.currency).toUpperCase();
    if (!refOk || !amountOk) {
      console.error('bachs checkout mismatch, not crediting', purchase.reference);
      return { credited: 0, mismatch: true };
    }
    if (purchase.status !== 'pending') {
      // Reopen it so the (idempotent, atomic) credit function can take it.
      await supabase.from('minute_purchases').update({ status: 'pending' }).eq('id', purchase.id).eq('status', purchase.status);
    }
    const { data, error } = await supabase.rpc('credit_minute_purchase', { p_reference: purchase.reference });
    if (error) throw new Error(error.message);
    return { credited: Number(data) || 0 };
  }
  if (purchase.status === 'pending' && ['expired', 'cancelled', 'failed'].includes(cls)) {
    await markTerminal(supabase, purchase, cls);
  }
  return { credited: 0 };
}

// One purchase, brought in line with what the provider says. Returns:
//   credited    minutes added by this call
//   state       paid | expired | cancelled | failed | starting | open | processing | unknown
//   inProgress  whether "confirming payment" may show for it
async function reconcilePurchase(supabase, purchase, deps) {
  const nowMs = deps.nowMs ?? Date.now();
  const ageMs = nowMs - Date.parse(purchase.created_at);
  if (purchase.status !== 'pending') return { credited: 0, state: purchase.status, inProgress: false };

  if (!purchase.checkout_id) {
    if (ageMs > PURCHASE_NO_CHECKOUT_GRACE_MS) {
      await markTerminal(supabase, purchase, 'cancelled'); // never reached the provider
      return { credited: 0, state: 'cancelled', inProgress: false };
    }
    return { credited: 0, state: 'starting', inProgress: true };
  }

  let checkout;
  try {
    checkout = await (deps.getCheckout || getCheckout)(purchase.checkout_id, { env: deps.env || process.env, fetchImpl: deps.fetchImpl });
  } catch (err) {
    // The provider cannot be reached right now. Trust only the clock, so a
    // provider outage can never leave the spinner stuck.
    console.error('purchase reconcile: provider unreachable:', err.message);
    return { credited: 0, state: 'unknown', inProgress: purchaseInProgress({ checkoutClass: 'open', ageMs }) };
  }
  const cls = classifyCheckoutState(checkout?.status);
  if (cls === 'paid' || cls === 'expired' || cls === 'cancelled' || cls === 'failed') {
    const settled = await settlePurchase(supabase, purchase, deps, checkout);
    return { credited: settled.credited, state: cls, inProgress: false, mismatch: settled.mismatch };
  }
  return { credited: 0, state: cls, inProgress: purchaseInProgress({ checkoutClass: cls, ageMs }) };
}

// Everything Home needs to know about payments, recovered from the database and
// the provider every time it is asked (never from client state).
async function reconcileUser(supabase, userId, deps) {
  const nowMs = deps.nowMs ?? Date.now();
  const { data: rows } = await supabase
    .from('minute_purchases').select('*').eq('user_id', userId).eq('status', 'pending').order('created_at', { ascending: false }).limit(5);
  let credited = 0;
  let inProgress = false;
  let outcome = null;
  for (const row of rows || []) {
    try {
      const r = await reconcilePurchase(supabase, row, deps);
      credited += r.credited;
      if (r.inProgress) inProgress = true;
      if (!r.inProgress && ['failed', 'cancelled', 'expired'].includes(r.state) && !outcome) outcome = { id: row.id, state: r.state };
    } catch (err) {
      console.error('reconcile failed:', err.message);
      if (purchaseInProgress({ checkoutClass: 'open', ageMs: nowMs - Date.parse(row.created_at) })) inProgress = true;
    }
  }
  if (credited > 0) return { credited, inProgress, outcome: { id: 'credited', state: 'paid' } };
  if (!outcome && !inProgress) {
    // A purchase that ended without money moving a moment ago, e.g. cancelled on
    // the provider's page: tell the person once (the app remembers it did).
    const since = new Date(nowMs - 30 * 60 * 1000).toISOString();
    const { data: recent } = await supabase
      .from('minute_purchases').select('id,status,created_at').eq('user_id', userId).in('status', ['failed', 'cancelled', 'expired']).gte('created_at', since).order('created_at', { ascending: false }).limit(1);
    if (recent?.[0]) outcome = { id: recent[0].id, state: recent[0].status };
  }
  return { credited, inProgress, outcome };
}

async function billingStatus(req, res, supabase, userId, deps) {
  const unit = getUnit(deps.env || process.env);
  const settled = await reconcileUser(supabase, userId, deps);
  const balance = await balanceFor(supabase, userId);
  return res.status(200).json({
    ...balance,
    payments: Boolean((deps.env || process.env).BACHS_API_KEY),
    unit,
    pending: settled.inProgress,
    credited: settled.credited,
    outcome: settled.outcome,
  });
}

async function verifyPending(req, res, supabase, userId, deps) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const settled = await reconcileUser(supabase, userId, deps);
  const balance = await balanceFor(supabase, userId);
  return res.status(200).json({ ...balance, credited: settled.credited, pending: settled.inProgress, outcome: settled.outcome });
}

// The provider's cancel page sends the person here (see pay-return.html), so a
// cancelled checkout clears "confirming payment" at once instead of waiting for
// a timeout. No session is needed: the reference is unguessable, it can only
// close a purchase that is still pending, and the provider is asked first, so a
// checkout that was in fact paid is credited, never cancelled.
async function cancelPurchase(req, res, supabase, deps) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const reference = String(req.body?.reference || '');
  if (!/^emy_[0-9a-f-]{36}$/i.test(reference)) return res.status(400).json({ error: 'Invalid reference' });
  const { data: purchase } = await supabase.from('minute_purchases').select('*').eq('reference', reference).maybeSingle();
  if (!purchase || purchase.status !== 'pending') return res.status(200).json({ ok: true, state: purchase?.status || 'unknown' });
  let state = 'cancelled';
  try {
    if (purchase.checkout_id) {
      const checkout = await (deps.getCheckout || getCheckout)(purchase.checkout_id, { env: deps.env || process.env, fetchImpl: deps.fetchImpl });
      const cls = classifyCheckoutState(checkout?.status);
      if (cls === 'paid' || cls === 'processing') {
        const r = await reconcilePurchase(supabase, purchase, deps);
        return res.status(200).json({ ok: true, state: r.state, credited: r.credited });
      }
    }
  } catch (err) {
    console.error('cancel: provider unreachable, cancelling locally:', err.message);
  }
  await markTerminal(supabase, purchase, state);
  return res.status(200).json({ ok: true, state });
}

async function webhook(req, res, supabase, raw, deps) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const env = deps.env || process.env;
  if (!verifyWebhookSignature(raw, req.headers || {}, env.BACHS_WEBHOOK_SECRET, { nowMs: deps.nowMs })) {
    return res.status(401).json({ error: 'Invalid signature' });
  }
  let event;
  try { event = JSON.parse(raw.toString('utf8')); } catch { return res.status(400).json({ error: 'Invalid JSON' }); }

  // Only a completed checkout can credit minutes; everything else is acknowledged.
  if (eventType(event) !== 'checkout.completed') return res.status(200).json({ ok: true, ignored: true });
  const checkoutId = checkoutIdFromEvent(event);
  if (!checkoutId) return res.status(200).json({ ok: true, ignored: true });

  const { data: purchase } = await supabase.from('minute_purchases').select('*').eq('checkout_id', checkoutId).maybeSingle();
  if (!purchase) return res.status(200).json({ ok: true, ignored: true });
  try {
    const result = await settlePurchase(supabase, purchase, deps);
    return res.status(200).json({ ok: true, credited: result.credited });
  } catch (err) {
    console.error('bachs webhook failed:', err.message);
    return res.status(500).json({ error: 'Could not settle purchase' }); // Bachs retries on non-2xx
  }
}
