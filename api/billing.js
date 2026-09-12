import { getServiceClient, getAuthedUser } from '../lib/supabaseAdmin.js';

// Pro plan via Stripe Checkout. Raw REST calls (Bearer auth with the secret
// key), same pattern as every other provider in this app — no Stripe SDK.
// Subscription status is kept in sync by api/stripe-webhook.js, not by
// anything in here; this file only ever kicks a session off or opens the
// billing portal.
async function stripeFetch(path, body) {
  const key = process.env.STRIPE_SECRET_KEY;
  const resp = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error?.message || 'Stripe request failed');
  return data;
}

export default async function handler(req, res) {
  const supabase = getServiceClient();
  const user = await getAuthedUser(req, supabase);
  if (!user) return res.status(401).json({ error: 'Not signed in' });

  const action = req.query?.action;
  if (action === 'checkout') return checkout(req, res, supabase, user);
  if (action === 'portal') return portal(req, res, supabase, user);
  return status(req, res, supabase, user);
}

async function status(req, res, supabase, user) {
  const { data } = await supabase.from('subscriptions').select('status, current_period_end').eq('user_id', user.id).maybeSingle();
  return res.status(200).json({ status: data?.status || 'none', currentPeriodEnd: data?.current_period_end || null });
}

async function checkout(req, res, supabase, user) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const priceId = process.env.STRIPE_PRICE_ID;
  const appUrl = process.env.PUBLIC_APP_URL;
  if (!process.env.STRIPE_SECRET_KEY || !priceId || !appUrl) {
    return res.status(500).json({ error: 'Billing isn\'t configured yet.' });
  }

  const { data: existing } = await supabase.from('subscriptions').select('stripe_customer_id').eq('user_id', user.id).maybeSingle();

  try {
    const body = {
      mode: 'subscription',
      'line_items[0][price]': priceId,
      'line_items[0][quantity]': '1',
      success_url: `${appUrl}/?upgraded=1`,
      cancel_url: `${appUrl}/`,
      client_reference_id: user.id,
      'subscription_data[metadata][user_id]': user.id,
      allow_promotion_codes: 'true',
    };
    if (existing?.stripe_customer_id) body.customer = existing.stripe_customer_id;
    else if (user.email) body.customer_email = user.email;

    const session = await stripeFetch('checkout/sessions', body);
    return res.status(200).json({ url: session.url });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

async function portal(req, res, supabase, user) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const appUrl = process.env.PUBLIC_APP_URL;
  const { data: sub } = await supabase.from('subscriptions').select('stripe_customer_id').eq('user_id', user.id).maybeSingle();
  if (!sub?.stripe_customer_id) return res.status(400).json({ error: 'Subscribe first, then you can manage billing here.' });
  try {
    const session = await stripeFetch('billing_portal/sessions', { customer: sub.stripe_customer_id, return_url: `${appUrl}/` });
    return res.status(200).json({ url: session.url });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
