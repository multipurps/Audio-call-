// Web-push notification for a finished call summary.
//
// Called once by whichever trigger wins the summary claim in
// maybeGenerateCallSummary, so the user gets exactly one push per call no
// matter whether the call ended from the End button, the callee hanging up,
// or the AI ending it. Never throws: a push failure must not cost the summary.
// Logs carry ids and outcomes only.
import webpush from 'web-push';

export function buildSummaryPushPayload(callId, summaryText, contactName) {
  const clean = String(summaryText || '').replace(/\s+/g, ' ').trim();
  const body = clean.length > 140 ? `${clean.slice(0, 137).trimEnd()}...` : clean;
  return {
    title: contactName ? `Call summary: ${contactName}` : 'Call summary ready',
    body: body || 'Your call summary is ready.',
    url: `./index.html?callId=${encodeURIComponent(callId)}`,
    callId,
    tag: `call-summary-${callId}`,
  };
}

export async function sendCallSummaryPush(supabase, { userId, callId, summary, contactName = null, env = process.env, sender = webpush }) {
  try {
    if (!supabase || !userId || !callId) return { status: 'noop' };
    const { VAPID_PUBLIC_KEY: pub, VAPID_PRIVATE_KEY: priv, VAPID_SUBJECT: subject } = env;
    if (!pub || !priv || !subject) {
      console.warn('summaryPush: skipped, VAPID env vars not set', callId);
      return { status: 'not-configured' };
    }
    sender.setVapidDetails(subject, pub, priv);

    const { data: subs, error } = await supabase.from('push_subscriptions').select('id, endpoint, p256dh, auth').eq('user_id', userId);
    if (error) {
      console.error('summaryPush: subscription lookup failed', callId, error.message);
      return { status: 'error' };
    }
    if (!subs || subs.length === 0) return { status: 'no-subscriptions' };

    const payload = JSON.stringify(buildSummaryPushPayload(callId, summary, contactName));
    let sent = 0;
    let failed = 0;
    await Promise.all(subs.map(async (sub) => {
      try {
        await sender.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload);
        sent++;
      } catch (err) {
        failed++;
        // The push service's own reason (e.g. 403 VapidPkHashMismatch, 401 bad VAPID signature, 410 gone).
        console.warn(`summaryPush: send failed call=${callId} status=${err?.statusCode || 'none'} ${String(err?.body || err?.message || '').slice(0, 160)}`);
        if (err?.statusCode === 404 || err?.statusCode === 410) {
          await supabase.from('push_subscriptions').delete().eq('id', sub.id);
        }
      }
    }));
    console.log(`summaryPush: call=${callId} sent=${sent} failed=${failed}`);
    return { status: 'sent', sent, failed };
  } catch (err) {
    console.error('summaryPush: unexpected failure', callId, err?.message || err);
    return { status: 'error' };
  }
}
