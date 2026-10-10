import { randomUUID } from 'crypto';
import webpush from 'web-push';
import { getServiceClient, requireAdmin } from '../lib/supabaseAdmin.js';

// Every admin-only action lives here behind ?action=..., instead of one
// file per action — Vercel's Hobby plan caps a deployment at 12 serverless
// functions, and this app was one file away from that limit. All of these
// were already gated by requireAdmin() individually; merging them changes
// nothing about who can call what.
export default async function handler(req, res) {
  const supabase = getServiceClient();
  // Only this curated projection is public. Every mutation still requires ADMIN_EMAIL.
  if (req.query?.action === 'landing-media' && req.method === 'GET') return listLandingMedia(req, res, supabase);
  const admin = await requireAdmin(req, supabase);
  if (!admin) return res.status(403).json({ error: 'Not authorized' });

  const action = req.query?.action || req.body?.action;

  switch (action) {
    case 'create-landing-upload': return createLandingUpload(req, res, supabase);
    case 'confirm-landing-upload': return confirmLandingUpload(req, res, supabase);
    case 'delete-landing-media': return deleteLandingMedia(req, res, supabase);
    case 'reorder-landing-media': return reorderLandingMedia(req, res, supabase);
    case 'list-users': return listUsers(req, res, supabase);
    case 'set-approval': return setApproval(req, res, supabase);
    case 'create-background-upload': return createBackgroundUpload(req, res, supabase);
    case 'confirm-background': return confirmBackground(req, res, supabase);
    case 'delete-background': return deleteBackground(req, res, supabase);
    case 'create-hero-upload': return createHeroUpload(req, res, supabase);
    case 'confirm-hero': return confirmHero(req, res, supabase);
    case 'delete-hero': return deleteHero(req, res, supabase);
    case 'analytics': return analytics(req, res, supabase);
    case 'send-announcement': return sendAnnouncement(req, res, supabase);
    case 'overview': return overview(req, res, supabase);
    case 'credit-ledger': return creditLedger(req, res, supabase);
    case 'grant-credit': return grantCredit(req, res, supabase);
    case 'rates': return rates(req, res, supabase);
    default: return res.status(400).json({ error: 'Unknown or missing action' });
  }
}

async function listUsers(req, res, supabase) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
  const { data: authUsers, error: listErr } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (listErr) return res.status(500).json({ error: listErr.message });

  // This Supabase project may be shared with other apps — only list users
  // who have actually signed into this app (they get a `profiles` row on
  // first sign-in), so users from another app on the same project don't
  // show up here.
  const { data: profileRows, error: profileErr } = await supabase.from('profiles').select('user_id');
  if (profileErr) return res.status(500).json({ error: profileErr.message });
  const appUserIds = new Set((profileRows || []).map((p) => p.user_id));

  const { data: approvals } = await supabase.from('user_approvals').select('user_id, approved');
  const { data: usage } = await supabase.from('user_usage').select('user_id, call_minutes_used, monthly_minute_limit, bonus_minutes');

  const approvalMap = new Map((approvals || []).map((a) => [a.user_id, a.approved]));
  const usageMap = new Map((usage || []).map((u) => [u.user_id, u]));

  const users = authUsers.users
    .filter((u) => appUserIds.has(u.id))
    .map((u) => ({
      id: u.id,
      email: u.email,
      created_at: u.created_at,
      approved: !!approvalMap.get(u.id),
      minutes_used: usageMap.get(u.id)?.call_minutes_used ?? 0,
      minutes_limit: usageMap.get(u.id)?.monthly_minute_limit ?? 60,
      bonus_minutes: Number(usageMap.get(u.id)?.bonus_minutes ?? 0),
    }));

  return res.status(200).json({ users });
}

async function setApproval(req, res, supabase) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const { targetUserId, approved, monthlyMinuteLimit } = req.body || {};
  if (!targetUserId) return res.status(400).json({ error: 'targetUserId required' });

  if (typeof approved === 'boolean') {
    const { error } = await supabase.from('user_approvals').upsert({ user_id: targetUserId, approved });
    if (error) return res.status(500).json({ error: error.message });
  }
  if (typeof monthlyMinuteLimit === 'number') {
    const { error } = await supabase
      .from('user_usage')
      .upsert({ user_id: targetUserId, monthly_minute_limit: monthlyMinuteLimit, updated_at: new Date().toISOString() });
    if (error) return res.status(500).json({ error: error.message });
  }
  return res.status(200).json({ ok: true });
}

// Vercel serverless functions hard-cap request bodies at 4.5MB (platform
// limit — not configurable), so a video can never be sent here as a base64
// JSON body the way small background images used to be. Instead: hand the
// admin panel a short-lived signed upload URL and let the browser PUT the
// file straight to Supabase Storage, bypassing this function's body limit
// entirely. confirmBackground() below then just records the small resulting
// URL once that direct upload has finished.
async function createBackgroundUpload(req, res, supabase) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const { mimeType, mediaType } = req.body || {};
  if (!mimeType) return res.status(400).json({ error: 'mimeType required' });
  const ext = (mimeType.split('/')[1] || 'bin').split(';')[0];
  const folder = mediaType === 'video' ? 'auth-backgrounds/video' : 'auth-backgrounds/image';
  const path = `${folder}/${randomUUID()}.${ext}`;

  const { data, error } = await supabase.storage.from('app-assets').createSignedUploadUrl(path);
  if (error) return res.status(500).json({ error: error.message });

  return res.status(200).json({ path: data.path, token: data.token });
}

async function confirmBackground(req, res, supabase) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const { path, mediaType } = req.body || {};
  if (!path) return res.status(400).json({ error: 'path required' });

  const { data: pub } = supabase.storage.from('app-assets').getPublicUrl(path);
  const { data: row, error } = await supabase
    .from('auth_backgrounds')
    .insert({ url: pub.publicUrl, storage_path: path, media_type: mediaType === 'video' ? 'video' : 'image' })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });

  return res.status(200).json({ ok: true, row });
}

async function deleteBackground(req, res, supabase) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const { id } = req.body || {};
  if (!id) return res.status(400).json({ error: 'id required' });
  const { data: row, error: fetchErr } = await supabase.from('auth_backgrounds').select('storage_path').eq('id', id).maybeSingle();
  if (fetchErr) return res.status(500).json({ error: fetchErr.message });
  if (!row) return res.status(404).json({ error: 'Not found' });
  await supabase.storage.from('app-assets').remove([row.storage_path]);
  const { error: delErr } = await supabase.from('auth_backgrounds').delete().eq('id', id);
  if (delErr) return res.status(500).json({ error: delErr.message });
  return res.status(200).json({ ok: true });
}

// Home hero GIF. Same direct-to-storage upload as the backgrounds above (the
// 4.5MB body cap would block a GIF). There is only ever one hero: confirming a
// new one replaces the old row and its stored file.
async function createHeroUpload(req, res, supabase) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const { mimeType } = req.body || {};
  if (mimeType !== 'image/gif') return res.status(400).json({ error: 'The hero must be a GIF' });
  const path = `home-hero/${randomUUID()}.gif`;
  const { data, error } = await supabase.storage.from('app-assets').createSignedUploadUrl(path);
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ path: data.path, token: data.token });
}

async function confirmHero(req, res, supabase) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const { path } = req.body || {};
  if (!path || !path.startsWith('home-hero/')) return res.status(400).json({ error: 'path required' });
  const { data: old } = await supabase.from('home_hero').select('id,storage_path');
  const { data: pub } = supabase.storage.from('app-assets').getPublicUrl(path);
  const { data: row, error } = await supabase.from('home_hero').insert({ url: pub.publicUrl, storage_path: path }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  if (old?.length) {
    await supabase.storage.from('app-assets').remove(old.map((r) => r.storage_path));
    await supabase.from('home_hero').delete().in('id', old.map((r) => r.id));
  }
  return res.status(200).json({ ok: true, row });
}

async function deleteHero(req, res, supabase) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const { data: rows, error } = await supabase.from('home_hero').select('id,storage_path');
  if (error) return res.status(500).json({ error: error.message });
  if (rows?.length) {
    await supabase.storage.from('app-assets').remove(rows.map((r) => r.storage_path));
    await supabase.from('home_hero').delete().in('id', rows.map((r) => r.id));
  }
  return res.status(200).json({ ok: true });
}

async function analytics(req, res, supabase) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
  const { data: authUsers, error: listErr } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (listErr) return res.status(500).json({ error: listErr.message });
  const emailById = new Map(authUsers.users.map((u) => [u.id, u.email]));

  const days = Number(req.query.days);
  let q = supabase.from('calls').select('user_id, duration_seconds, created_at');
  if ([7, 30, 90].includes(days)) q = q.gte('created_at', new Date(Date.now() - days * 864e5).toISOString());
  const { data: calls, error: callsErr } = await q;
  if (callsErr) return res.status(500).json({ error: callsErr.message });

  const byUser = new Map();
  for (const c of calls || []) {
    const row = byUser.get(c.user_id) || { calls: 0, seconds: 0, lastActive: null };
    row.calls += 1;
    row.seconds += c.duration_seconds || 0;
    if (!row.lastActive || c.created_at > row.lastActive) row.lastActive = c.created_at;
    byUser.set(c.user_id, row);
  }

  const users = Array.from(byUser.entries())
    .map(([userId, row]) => ({
      email: emailById.get(userId) || userId,
      calls: row.calls,
      minutes: Math.round(row.seconds / 60),
      lastActive: row.lastActive,
    }))
    .sort((a, b) => b.minutes - a.minutes);

  return res.status(200).json({ users });
}

async function sendAnnouncement(req, res, supabase) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const vapidPublic = process.env.VAPID_PUBLIC_KEY;
  const vapidPrivate = process.env.VAPID_PRIVATE_KEY;
  const vapidSubject = process.env.VAPID_SUBJECT;
  if (!vapidPublic || !vapidPrivate || !vapidSubject) {
    return res.status(500).json({ error: 'Server not configured (missing VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT)' });
  }

  const { title, body } = req.body || {};
  if (!title || !body) return res.status(400).json({ error: 'title and body are required' });

  await supabase.from('announcements').insert({ title, body });
  webpush.setVapidDetails(vapidSubject, vapidPublic, vapidPrivate);

  const { data: subs, error: subsErr } = await supabase.from('push_subscriptions').select('*');
  if (subsErr) return res.status(500).json({ error: subsErr.message });

  const payload = JSON.stringify({ title, body });
  let sent = 0;
  let failed = 0;

  await Promise.all(
    (subs || []).map(async (sub) => {
      try {
        await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload);
        sent++;
      } catch (err) {
        failed++;
        if (err.statusCode === 410 || err.statusCode === 404) {
          await supabase.from('push_subscriptions').delete().eq('id', sub.id);
        }
      }
    })
  );

  return res.status(200).json({ sent, failed, total: (subs || []).length });
}

// ---------- revenue, credits, provider cost rates ----------
async function fetchAll(build) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build().range(from, from + 999);
    if (error) throw error;
    out.push(...data);
    if (data.length < 1000) return out;
  }
}

async function getRates(supabase) {
  const { data } = await supabase.from('admin_settings').select('value').eq('key', 'provider_rates').maybeSingle();
  const v = data?.value || {};
  return { twilio: Number(v.twilio) || 0, fish: Number(v.fish) || 0, openai: Number(v.openai) || 0 };
}

async function overview(req, res, supabase) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
  const days = [7, 30, 90].includes(Number(req.query.days)) ? Number(req.query.days) : 30;
  const since = new Date(Date.now() - days * 864e5).toISOString();
  try {
    const paidAll = await fetchAll(() => supabase.from('minute_purchases').select('user_id, amount, minutes, currency, paid_at').eq('status', 'paid').order('paid_at', { ascending: false }));
    const currency = paidAll[0]?.currency || 'USD'; // one currency at a time; others are left out of the totals
    const paid = paidAll.filter((p) => p.currency === currency);
    const sold = paid.filter((p) => p.paid_at >= since);
    const calls = await fetchAll(() => supabase.from('calls').select('user_id, duration_seconds, created_at').gte('created_at', since).order('created_at'));
    const { count: totalUsers } = await supabase.from('profiles').select('user_id', { count: 'exact', head: true });
    const rates = await getRates(supabase);

    const series = new Map();
    for (let i = days - 1; i >= 0; i--) series.set(new Date(Date.now() - i * 864e5).toISOString().slice(0, 10), { revenue: 0, minutes: 0 });
    for (const p of sold) { const d = series.get(String(p.paid_at).slice(0, 10)); if (d) d.revenue += Number(p.amount); }
    let minutesUsed = 0;
    for (const c of calls) {
      const m = Math.ceil((c.duration_seconds || 0) / 60); // same rounding the billing code uses
      minutesUsed += m;
      const d = series.get(String(c.created_at).slice(0, 10)); if (d) d.minutes += m;
    }
    const ratePerMin = rates.twilio + rates.fish + rates.openai;
    const revenue = sold.reduce((a, p) => a + Number(p.amount), 0);
    return res.status(200).json({
      days, currency, revenue, allTimeRevenue: paid.reduce((a, p) => a + Number(p.amount), 0),
      purchases: sold.length, minutesSold: sold.reduce((a, p) => a + Number(p.minutes), 0),
      payingUsers: new Set(sold.map((p) => p.user_id)).size,
      activeUsers: new Set(calls.map((c) => c.user_id)).size, totalUsers: totalUsers || 0,
      calls: calls.length, minutesUsed, ratePerMin, cost: minutesUsed * ratePerMin,
      series: [...series].map(([d, v]) => ({ d, ...v })),
    });
  } catch (err) { return res.status(500).json({ error: err.message }); }
}

async function creditLedger(req, res, supabase) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
  const bought = await supabase.from('minute_purchases').select('user_id, minutes, amount, currency, paid_at').eq('status', 'paid').order('paid_at', { ascending: false }).limit(60);
  const granted = await supabase.from('credit_ledger').select('user_id, minutes, note, created_at').order('created_at', { ascending: false }).limit(60);
  if (bought.error || granted.error) return res.status(500).json({ error: (bought.error || granted.error).message });
  const entries = [
    ...bought.data.map((p) => ({ user_id: p.user_id, minutes: Number(p.minutes), source: 'purchase', note: `${p.amount} ${p.currency}`, at: p.paid_at })),
    ...granted.data.map((g) => ({ user_id: g.user_id, minutes: Number(g.minutes), source: 'admin', note: g.note, at: g.created_at })),
  ].sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, 80);
  return res.status(200).json({ entries });
}

async function grantCredit(req, res, supabase) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const { targetUserId, minutes, note } = req.body || {};
  const m = Number(minutes);
  if (!targetUserId) return res.status(400).json({ error: 'targetUserId required' });
  if (!Number.isFinite(m) || m === 0 || Math.abs(m) > 100000) return res.status(400).json({ error: 'minutes must be a non-zero number up to 100000' });
  const { data, error } = await supabase.rpc('admin_grant_minutes', { p_user: targetUserId, p_minutes: m, p_note: String(note || '').slice(0, 200) });
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ ok: true, bonus_minutes: Number(data) });
}

async function rates(req, res, supabase) {
  if (req.method === 'POST') {
    const clean = {};
    for (const k of ['twilio', 'fish', 'openai']) {
      const n = Number(req.body?.[k] ?? 0);
      if (!Number.isFinite(n) || n < 0 || n > 1000) return res.status(400).json({ error: `Invalid ${k} rate` });
      clean[k] = n;
    }
    const { error } = await supabase.from('admin_settings').upsert({ key: 'provider_rates', value: clean, updated_at: new Date().toISOString() });
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true, rates: clean });
  }
  const paid = await fetchAll(() => supabase.from('minute_purchases').select('amount, minutes, currency, paid_at').eq('status', 'paid').order('paid_at', { ascending: false }));
  const cur = paid[0]?.currency || 'USD';
  const rows = paid.filter((p) => p.currency === cur);
  const mins = rows.reduce((a, p) => a + Number(p.minutes), 0);
  const amt = rows.reduce((a, p) => a + Number(p.amount), 0);
  return res.status(200).json({ rates: await getRates(supabase), currency: cur, pricePerMin: mins ? amt / mins : 0 });
}

// The client and server share the same fixed slot vocabulary. Multiple items
// are allowed only in the galleries. All other slots replace their old asset.
const LANDING_SLOTS = new Set([
  'hero_background', 'hero_overlay', 'objective_background', 'objective_overlay',
  'conversation_background', 'conversation_overlay', 'call_screenshots',
  'voice_orb', 'feature_media', 'demo_video', 'live_call_video',
]);
const LANDING_GALLERIES = new Set(['call_screenshots', 'feature_media']);
const LANDING_TYPES = { 'image/gif': 'gif', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'video/mp4': 'mp4', 'video/webm': 'webm' };
function validLandingType(slot, type) {
  return LANDING_SLOTS.has(slot) && !!LANDING_TYPES[type] &&
    (slot === 'voice_orb' ? type === 'image/gif' :
      (slot === 'demo_video' || slot === 'live_call_video') ? type.startsWith('video/') : !type.startsWith('video/'));
}
async function listLandingMedia(req, res, supabase) {
  const { data, error } = await supabase.from('landing_media')
    .select('id,slot,url,media_type,sort_order').order('sort_order').order('created_at');
  if (error) return res.status(500).json({ error: 'Landing media unavailable. Apply sql/032_landing_media.sql.' });
  const media = data || [];
  // Reuse the existing Home GIF until the admin sets a dedicated landing hero.
  if (!media.some((row) => row.slot === 'hero_background')) {
    const { data: home } = await supabase.from('home_hero').select('url').order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (home?.url) media.unshift({ slot: 'hero_background', url: home.url, media_type: 'image/gif', sort_order: 0 });
  }
  res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
  return res.status(200).json({ media });
}
async function createLandingUpload(req, res, supabase) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const { slot, mimeType, size } = req.body || {};
  const max = mimeType?.startsWith('video/') ? 50 * 1024 * 1024 : 20 * 1024 * 1024;
  if (!validLandingType(slot, mimeType) || !Number.isSafeInteger(size) || size < 1 || size > max)
    return res.status(400).json({ error: `Invalid slot, type or size (images ≤20 MB; video ≤50 MB).` });
  const path = `landing/${slot}/${randomUUID()}.${LANDING_TYPES[mimeType]}`;
  const { data, error } = await supabase.storage.from('app-assets').createSignedUploadUrl(path);
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ path: data.path, token: data.token });
}
async function confirmLandingUpload(req, res, supabase) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const { slot, mimeType, path } = req.body || {};
  if (!validLandingType(slot, mimeType) || typeof path !== 'string' ||
      !new RegExp(`^landing/${slot}/[0-9a-f-]{36}\.${LANDING_TYPES[mimeType]}$`).test(path))
    return res.status(400).json({ error: 'Invalid asset path' });
  // Confirm that a file was actually uploaded, not merely a URL supplied by a caller.
  const { data: files, error: listError } = await supabase.storage.from('app-assets')
    .list(`landing/${slot}`, { search: path.split('/').pop() });
  const file = files?.find((f) => f.name === path.split('/').pop());
  if (listError || !file) return res.status(400).json({ error: 'Upload not found in storage' });
  const meta = file.metadata || {};
  const max = mimeType.startsWith('video/') ? 50 * 1024 * 1024 : 20 * 1024 * 1024;
  if (Number(meta.size) > max || (meta.mimetype && meta.mimetype !== mimeType))
    return res.status(400).json({ error: 'Uploaded file type or size does not match the request' });
  const { data: old, error: oldError } = await supabase.from('landing_media').select('id,storage_path,sort_order').eq('slot', slot).order('sort_order');
  if (oldError) return res.status(500).json({ error: oldError.message });
  if (old?.some((r) => r.storage_path === path)) return res.status(409).json({ error: 'Already saved' });
  const { data: pub } = supabase.storage.from('app-assets').getPublicUrl(path);
  const { data: row, error } = await supabase.from('landing_media').insert({
    slot, storage_path: path, url: pub.publicUrl, media_type: mimeType,
    sort_order: LANDING_GALLERIES.has(slot) ? Math.max(-1, ...(old || []).map((r) => r.sort_order)) + 1 : 0,
  }).select('id,slot,url,media_type,sort_order').single();
  if (error) return res.status(500).json({ error: error.message });
  if (!LANDING_GALLERIES.has(slot) && old?.length) {
    const { error: delError } = await supabase.from('landing_media').delete().in('id', old.map((r) => r.id));
    if (!delError) await supabase.storage.from('app-assets').remove(old.map((r) => r.storage_path));
  }
  return res.status(200).json({ row });
}
async function deleteLandingMedia(req, res, supabase) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const { id } = req.body || {};
  if (typeof id !== 'string') return res.status(400).json({ error: 'ID required' });
  const { data: row, error: fetchError } = await supabase.from('landing_media').select('storage_path').eq('id', id).maybeSingle();
  if (fetchError) return res.status(500).json({ error: fetchError.message });
  if (!row) return res.status(404).json({ error: 'Not found' });
  const { error } = await supabase.from('landing_media').delete().eq('id', id);
  if (error) return res.status(500).json({ error: error.message });
  await supabase.storage.from('app-assets').remove([row.storage_path]);
  return res.status(200).json({ ok: true });
}
async function reorderLandingMedia(req, res, supabase) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const { slot, ids } = req.body || {};
  if (!LANDING_GALLERIES.has(slot) || !Array.isArray(ids) || ids.length > 100 ||
      ids.some((id) => typeof id !== 'string') || new Set(ids).size !== ids.length)
    return res.status(400).json({ error: 'Invalid order' });
  const { data: rows, error } = await supabase.from('landing_media').select('id').eq('slot', slot);
  if (error) return res.status(500).json({ error: error.message });
  if (rows.length !== ids.length || rows.some((r) => !ids.includes(r.id)))
    return res.status(400).json({ error: 'Order must contain every item in the slot' });
  for (let i = 0; i < ids.length; i++) {
    const { error: updateError } = await supabase.from('landing_media').update({ sort_order: i }).eq('id', ids[i]).eq('slot', slot);
    if (updateError) return res.status(500).json({ error: updateError.message });
  }
  return res.status(200).json({ ok: true });
}
