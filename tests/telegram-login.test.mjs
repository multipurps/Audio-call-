import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { verifyIdToken, telegramEmail, allowedRedirect } from '../lib/telegramLogin.js';

const env = { TELEGRAM_CLIENT_ID: '9211938401', TELEGRAM_CLIENT_SECRET: 'x' };
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1' };
const b = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function token(claims, key = privateKey) {
  const head = b({ alg: 'RS256', kid: 'k1', typ: 'JWT' });
  const body = b(claims);
  const sig = crypto.sign('sha256', Buffer.from(`${head}.${body}`), key).toString('base64url');
  return `${head}.${body}.${sig}`;
}
const fetchImpl = async () => ({ json: async () => ({ keys: [jwk] }) });
const good = { iss: 'https://oauth.telegram.org', aud: '9211938401', sub: '42', exp: Math.floor(Date.now() / 1000) + 600 };

test('accepts a valid token', async () => { assert.equal((await verifyIdToken(token(good), { env, fetchImpl })).sub, '42'); });
test('rejects wrong audience, issuer, expiry and bad signature', async () => {
  await assert.rejects(verifyIdToken(token({ ...good, aud: '1' }), { env, fetchImpl }));
  await assert.rejects(verifyIdToken(token({ ...good, iss: 'https://evil.example' }), { env, fetchImpl }));
  await assert.rejects(verifyIdToken(token({ ...good, exp: 1 }), { env, fetchImpl }));
  const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  await assert.rejects(verifyIdToken(token(good, other), { env, fetchImpl }));
});
test('account address is fixed per Telegram user', () => { assert.equal(telegramEmail('42'), 'tg-42@telegram.example.com'); assert.match(allowedRedirect({}), /index\.html$/); });

import { botReply } from '../lib/telegramLogin.js';
test('bot answers /start with a button that opens the app', () => {
  const r = botReply({ text: '/start', from: { first_name: 'Ayo' } });
  assert.match(r.text, /Hi Ayo/);
  assert.equal(r.reply_markup.inline_keyboard[0][0].web_app.url, 'https://audio-call-iota.vercel.app/');
  assert.match(botReply({ text: '/help' }).text, /\/start/);
});
