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
  const admin = await requireAdmin(req, supabase);
  if (!admin) return res.status(403).json({ error: 'Not authorized' });

  const action = req.query?.action || req.body?.action;

  switch (action) {
    case 'list-users': return listUsers(req, res, supabase);
    case 'set-approval': return setApproval(req, res, supabase);
    case 'upload-background': return uploadBackground(req, res, supabase);
    case 'delete-background': return deleteBackground(req, res, supabase);
    case 'analytics': return analytics(req, res, supabase);
    case 'send-announcement': return sendAnnouncement(req, res, supabase);
    default: return res.status(400).json({ error: 'Unknown or missing action' });
  }
}

async function listUsers(req, res, supabase) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
  const { data: authUsers, error: listErr } = await supabase.auth.admin.listUsers();
  if (listErr) return res.status(500).json({ error: listErr.message });

  // This Supabase project may be shared with other apps — only list users
  // who have actually signed into this app (they get a `profiles` row on
  // first sign-in), so users from another app on the same project don't
  // show up here.
  const { data: profileRows, error: profileErr } = await supabase.from('profiles').select('user_id');
  if (profileErr) return res.status(500).json({ error: profileErr.message });
  const appUserIds = new Set((profileRows || []).map((p) => p.user_id));

  const { data: approvals } = await supabase.from('user_approvals').select('user_id, approved');
  const { data: usage } = await supabase.from('user_usage').select('user_id, call_minutes_used, monthly_minute_limit');

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

async function uploadBackground(req, res, supabase) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const { imageBase64, mimeType } = req.body || {};
  if (!imageBase64) return res.status(400).json({ error: 'imageBase64 required' });
  const ext = (mimeType || 'image/jpeg').split('/')[1] || 'jpg';
  const path = `auth-backgrounds/${randomUUID()}.${ext}`;
  const bytes = Buffer.from(imageBase64, 'base64');
  if (bytes.length > 8 * 1024 * 1024) return res.status(400).json({ error: 'Image too large (max 8MB)' });

  const { error: uploadErr } = await supabase.storage
    .from('app-assets')
    .upload(path, bytes, { contentType: mimeType || 'image/jpeg', upsert: false });
  if (uploadErr) return res.status(500).json({ error: uploadErr.message });

  const { data: pub } = supabase.storage.from('app-assets').getPublicUrl(path);
  const { data: row, error: insertErr } = await supabase
    .from('auth_backgrounds')
    .insert({ url: pub.publicUrl, storage_path: path })
    .select()
    .single();
  if (insertErr) return res.status(500).json({ error: insertErr.message });

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

async function analytics(req, res, supabase) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
  const { data: authUsers, error: listErr } = await supabase.auth.admin.listUsers();
  if (listErr) return res.status(500).json({ error: listErr.message });
  const emailById = new Map(authUsers.users.map((u) => [u.id, u.email]));

  const { data: calls, error: callsErr } = await supabase.from('calls').select('user_id, duration_seconds, created_at');
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
