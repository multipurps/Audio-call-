// Web-push alert to every admin when a minutes purchase succeeds.
//
// Called once, by the code path that actually credits the minutes
// (credit_minute_purchase returns > 0 only the first time), so a replayed
// webhook or a racing "verify" call cannot send a second alert. Never throws:
// a push problem must never cost anyone their minutes or fail the webhook.
import webpush from 'web-push';
import { normEmail } from './supabaseAdmin.js';

const SEND_TIMEOUT_MS = 5000;

function money(amount, currency) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return `${amount} ${currency || ''}`.trim();
  try {
    return new Intl.NumberFormat('en', {
      style: 'currency', currency: String(currency || 'USD').toUpperCase(), currencyDisplay: 'narrowSymbol',
      minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: Number.isInteger(n) ? 0 : 2,
    }).format(n);
  } catch { return `${n} ${currency || ''}`.trim(); }
}

function duration(minutes) {
  const m = Number(minutes);
  if (!Number.isFinite(m) || m <= 0) return '';
  if (m % 60 === 0) return `${m / 60} ${m === 60 ? 'hour' : 'hours'}`;
  return `${m} min`;
}

export function buildPurchasePushPayload(purchase, buyer) {
  const what = duration(purchase.minutes);
  const paid = money(purchase.amount, purchase.currency);
  return {
    title: `Purchase: ${paid}`,
    body: [what ? `${what} of call time` : null, buyer || null].filter(Boolean).join(' · ') || 'A minutes purchase was paid.',
    url: '/admin/',
    tag: `purchase-${purchase.reference || purchase.id || Date.now()}`,
  };
}

// The user ids of everyone who may see revenue: approved admins, plus the
// owner (ADMIN_EMAIL). The owner's id is recorded in admin_access the first
// time they open the admin page; until then it is found in the auth list.
export async function adminUserIds(supabase, env = process.env) {
  const ids = new Set();
  const ownerEmail = normEmail(env.ADMIN_EMAIL);
  let ownerFound = false;
  try {
    const { data } = await supabase.from('admin_access').select('email, user_id').eq('status', 'approved');
    for (const row of data || []) {
      if (!row.user_id) continue;
      ids.add(row.user_id);
      if (ownerEmail && normEmail(row.email) === ownerEmail) ownerFound = true;
    }
  } catch { /* table may not exist yet: fall through to the owner lookup */ }
  if (ownerEmail && !ownerFound) {
    try {
      for (let page = 1; page <= 3 && !ownerFound; page++) {
        const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 1000 });
        if (error) break;
        const hit = (data?.users || []).find((u) => normEmail(u.email) === ownerEmail);
        if (hit) { ids.add(hit.id); ownerFound = true; }
        if ((data?.users || []).length < 1000) break;
      }
    } catch { /* no owner id: nothing to send them */ }
  }
  return [...ids];
}

export async function notifyAdminsOfPurchase(supabase, purchase, { env = process.env, sender = webpush } = {}) {
  try {
    if (!supabase || !purchase) return { status: 'noop' };
    const { VAPID_PUBLIC_KEY: pub, VAPID_PRIVATE_KEY: priv, VAPID_SUBJECT: subject } = env;
    if (!pub || !priv || !subject) {
      console.warn('adminPush: skipped, VAPID env vars not set');
      return { status: 'not-configured' };
    }
    sender.setVapidDetails(subject, pub, priv);

    const adminIds = await adminUserIds(supabase, env);
    if (!adminIds.length) return { status: 'no-admins' };
    const { data: subs, error } = await supabase.from('push_subscriptions').select('id, endpoint, p256dh, auth').in('user_id', adminIds);
    if (error) { console.error('adminPush: subscription lookup failed', error.message); return { status: 'error' }; }
    if (!subs?.length) return { status: 'no-subscriptions' };

    let buyer = null;
    try {
      const { data } = await supabase.auth.admin.getUserById(purchase.user_id);
      buyer = data?.user?.email || null;
    } catch { /* the alert is still useful without the buyer */ }

    const payload = JSON.stringify(buildPurchasePushPayload(purchase, buyer));
    let sent = 0;
    let failed = 0;
    await Promise.all(subs.map(async (sub) => {
      try {
        await sender.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload, { TTL: 86400, timeout: SEND_TIMEOUT_MS });
        sent++;
      } catch (err) {
        failed++;
        console.warn(`adminPush: send failed status=${err?.statusCode || 'none'} ${String(err?.body || err?.message || '').slice(0, 120)}`);
        if (err?.statusCode === 404 || err?.statusCode === 410) await supabase.from('push_subscriptions').delete().eq('id', sub.id);
      }
    }));
    console.log(`adminPush: purchase alert sent=${sent} failed=${failed}`);
    return { status: 'sent', sent, failed };
  } catch (err) {
    console.error('adminPush: unexpected failure', err?.message || err);
    return { status: 'error' };
  }
}
