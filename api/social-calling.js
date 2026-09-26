import { getServiceClient, getAuthedUserId } from '../lib/supabaseAdmin.js';
import { relayRequest } from '../lib/socialRelayClient.js';
import { wacallsCreateSession, wacallsDetail, wacallsPairWithCode, wacallsDelete, wacallsStartCall } from '../lib/wacallsClient.js';
import { mpRelayRequest } from '../lib/mpRelayClient.js';

// Telegram + WhatsApp account linking and calling, combined into one file
// behind ?action=... — same reason as api/admin.js and api/call-answering.js:
// Vercel's Hobby plan caps a deployment at 12 serverless functions, and this
// app was already at that cap before this feature. Splitting Telegram and
// WhatsApp into separate files would push it over.
//
// Telegram: login (phone/OTP/2FA) now goes through mp-relay
// (github.com/multipurps/mp-relay), a MadelineProto-based service, separate
// Render deployment - not the old relay. The old relay's telegramCall sent
// a real RequestCall but with a placeholder/random g_a_hash instead of an
// actual Diffie-Hellman exchange (see that file's own comments); it could
// never have produced a working call. This file still forwards Telegram
// *call-placing* to that old relay for now (line ~181) - fixing login
// first, call-placing is deliberately its own separate next step, not
// bundled into this pass.
//
// WhatsApp: moved off that same old relay (it used Baileys, which never
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
  await mpRelayRequest(`/sessions/${userId}/start`, { method: 'POST', body: { phone: phone.trim() } });
  return res.status(200).json({ status: 'pending_otp' });
}

async function telegramVerify(req, res, userId) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const { code, password } = req.body || {};
  // The frontend calls this endpoint twice in the 2FA case: first with just
  // the code, then again with just the password once it shows that field.
  // mp-relay itself has two separate endpoints for this (verify, then 2fa)
  // since they're genuinely different MadelineProto calls - this bridges
  // that back to the single-endpoint shape the frontend already expects.
  if (password && password.trim()) {
    await mpRelayRequest(`/sessions/${userId}/2fa`, { method: 'POST', body: { password: password.trim() } });
    return res.status(200).json({ status: 'connected' });
  }
  if (!code || !code.trim()) return res.status(400).json({ error: 'code required' });
  const data = await mpRelayRequest(`/sessions/${userId}/verify`, { method: 'POST', body: { code: code.trim() } });
  return res.status(200).json({ status: data.status === 'need_2fa' ? 'needs_password' : 'connected' });
}

async function telegramDisconnect(req, res, userId) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  await mpRelayRequest(`/sessions/${userId}`, { method: 'DELETE' });
  return res.status(200).json({ status: 'disconnected' });
}

// Every function below persists the WaCalls session id it's working with to
// whatsapp_accounts.wacalls_session_id as its first move - WaCalls itself
// has no idea which of our users a session belongs to, so that mapping has
// to live on our side, and it has to survive a serverless function ending
// between one request and the next (session creation and pairing are
// necessarily two separate requests).
//
// That stored id can go stale - it did for every existing user the moment
// WaCalls' session storage moved off local disk onto Postgres, since the
// old disk-backed sessions weren't (couldn't be) carried over. Blindly
// trusting the stored id and forwarding it to WaCalls is exactly what
// produced "no such session": WaCalls 404s, and this file used to let that
// 404 bubble straight to the frontend instead of noticing the id is dead
// and minting a new one. Only a confirmed 404 counts as "dead" - a
// timeout, a 5xx, or the relay being unreachable must NOT clear a
// perfectly good mapping just because of a blip.
async function getOrCreateWacallsSession(supabase, userId, phone) {
  const { data: row } = await supabase.from('whatsapp_accounts').select('wacalls_session_id').eq('user_id', userId).maybeSingle();
  if (row?.wacalls_session_id) {
    try {
      await wacallsDetail(userId, row.wacalls_session_id);
      return row.wacalls_session_id;
    } catch (err) {
      if (err.statusCode !== 404) throw err;
      // fall through and mint a fresh session below
    }
  }
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
  if (sessionId) {
    try {
      await wacallsDetail(userId, sessionId);
    } catch (err) {
      if (err.statusCode !== 404) throw err;
      sessionId = null; // stale - relay has no memory of this id, mint a fresh one below
    }
  }
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
  let detail;
  try {
    detail = await wacallsDetail(userId, row.wacalls_session_id);
  } catch (err) {
    if (err.statusCode !== 404) throw err;
    // Dead id (e.g. relay storage was reset) - clear it so the next
    // "Connect" click mints a fresh session instead of repeating this.
    await supabase.from('whatsapp_accounts').update({ wacalls_session_id: null, status: 'disconnected', display_name: null }).eq('user_id', userId);
    return res.status(200).json({ status: 'disconnected' });
  }
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
    try {
      const data = await wacallsStartCall(userId, row.wacalls_session_id, to.trim());
      return res.status(200).json(data); // { callId, status } - matches the shape the Telegram path already returns
    } catch (err) {
      if (err.statusCode === 404) {
        // Stored id is dead (e.g. relay storage was reset since pairing) -
        // clear it so the account shows "disconnected" instead of silently
        // failing every call, and say so plainly rather than surfacing the
        // relay's internal "no such session" wording.
        await supabase.from('whatsapp_accounts').update({ wacalls_session_id: null, status: 'disconnected', display_name: null }).eq('user_id', userId);
        const staleErr = new Error('WhatsApp session expired - please reconnect WhatsApp and try again');
        staleErr.statusCode = 409;
        throw staleErr;
      }
      throw err;
    }
  }
  // Telegram call-placing still goes through the OLD relay here - it's the
  // one with the placeholder/random g_a_hash instead of a real DH exchange
  // (see this file's top comment and server-social/social-relay.js's own
  // comments on telegramCall). Login was fixed first (mp-relay); this is
  // deliberately still broken until that's done as its own next step.
  const data = await relayRequest(`/${platform}/call`, { userId, method: 'POST', body: { to: to.trim() } });
  return res.status(200).json(data); // { callId, status }
}
