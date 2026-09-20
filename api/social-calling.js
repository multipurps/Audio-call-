import { getServiceClient, getAuthedUserId } from '../lib/supabaseAdmin.js';
import { relayRequest } from '../lib/socialRelayClient.js';
import { wacallsCreateSession, wacallsDetail, wacallsPairWithCode, wacallsDelete, wacallsStartCall } from '../lib/wacallsClient.js';

// Telegram + WhatsApp account linking and calling, combined into one file
// behind ?action=... — same reason as api/admin.js and api/call-answering.js:
// Vercel's Hobby plan caps a deployment at 12 serverless functions, and this
// app was already at that cap before this feature. Splitting Telegram and
// WhatsApp into separate files would push it over.
//
// Telegram: this file never touches a session string — it forwards login
// steps (phone, OTP, 2FA password) to the relay (server-social/social-relay.js
// on Render), which is the only thing holding the encryption key for
// telegram_accounts.session_encrypted.
//
// WhatsApp: moved off that same relay (it used Baileys, which never
// reliably paired) onto WaCalls (github.com/multipurps/WaCalls, a
// whatsmeow-based Go service, separate Render deployment). WaCalls has no
// concept of "which of our users is this" - only session ids - so this
// file owns that mapping via whatsapp_accounts.wacalls_session_id.
// auth_state_encrypted is the old Baileys column and is no longer written.
export default async function handler(req, res) {
  const supabase = getServiceClient();
  const userId = await getAuthedUserId(req, supabase);
  if (!userId) return res.status(401).json({ error: 'Not signed in' });

  const action = req.query?.action || req.body?.action;

  try {
    switch (action) {
      case 'telegram-start': return await telegramStart(req, res, userId);
      case 'telegram-verify': return await telegramVerify(req, res, userId);
      case 'telegram-disconnect': return await telegramDisconnect(req, res, userId);
      case 'whatsapp-start': return await whatsappStart(req, res, supabase, userId);
      case 'whatsapp-start-phone': return await whatsappStartWithPhone(req, res, supabase, userId);
      case 'whatsapp-status': return await whatsappStatus(req, res, supabase, userId);
      case 'whatsapp-disconnect': return await whatsappDisconnect(req, res, supabase, userId);
      case 'call': return await placeCall(req, res, supabase, userId);
      default: return await status(req, res, supabase, userId);
    }
  } catch (err) {
    // Both relayRequest() (Telegram) and the wacalls* client (WhatsApp)
    // throw with statusCode set for anything the relay itself reported.
    return res.status(err.statusCode || 500).json({ error: err.message || 'Social calling request failed' });
  }
}

// Status is read straight from Supabase (fast, no relay round trip) — the
// relay is the source of truth for *connecting*, but once connected, the
// row it wrote is enough to render "Connected as X".
async function status(req, res, supabase, userId) {
  const [{ data: tg }, { data: wa }] = await Promise.all([
    supabase.from('telegram_accounts').select('status, display_name, phone_last4, last_error').eq('user_id', userId).maybeSingle(),
    supabase.from('whatsapp_accounts').select('status, display_name, last_error').eq('user_id', userId).maybeSingle(),
  ]);
  return res.status(200).json({
    telegram: {
      status: tg?.status || 'disconnected',
      displayName: tg?.display_name || null,
      phoneLast4: tg?.phone_last4 || null,
      error: tg?.last_error || null,
    },
    whatsapp: {
      status: wa?.status || 'disconnected',
      displayName: wa?.display_name || null,
      error: wa?.last_error || null,
    },
  });
}

async function telegramStart(req, res, userId) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const { phone } = req.body || {};
  if (!phone || !phone.trim()) return res.status(400).json({ error: 'phone required (with country code, e.g. +234...)' });
  const data = await relayRequest('/telegram/start', { userId, method: 'POST', body: { phone: phone.trim() } });
  return res.status(200).json(data); // { status: 'pending_otp' }
}

async function telegramVerify(req, res, userId) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const { code, password } = req.body || {};
  if (!code || !code.trim()) return res.status(400).json({ error: 'code required' });
  // password: only needed if the account has 2FA (cloud password) enabled —
  // Telegram's login flow asks for it as a second step; the relay surfaces
  // that as its own status rather than us guessing when to ask for it.
  const data = await relayRequest('/telegram/verify', { userId, method: 'POST', body: { code: code.trim(), password } });
  return res.status(200).json(data); // { status: 'connected' | 'needs_password', displayName }
}

async function telegramDisconnect(req, res, userId) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const data = await relayRequest('/telegram/disconnect', { userId, method: 'POST' });
  return res.status(200).json(data);
}

// Every function below persists the WaCalls session id it's working with to
// whatsapp_accounts.wacalls_session_id as its first move - WaCalls itself
// has no idea which of our users a session belongs to, so that mapping has
// to live on our side, and it has to survive a serverless function ending
// between one request and the next (session creation and pairing are
// necessarily two separate requests).
async function getOrCreateWacallsSession(supabase, userId, phone) {
  const { data: row } = await supabase.from('whatsapp_accounts').select('wacalls_session_id').eq('user_id', userId).maybeSingle();
  if (row?.wacalls_session_id) return row.wacalls_session_id;
  const created = await wacallsCreateSession(userId, `user-${userId}`, phone);
  await supabase.from('whatsapp_accounts').upsert(
    { user_id: userId, wacalls_session_id: created.id, status: 'pending_qr' },
    { onConflict: 'user_id' },
  );
  return created.id;
}

async function whatsappStart(req, res, supabase, userId) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const sessionId = await getOrCreateWacallsSession(supabase, userId, null);
  const detail = await wacallsDetail(userId, sessionId);
  return res.status(200).json({ qr: detail.qr || null, status: detail.paired ? 'connected' : 'pending_qr' });
}

async function whatsappStartWithPhone(req, res, supabase, userId) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const phone = (req.body?.phone || '').trim();
  if (!phone) return res.status(400).json({ error: 'phone required (with country code, e.g. +234...)' });
  const { data: row } = await supabase.from('whatsapp_accounts').select('wacalls_session_id').eq('user_id', userId).maybeSingle();
  let sessionId = row?.wacalls_session_id;
  let detail;
  if (!sessionId) {
    const created = await wacallsCreateSession(userId, `user-${userId}`, phone);
    sessionId = created.id;
    await supabase.from('whatsapp_accounts').upsert({ user_id: userId, wacalls_session_id: sessionId, status: 'pending_qr' }, { onConflict: 'user_id' });
    detail = await wacallsDetail(userId, sessionId);
  } else {
    await wacallsPairWithCode(userId, sessionId, phone);
    detail = await wacallsDetail(userId, sessionId);
  }
  return res.status(200).json({ status: detail.paired ? 'connected' : 'pending_code', pairingCode: detail.code || null });
}

async function whatsappStatus(req, res, supabase, userId) {
  const { data: row } = await supabase.from('whatsapp_accounts').select('wacalls_session_id, display_name').eq('user_id', userId).maybeSingle();
  if (!row?.wacalls_session_id) return res.status(200).json({ status: 'disconnected' });
  const detail = await wacallsDetail(userId, row.wacalls_session_id);
  const status = detail.paired ? 'connected' : detail.state === 'code' ? 'pending_code' : detail.state === 'qr' ? 'pending_qr' : 'disconnected';
  if (detail.paired && detail.jid && detail.jid !== row.display_name) {
    await supabase.from('whatsapp_accounts').update({ status: 'connected', display_name: detail.jid }).eq('user_id', userId);
  }
  return res.status(200).json({ status, qr: detail.qr || null, pairingCode: detail.code || null, displayName: detail.jid || row.display_name || null });
}

async function whatsappDisconnect(req, res, supabase, userId) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const { data: row } = await supabase.from('whatsapp_accounts').select('wacalls_session_id').eq('user_id', userId).maybeSingle();
  if (row?.wacalls_session_id) {
    await wacallsDelete(userId, row.wacalls_session_id).catch(() => {}); // already gone on the relay side is fine, still clear our row
  }
  await supabase.from('whatsapp_accounts').update({ wacalls_session_id: null, status: 'disconnected', display_name: null }).eq('user_id', userId);
  return res.status(200).json({ status: 'disconnected' });
}

async function placeCall(req, res, supabase, userId) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const { platform, to } = req.body || {};
  if (platform !== 'telegram' && platform !== 'whatsapp') return res.status(400).json({ error: "platform must be 'telegram' or 'whatsapp'" });
  if (!to || !to.trim()) return res.status(400).json({ error: 'to required' });
  if (platform === 'whatsapp') {
    const { data: row } = await supabase.from('whatsapp_accounts').select('wacalls_session_id').eq('user_id', userId).maybeSingle();
    if (!row?.wacalls_session_id) {
      const err = new Error('WhatsApp not connected for this user');
      err.statusCode = 400;
      throw err;
    }
    const data = await wacallsStartCall(userId, row.wacalls_session_id, to.trim());
    return res.status(200).json(data); // { callId, status } - matches the shape the Telegram path already returns
  }
  const data = await relayRequest(`/${platform}/call`, { userId, method: 'POST', body: { to: to.trim() } });
  return res.status(200).json(data); // { callId, status }
}
