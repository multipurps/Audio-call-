import crypto from 'crypto';
import { getServiceClient } from '../lib/supabaseAdmin.js';

// Signature verification needs the exact raw request bytes, so auto body
// parsing has to be off for this one route — everywhere else in this app
// is fine with Vercel's default JSON/form parsing.
export const config = { api: { bodyParser: false } };

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function verifySignature(rawBody, sigHeader, secret) {
  if (!sigHeader) return false;
  const parts = Object.fromEntries(sigHeader.split(',').map((p) => p.split('=')));
  const expected = crypto.createHmac('sha256', secret).update(`${parts.t}.${rawBody}`).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(parts.v1 || ''));
  } catch {
    return false;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('POST only');

  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  const rawBody = await readRawBody(req);

  if (secret) {
    const ok = verifySignature(rawBody, req.headers['stripe-signature'], secret);
    if (!ok) return res.status(400).send('Invalid signature');
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return res.status(400).send('Invalid payload');
  }

  const supabase = getServiceClient();
  const obj = event.data?.object;

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const userId = obj.client_reference_id || obj.subscription_data?.metadata?.user_id;
        if (userId && obj.customer) {
          await supabase.from('subscriptions').upsert(
            { user_id: userId, stripe_customer_id: obj.customer, stripe_subscription_id: obj.subscription || null, status: 'active', updated_at: new Date().toISOString() },
            { onConflict: 'user_id' }
          );
        }
        break;
      }
      case 'customer.subscription.updated':
      case 'customer.subscription.created': {
        const userId = obj.metadata?.user_id;
        if (userId) {
          await supabase.from('subscriptions').upsert(
            {
              user_id: userId,
              stripe_customer_id: obj.customer,
              stripe_subscription_id: obj.id,
              status: obj.status,
              current_period_end: obj.current_period_end ? new Date(obj.current_period_end * 1000).toISOString() : null,
              updated_at: new Date().toISOString(),
            },
            { onConflict: 'user_id' }
          );
        }
        break;
      }
      case 'customer.subscription.deleted': {
        const userId = obj.metadata?.user_id;
        if (userId) {
          await supabase.from('subscriptions').update({ status: 'canceled', updated_at: new Date().toISOString() }).eq('user_id', userId);
        }
        break;
      }
      default:
        break; // ignore anything we don't act on
    }
  } catch (err) {
    console.error('stripe webhook handling failed:', err);
    // Still 200 — Stripe retries on non-2xx, which would just repeat a bug
    // rather than fix it. Logged above for whoever's watching the deploy.
  }

  return res.status(200).send('ok');
}
