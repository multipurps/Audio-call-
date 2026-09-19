import { getServiceClient, getAuthedUserId } from '../lib/supabaseAdmin.js';
import { relayRequest } from '../lib/socialRelayClient.js';

// Telegram + WhatsApp account linking and calling, combined into one file
// behind ?action=... — same reason as api/admin.js and api/call-answering.js:
// Vercel's Hobby plan caps a deployment at 12 serverless functions, and this
// app was already at that cap before this feature. Splitting Telegram and
// WhatsApp into separate files would push it over.
//
// This file never touches a session string or auth-state blob — it only
// asks the relay for connection status and forwards login-flow steps
// (phone number, OTP code, QR poll) to it. The relay is the only thing that
// holds the encryption key for telegram_accounts.session_encrypted /
// whatsapp_accounts.auth_state_encrypted.
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
      case 'whatsapp-start': return await whatsappStart(req, res, userId);
      case 'whatsapp-start-phone': return await whatsappStartWithPhone(req, res, userId);
      case 'whatsapp-status': return await whatsappStatus(req, res, userId);
      case 'whatsapp-disconnect': return await whatsappDisconnect(req, res, userId);
      case 'call': return await placeCall(req, res, userId);
      default: return await status(req, res, supabase, userId);
    }
  } catch (err) {
    // relayRequest() throws with statusCode set for anything the relay
    // itself reported (bad phone number, wrong OTP, no relay configured).
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

async function whatsappStart(req, res, userId) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const data = await relayRequest('/whatsapp/start', { userId, method: 'POST' });
  return res.status(200).json(data); // { qr: '<data-url>' }
}

async function whatsappStartWithPhone(req, res, userId) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const data = await relayRequest('/whatsapp/start-with-phone', { userId, method: 'POST', body: { phone: req.body?.phone } });
  return res.status(200).json(data); // { status, pairingCode }
}

async function whatsappStatus(req, res, userId) {
  const data = await relayRequest('/whatsapp/status', { userId, method: 'GET' });
  return res.status(200).json(data); // { status, qr?, displayName? } — client polls this while status === 'pending_qr'
}

async function whatsappDisconnect(req, res, userId) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const data = await relayRequest('/whatsapp/disconnect', { userId, method: 'POST' });
  return res.status(200).json(data);
}

async function placeCall(req, res, userId) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const { platform, to } = req.body || {};
  if (platform !== 'telegram' && platform !== 'whatsapp') return res.status(400).json({ error: "platform must be 'telegram' or 'whatsapp'" });
  if (!to || !to.trim()) return res.status(400).json({ error: 'to required' });
  const data = await relayRequest(`/${platform}/call`, { userId, method: 'POST', body: { to: to.trim() } });
  return res.status(200).json(data); // { callId, status }
}
