// Audio Call — social calling relay
//
// Always-on companion to server/patter-relay.js (Twilio), deployed as its
// own Render service so its native dependencies (tgcalls' bindings via
// `telegram`, @roamhq/wrtc for Baileys calling) can never break the
// existing, working Twilio relay by sharing a package.json with it.
//
// Holds one Telegram MTProto client and/or one Baileys WhatsApp socket per
// linked end-user, in memory, for as long as this process is up. Session
// state is persisted to Supabase (encrypted) on every change so a redeploy
// or restart can resume without the user re-logging-in.
//
// Auth model: this service trusts requests carrying SOCIAL_RELAY_INTERNAL_SECRET
// (shared with Vercel's api/social-calling.js, never exposed to the browser)
// and an X-User-Id header that Vercel has already verified against the
// caller's Supabase session. This service never sees a Supabase user JWT.

import express from 'express';
import crypto from 'crypto';
import bigInt from 'big-integer';
import { createClient } from '@supabase/supabase-js';
import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import makeWASocket, { useMultiFileAuthState, DisconnectReason, initAuthCreds, BufferJSON } from '@queenanya/baileys';
import QRCode from 'qrcode';

const PORT = process.env.PORT || 8081;
const INTERNAL_SECRET = process.env.SOCIAL_RELAY_INTERNAL_SECRET;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TELEGRAM_API_ID = Number(process.env.TELEGRAM_API_ID);
const TELEGRAM_API_HASH = process.env.TELEGRAM_API_HASH;
const ENC_KEY = process.env.SOCIAL_SESSION_ENC_KEY; // 32-byte key, base64
// WhatsApp calling is reverse-engineered and unofficial (see brief / README) —
// off by default so linking WhatsApp for messaging-safe use never accidentally
// exercises the call path until this is explicitly turned on per deployment.
const WHATSAPP_CALLING_ENABLED = process.env.WHATSAPP_CALLING_ENABLED === 'true';

if (!INTERNAL_SECRET || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !ENC_KEY) {
  console.error('Missing required env vars (SOCIAL_RELAY_INTERNAL_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SOCIAL_SESSION_ENC_KEY) — refusing to start.');
  process.exit(1);
}
if (!TELEGRAM_API_ID || !TELEGRAM_API_HASH) {
  console.warn('TELEGRAM_API_ID / TELEGRAM_API_HASH not set — Telegram linking will fail until they are.');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

// ---------------------------------------------------------------------------
// Encryption at rest for session data (AES-256-GCM). ENC_KEY never leaves
// this process or the Render env var store — Vercel and Postgres only ever
// see ciphertext.
// ---------------------------------------------------------------------------
function encrypt(plaintext) {
  const key = Buffer.from(ENC_KEY, 'base64');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]); // stored as bytea: iv(12) + tag(16) + ciphertext
}

function decrypt(bytea) {
  const buf = Buffer.isBuffer(bytea) ? bytea : Buffer.from(bytea);
  const key = Buffer.from(ENC_KEY, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ciphertext = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

// ---------------------------------------------------------------------------
// In-memory session registries. userId -> live client/socket. Rebuilt lazily
// from the encrypted Supabase row on first use after a restart.
// ---------------------------------------------------------------------------
const telegramPendingLogins = new Map(); // userId -> { client, phone, phoneCodeHash }
const telegramClients = new Map(); // userId -> connected TelegramClient
const whatsappSessions = new Map(); // userId -> { sock, qrDataUrl, status }

async function upsertTelegramStatus(userId, patch) {
  await supabase.from('telegram_accounts').upsert({ user_id: userId, updated_at: new Date().toISOString(), ...patch }, { onConflict: 'user_id' });
}
async function upsertWhatsappStatus(userId, patch) {
  await supabase.from('whatsapp_accounts').upsert({ user_id: userId, updated_at: new Date().toISOString(), ...patch }, { onConflict: 'user_id' });
}

// ---------------------------------------------------------------------------
// Telegram — login via GramJS (MTProto client), calling via raw phone.*
// methods. tgcalls' own Node bindings own the actual audio stream once a
// call is accepted; wiring that up needs a live Telegram account to verify
// against (bindings + protocol version drift often enough that this can't
// be trusted from static review alone) — RequestCall below gets a real call
// ringing at the protocol level; finishing the audio bridge is the piece to
// test live before shipping.
// ---------------------------------------------------------------------------
async function getOrRestoreTelegramClient(userId) {
  if (telegramClients.has(userId)) return telegramClients.get(userId);
  const { data } = await supabase.from('telegram_accounts').select('session_encrypted, status').eq('user_id', userId).maybeSingle();
  if (!data?.session_encrypted || data.status !== 'connected') return null;
  const sessionString = decrypt(data.session_encrypted);
  const client = new TelegramClient(new StringSession(sessionString), TELEGRAM_API_ID, TELEGRAM_API_HASH, { connectionRetries: 5 });
  await client.connect();
  telegramClients.set(userId, client);
  return client;
}

async function telegramStart(userId, phone) {
  const client = new TelegramClient(new StringSession(''), TELEGRAM_API_ID, TELEGRAM_API_HASH, { connectionRetries: 5 });
  await client.connect();
  const result = await client.invoke(new Api.auth.SendCode({
    phoneNumber: phone,
    apiId: TELEGRAM_API_ID,
    apiHash: TELEGRAM_API_HASH,
    settings: new Api.CodeSettings({}),
  }));
  telegramPendingLogins.set(userId, { client, phone, phoneCodeHash: result.phoneCodeHash });
  await upsertTelegramStatus(userId, { status: 'pending_otp', last_error: null });
  return { status: 'pending_otp' };
}

async function telegramVerify(userId, code, password) {
  const pending = telegramPendingLogins.get(userId);
  if (!pending) {
    const err = new Error('No pending Telegram login for this user — start again');
    err.statusCode = 400;
    throw err;
  }
  try {
    await pending.client.invoke(new Api.auth.SignIn({
      phoneNumber: pending.phone,
      phoneCodeHash: pending.phoneCodeHash,
      phoneCode: code,
    }));
  } catch (err) {
    if (err.errorMessage === 'SESSION_PASSWORD_NEEDED') {
      if (!password) return { status: 'needs_password' };
      await pending.client.signInWithPassword({ apiId: TELEGRAM_API_ID, apiHash: TELEGRAM_API_HASH }, {
        password: async () => password,
        onError: (e) => { throw e; },
      });
    } else {
      await upsertTelegramStatus(userId, { status: 'error', last_error: err.errorMessage || String(err) });
      throw err;
    }
  }

  const me = await pending.client.getMe();
  const sessionString = pending.client.session.save();
  await upsertTelegramStatus(userId, {
    telegram_user_id: String(me.id),
    display_name: me.firstName || me.username || 'Telegram user',
    phone_last4: pending.phone.slice(-4),
    session_encrypted: encrypt(sessionString),
    status: 'connected',
    last_error: null,
  });
  telegramClients.set(userId, pending.client);
  telegramPendingLogins.delete(userId);
  return { status: 'connected', displayName: me.firstName || me.username };
}

async function telegramDisconnect(userId) {
  const client = telegramClients.get(userId) || (await getOrRestoreTelegramClient(userId));
  if (client) {
    try { await client.invoke(new Api.auth.LogOut()); } catch { /* best-effort */ }
    try { await client.destroy(); } catch { /* best-effort */ }
  }
  telegramClients.delete(userId);
  telegramPendingLogins.delete(userId);
  await upsertTelegramStatus(userId, { status: 'disconnected', session_encrypted: null, last_error: null });
  return { status: 'disconnected' };
}

// GramJS (like Telethon, which it's a port of) can only resolve an entity
// from its *local* cache — usernames resolve fine via a direct server call,
// but a bare phone number is never in that cache unless it's already a
// synced contact. That's exactly the "Could not find the input entity"
// error from Telethon's own docs: the fix it points to is importing the
// number as a contact first, which makes Telegram's servers tell us which
// account (if any) it belongs to, so GramJS can then resolve it normally.
async function resolveTelegramPeer(client, toUsernameOrPhone) {
  const raw = String(toUsernameOrPhone || '').trim();
  if (!raw) {
    const err = new Error('No number or username given to call.');
    err.statusCode = 400;
    throw err;
  }

  // Fast path: usernames, or anything already in the local entity cache
  // (recent dialogs, a peer resolved earlier this session).
  if (!/^[+0-9][0-9\s()-]*$/.test(raw)) {
    try {
      return await client.getInputEntity(raw);
    } catch {
      const err = new Error(`Couldn't find a Telegram user @${raw.replace(/^@/, '')}.`);
      err.statusCode = 404;
      throw err;
    }
  }

  // It reads as a phone number — needs a country code to mean anything on
  // Telegram (a bare local-format number like "09038226059" can't be
  // resolved; there's no way to guess which country it belongs to).
  const digits = raw.replace(/[\s()-]/g, '');
  if (!/^\+[1-9]\d{7,14}$/.test(digits)) {
    const err = new Error("That number needs a country code to call on Telegram — e.g. +2349038226059, not 09038226059.");
    err.statusCode = 400;
    throw err;
  }

  const result = await client.invoke(new Api.contacts.ImportContacts({
    contacts: [new Api.InputPhoneContact({
      clientId: bigInt(Date.now()),
      phone: digits,
      firstName: 'Call',
      lastName: 'Contact',
    })],
  }));
  const user = result.users?.[0];
  if (!user) {
    const err = new Error(`No Telegram account found for ${digits} — they may not be on Telegram, or their privacy settings hide their number from lookups like this.`);
    err.statusCode = 404;
    throw err;
  }
  return new Api.InputUser({ userId: user.id, accessHash: user.accessHash });
}

async function telegramCall(userId, toUsernameOrPhone) {
  const client = await getOrRestoreTelegramClient(userId);
  if (!client) {
    const err = new Error('Telegram not connected for this user');
    err.statusCode = 409;
    throw err;
  }
  const peer = await resolveTelegramPeer(client, toUsernameOrPhone);
  // Real DH-exchange call request at the MTProto level. gAHash/protocol
  // params below are placeholders for the tgcalls key-exchange this needs —
  // NEEDS LIVE VERIFICATION: wiring RequestCall's DH response into tgcalls'
  // Node bindings to actually carry audio is the part that has to be
  // exercised against a real account before this is call-ready.
  const result = await client.invoke(new Api.phone.RequestCall({
    userId: peer,
    randomId: crypto.randomInt(1, 2 ** 31 - 1),
    gAHash: crypto.randomBytes(256),
    protocol: new Api.PhoneCallProtocol({
      udpP2p: true,
      udpReflector: true,
      minLayer: 65,
      maxLayer: 92,
      libraryVersions: ['4.0.0'],
    }),
  }));
  return { status: 'ringing', telegramCallId: String(result.phoneCall?.id || '') };
}

// ---------------------------------------------------------------------------
// WhatsApp — Baileys (QueenAnya/Bail fork per the brief) with a Supabase-
// backed auth state so sessions survive Render redeploys (Baileys' default
// useMultiFileAuthState writes to local disk, which does not survive one).
// Calling (sock.initiateCall) is unofficial/reverse-engineered — gated
// behind WHATSAPP_CALLING_ENABLED, off by default. See README-social.md.
// ---------------------------------------------------------------------------
async function useSupabaseAuthState(userId) {
  const { data } = await supabase.from('whatsapp_accounts').select('auth_state_encrypted').eq('user_id', userId).maybeSingle();
  let stored = null;
  if (data?.auth_state_encrypted) {
    try { stored = JSON.parse(decrypt(data.auth_state_encrypted), BufferJSON.reviver); } catch { stored = null; }
  }
  const creds = stored?.creds || initAuthCreds();
  const keysData = stored?.keys || {};

  async function persist() {
    const payload = JSON.stringify({ creds, keys: keysData }, BufferJSON.replacer);
    await upsertWhatsappStatus(userId, { auth_state_encrypted: encrypt(payload) });
  }

  const keys = {
    get: async (type, ids) => {
      const result = {};
      for (const id of ids) {
        const value = keysData[type]?.[id];
        if (value !== undefined) result[id] = value;
      }
      return result;
    },
    set: async (data) => {
      for (const category of Object.keys(data)) {
        keysData[category] = keysData[category] || {};
        Object.assign(keysData[category], data[category]);
      }
      await persist();
    },
  };

  return { state: { creds, keys }, saveCreds: persist };
}

async function whatsappStart(userId) {
  const { state, saveCreds } = await useSupabaseAuthState(userId);
  const sock = makeWASocket({ auth: state, printQRInTerminal: false, syncFullHistory: false });
  const entry = { sock, qrDataUrl: null, status: 'pending_qr' };
  whatsappSessions.set(userId, entry);

  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', async (update) => {
    const { connection, qr, lastDisconnect } = update;
    if (qr) {
      entry.qrDataUrl = await QRCode.toDataURL(qr);
      entry.status = 'pending_qr';
      await upsertWhatsappStatus(userId, { status: 'pending_qr', last_error: null });
    }
    if (connection === 'open') {
      entry.status = 'connected';
      await upsertWhatsappStatus(userId, {
        whatsapp_jid: sock.user?.id || null,
        display_name: sock.user?.name || sock.user?.notify || null,
        status: 'connected',
        last_error: null,
      });
    }
    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      if (statusCode === DisconnectReason.loggedOut) {
        whatsappSessions.delete(userId);
        await upsertWhatsappStatus(userId, { status: 'disconnected', auth_state_encrypted: null });
      } else {
        // Transient drop — leave status as-is; next /whatsapp/status or
        // /whatsapp/call call will lazily reconnect via getOrRestoreWhatsapp().
        whatsappSessions.delete(userId);
      }
    }
  });

  // Give it a moment to produce a QR (or connect immediately from stored creds).
  return new Promise((resolve) => {
    const deadline = Date.now() + 15_000;
    const poll = setInterval(() => {
      if (entry.qrDataUrl || entry.status === 'connected' || Date.now() > deadline) {
        clearInterval(poll);
        resolve({ status: entry.status, qr: entry.qrDataUrl });
      }
    }, 250);
  });
}

async function whatsappStatusCheck(userId) {
  const entry = whatsappSessions.get(userId);
  if (entry) return { status: entry.status, qr: entry.qrDataUrl };
  const { data } = await supabase.from('whatsapp_accounts').select('status, display_name').eq('user_id', userId).maybeSingle();
  return { status: data?.status || 'disconnected', displayName: data?.display_name || null };
}

async function whatsappDisconnect(userId) {
  const entry = whatsappSessions.get(userId);
  if (entry?.sock) {
    try { await entry.sock.logout(); } catch { /* best-effort */ }
  }
  whatsappSessions.delete(userId);
  await upsertWhatsappStatus(userId, { status: 'disconnected', auth_state_encrypted: null });
  return { status: 'disconnected' };
}

async function getOrRestoreWhatsapp(userId) {
  if (whatsappSessions.has(userId)) return whatsappSessions.get(userId).sock;
  const { data } = await supabase.from('whatsapp_accounts').select('status').eq('user_id', userId).maybeSingle();
  if (data?.status !== 'connected') return null;
  await whatsappStart(userId); // rebuilds the socket from the stored (encrypted) auth state
  return whatsappSessions.get(userId)?.sock || null;
}

async function whatsappCall(userId, toJidOrPhone) {
  if (!WHATSAPP_CALLING_ENABLED) {
    const err = new Error('WhatsApp calling is disabled on this deployment (unofficial/ban-risk — see README-social.md to opt in)');
    err.statusCode = 403;
    throw err;
  }
  const sock = await getOrRestoreWhatsapp(userId);
  if (!sock) {
    const err = new Error('WhatsApp not connected for this user');
    err.statusCode = 409;
    throw err;
  }
  const jid = toJidOrPhone.includes('@')
    ? toJidOrPhone
    : (() => {
        const digits = toJidOrPhone.replace(/[\s()-]/g, '');
        if (!/^\+?[1-9]\d{7,14}$/.test(digits)) {
          const err = new Error('That doesn\'t look like a full phone number — include the country code, e.g. +2349038226059.');
          err.statusCode = 400;
          throw err;
        }
        return `${digits.replace(/^\+/, '')}@s.whatsapp.net`;
      })();
  // sock.initiateCall() is wired into this fork's core socket chain
  // (attachVoipToSocket(sock), called automatically for every socket —
  // see src/addons/README.md's "VoIP Calling" section), not a bolt-on addon
  // you have to attach yourself. @roamhq/wrtc is only pulled in via a lazy
  // dynamic import inside initiateCall() itself, so it's declared as an
  // optionalDependency in package.json — a failed native build there does
  // not break `npm install` for the rest of this service.
  // STILL NEEDS A LIVE TEST PASS: the fork's own README documents this as
  // independently verified against the upstream WASM VoIP engine, but
  // "verified by the fork's maintainer" isn't "verified against your
  // Render environment" — confirm a real call connects before shipping it.
  if (typeof sock.initiateCall !== 'function') {
    const err = new Error('This Baileys build does not expose initiateCall() — check the QueenAnya/Bail dependency version');
    err.statusCode = 500;
    throw err;
  }
  const result = await sock.initiateCall(jid);
  return { status: 'ringing', whatsappCallResult: result || null };
}

// ---------------------------------------------------------------------------
// HTTP surface
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json());

// Public — Render's health check hits this without the internal secret.
app.get('/healthz', (req, res) => res.status(200).json({ ok: true }));

app.use((req, res, next) => {
  if (req.headers['x-internal-secret'] !== INTERNAL_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  const userId = req.headers['x-user-id'];
  if (!userId) return res.status(400).json({ error: 'X-User-Id required' });
  req.userId = String(userId);
  next();
});

function wrap(fn) {
  return async (req, res) => {
    try {
      res.status(200).json(await fn(req));
    } catch (err) {
      res.status(err.statusCode || 500).json({ error: err.message || 'Internal error' });
    }
  };
}

app.post('/telegram/start', wrap((req) => telegramStart(req.userId, req.body?.phone)));
app.post('/telegram/verify', wrap((req) => telegramVerify(req.userId, req.body?.code, req.body?.password)));
app.post('/telegram/disconnect', wrap((req) => telegramDisconnect(req.userId)));
app.post('/telegram/call', wrap((req) => telegramCall(req.userId, req.body?.to)));

app.post('/whatsapp/start', wrap((req) => whatsappStart(req.userId)));
app.get('/whatsapp/status', wrap((req) => whatsappStatusCheck(req.userId)));
app.post('/whatsapp/disconnect', wrap((req) => whatsappDisconnect(req.userId)));
app.post('/whatsapp/call', wrap((req) => whatsappCall(req.userId, req.body?.to)));

app.listen(PORT, () => console.log(`social-calling relay listening on :${PORT}`));
