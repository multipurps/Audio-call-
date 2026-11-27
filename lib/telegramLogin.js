// "Sign in with Telegram" (Telegram's OpenID Connect login, https://core.telegram.org/bots/telegram-login).
// The browser sends the one-time code here; this exchanges it (the client secret never leaves the server),
// verifies Telegram's signed id_token, and returns a one-time token the app turns into a normal session.
import crypto from 'node:crypto';

const ISSUER = 'https://oauth.telegram.org';
const DEFAULT_REDIRECT = 'https://audio-call-iota.vercel.app/index.html';

export const telegramConfigured = (env = process.env) => Boolean(env.TELEGRAM_CLIENT_ID && env.TELEGRAM_CLIENT_SECRET);
export const allowedRedirect = (env = process.env) => env.TELEGRAM_REDIRECT_URI || DEFAULT_REDIRECT;

const b64u = (s) => Buffer.from(String(s), 'base64url');

export async function exchangeCode({ code, verifier, redirectUri }, { env = process.env, fetchImpl = fetch } = {}) {
  const basic = Buffer.from(`${env.TELEGRAM_CLIENT_ID}:${env.TELEGRAM_CLIENT_SECRET}`).toString('base64');
  const resp = await fetchImpl(`${ISSUER}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${basic}` },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: env.TELEGRAM_CLIENT_ID, code_verifier: verifier }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.id_token) throw new Error(`Telegram refused the sign-in (${data.error || resp.status})`);
  return data.id_token;
}

// Verifies the signature (RS256 or ES256), issuer, audience and expiry. Returns the claims.
export async function verifyIdToken(idToken, { env = process.env, fetchImpl = fetch, now = Date.now() } = {}) {
  const parts = String(idToken).split('.');
  if (parts.length !== 3) throw new Error('Bad Telegram token');
  const header = JSON.parse(b64u(parts[0]).toString());
  const claims = JSON.parse(b64u(parts[1]).toString());
  const jwks = await (await fetchImpl(`${ISSUER}/.well-known/jwks.json`)).json();
  const jwk = (jwks.keys || []).find((k) => k.kid === header.kid) || (jwks.keys || [])[0];
  if (!jwk) throw new Error('No Telegram signing key');
  const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  const data = Buffer.from(`${parts[0]}.${parts[1]}`);
  const sig = b64u(parts[2]);
  let ok = false;
  if (header.alg === 'RS256') ok = crypto.verify('sha256', data, key, sig);
  else if (header.alg === 'ES256') ok = crypto.verify('sha256', data, { key, dsaEncoding: 'ieee-p1363' }, sig);
  else throw new Error(`Unsupported Telegram token algorithm ${header.alg}`);
  if (!ok) throw new Error('Telegram token signature is invalid');
  if (claims.iss !== ISSUER) throw new Error('Telegram token issuer is wrong');
  const aud = Array.isArray(claims.aud) ? claims.aud.map(String) : [String(claims.aud)];
  if (!aud.includes(String(env.TELEGRAM_CLIENT_ID))) throw new Error('Telegram token is for another app');
  if (!claims.exp || claims.exp * 1000 < now) throw new Error('Telegram token expired');
  if (!claims.sub) throw new Error('Telegram token has no user');
  return claims;
}

// One Emysa account per Telegram user, found by a fixed internal address that never receives mail.
export const telegramEmail = (sub) => `tg-${sub}@telegram.example.com`;

export async function sessionTokenFor(supabase, claims) {
  const tgId = String(claims.id ?? claims.sub);
  const email = telegramEmail(tgId);
  const meta = { telegram_id: tgId, full_name: claims.name || claims.preferred_username || '', telegram_username: claims.preferred_username || null, avatar_url: claims.picture || null };
  const created = await supabase.auth.admin.createUser({ email, email_confirm: true, user_metadata: meta });
  if (created.error && !/already|registered|exists/i.test(created.error.message)) throw new Error(created.error.message);
  const link = await supabase.auth.admin.generateLink({ type: 'magiclink', email });
  const hashed = link.data?.properties?.hashed_token;
  if (link.error || !hashed) throw new Error(link.error?.message || 'Could not start the session');
  return { tokenHash: hashed, isNew: !created.error };
}

// ---------- the bot itself: answers /start and friends with a button that opens the app ----------
const APP_URL = 'https://audio-call-iota.vercel.app/';

export function botReply(message) {
  const text = String(message?.text || '').trim();
  const cmd = text.split(/[\s@]/)[0].toLowerCase();
  const name = message?.from?.first_name || '';
  const open = { inline_keyboard: [[{ text: 'Open Emysa', web_app: { url: APP_URL } }]] };
  if (cmd === '/help') {
    return { text: 'Emysa makes and answers calls for you, in your voice.\n\n/start - open Emysa\n/open - open Emysa\n/help - this message', reply_markup: open };
  }
  // /start, /open, or anything else: the same welcome and button.
  return { text: `Hi${name ? ` ${name}` : ''}, I'm Emysa. I make and answer calls for you, in your voice.\n\nTap the button to open the app.`, reply_markup: open };
}

export async function handleBotUpdate(update, { env = process.env, fetchImpl = fetch } = {}) {
  const message = update?.message;
  if (!message?.chat?.id || message.chat.type !== 'private') return false;
  const reply = botReply(message);
  const resp = await fetchImpl(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: message.chat.id, ...reply }),
  });
  return resp.ok;
}

// Registers the webhook, the command list and the menu button with Telegram. Safe to run again.
export async function setupBot({ env = process.env, fetchImpl = fetch } = {}) {
  const api = (method, body) => fetchImpl(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }).then((r) => r.json()).then((j) => ({ ok: j.ok, description: j.description }));
  return {
    webhook: await api('setWebhook', { url: `${APP_URL}api/referrals?action=telegram-webhook`, secret_token: env.TELEGRAM_WEBHOOK_SECRET, allowed_updates: ['message'], drop_pending_updates: true }),
    commands: await api('setMyCommands', { commands: [{ command: 'start', description: 'Open Emysa' }, { command: 'open', description: 'Open Emysa' }, { command: 'help', description: 'What Emysa does' }] }),
    menu: await api('setChatMenuButton', { menu_button: { type: 'web_app', text: 'Open Emysa', web_app: { url: APP_URL } } }),
  };
}

// Inside a Telegram mini app the app already knows who the user is: Telegram hands it initData, signed with a
// key derived from the bot token. No login page, no confirmation. Returns claims shaped like the OIDC ones.
export function verifyInitData(initData, { env = process.env, now = Date.now(), maxAgeSec = 24 * 3600 } = {}) {
  const params = new URLSearchParams(String(initData || ''));
  const hash = params.get('hash');
  if (!hash || !env.TELEGRAM_BOT_TOKEN) throw new Error('Bad Telegram data');
  params.delete('hash');
  const check = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(env.TELEGRAM_BOT_TOKEN).digest();
  const expected = crypto.createHmac('sha256', secret).update(check).digest('hex');
  const a = Buffer.from(expected), b = Buffer.from(hash);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new Error('Telegram data is not genuine');
  const authDate = Number(params.get('auth_date'));
  if (!authDate || now / 1000 - authDate > maxAgeSec) throw new Error('Telegram data is too old');
  const user = JSON.parse(params.get('user') || 'null');
  if (!user?.id) throw new Error('No Telegram user');
  return { id: String(user.id), sub: String(user.id), name: [user.first_name, user.last_name].filter(Boolean).join(' '), preferred_username: user.username || null, picture: user.photo_url || null };
}
