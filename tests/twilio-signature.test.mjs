import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  twilioSignatureFor, checkTwilioSignature, guardTwilioWebhook, candidateUrls,
} from '../lib/twilioSignature.js';

const TOKEN = 'unit-test-token';
const APP = 'https://emysa.example.com';
const PARAMS = { CallSid: 'CA123', CallStatus: 'completed', CallDuration: '61', From: '+15550001' };
const PATH = '/api/calls-status?callId=11111111-2222-3333-4444-555555555555';

// Twilio's documented algorithm, written independently of lib/twilioSignature.js.
function reference(token, url, params) {
  const s = url + Object.keys(params).sort().map((k) => k + params[k]).join('');
  return crypto.createHmac('sha1', token).update(s).digest('base64');
}
const req = (over = {}) => ({
  url: PATH, method: 'POST', body: { ...PARAMS },
  headers: { host: 'emysa.example.com', 'x-twilio-signature': reference(TOKEN, APP + PATH, PARAMS) },
  ...over,
});
const env = (over = {}) => ({ TWILIO_AUTH_TOKEN: TOKEN, PUBLIC_APP_URL: APP, ...over });
const res = () => {
  const r = { code: 200, body: undefined };
  r.status = (c) => { r.code = c; return r; };
  r.send = (b) => { r.body = b; return r; };
  return r;
};
const quiet = { warn() {} };

test('signature matches the documented algorithm', () => {
  assert.equal(twilioSignatureFor(TOKEN, APP + PATH, PARAMS), reference(TOKEN, APP + PATH, PARAMS));
});
test('a correctly signed request is accepted', () => {
  assert.deepEqual(checkTwilioSignature(req(), env()), { ok: true });
});
test('a tampered parameter is rejected (forged duration)', () => {
  const r = req({ body: { ...PARAMS, CallDuration: '9999' } });
  assert.equal(checkTwilioSignature(r, env()).ok, false);
});
test('a different callId in the URL is rejected', () => {
  const r = req({ url: '/api/calls-status?callId=99999999-2222-3333-4444-555555555555' });
  assert.equal(checkTwilioSignature(r, env()).ok, false);
});
test('a wrong auth token is rejected', () => {
  assert.equal(checkTwilioSignature(req(), env({ TWILIO_AUTH_TOKEN: 'other' })).ok, false);
});
test('a missing signature is rejected', () => {
  const r = req(); delete r.headers['x-twilio-signature'];
  assert.equal(checkTwilioSignature(r, env()).reason, 'missing signature');
});
test('the host the request arrived on is also accepted (PUBLIC_APP_URL changed)', () => {
  const r = req({ headers: { host: 'other.example.com', 'x-twilio-signature': reference(TOKEN, 'https://other.example.com' + PATH, PARAMS) } });
  assert.equal(checkTwilioSignature(r, env()).ok, true);
  assert.deepEqual(candidateUrls(r, env()), [APP + PATH, 'https://other.example.com' + PATH]);
});
test('a urlencoded string body is parsed', () => {
  const r = req({ body: new URLSearchParams(PARAMS).toString() });
  assert.equal(checkTwilioSignature(r, env()).ok, true);
});
test('without TWILIO_AUTH_TOKEN nothing is validated (existing behaviour kept)', () => {
  assert.equal(checkTwilioSignature(req({ headers: {} }), env({ TWILIO_AUTH_TOKEN: '' })).ok, true);
});
test('warn mode (default) lets a forged request through but logs it', () => {
  const logs = []; const r = res();
  const ok = guardTwilioWebhook(req({ headers: {} }), r, env(), { warn: (m) => logs.push(m) });
  assert.equal(ok, true); assert.equal(r.code, 200);
  assert.match(logs[0], /would reject/);
});
test('enforce mode answers 403 and stops the handler', () => {
  const r = res();
  const ok = guardTwilioWebhook(req({ headers: {} }), r, env({ TWILIO_WEBHOOK_VALIDATION: 'enforce' }), quiet);
  assert.equal(ok, false); assert.equal(r.code, 403);
});
test('enforce mode still lets a genuine request through', () => {
  const r = res();
  assert.equal(guardTwilioWebhook(req(), r, env({ TWILIO_WEBHOOK_VALIDATION: 'enforce' }), quiet), true);
  assert.equal(r.code, 200);
});
test('off mode skips validation', () => {
  assert.equal(guardTwilioWebhook(req({ headers: {} }), res(), env({ TWILIO_WEBHOOK_VALIDATION: 'off' }), quiet), true);
});

// The real route files must call the guard before touching the database.
for (const file of ['calls-status', 'calls-incoming', 'calls-twiml']) {
  test(`api/${file}.js rejects a forged request in enforce mode before any database access`, async () => {
    const saved = { ...process.env };
    Object.assign(process.env, { TWILIO_AUTH_TOKEN: TOKEN, PUBLIC_APP_URL: APP, TWILIO_WEBHOOK_VALIDATION: 'enforce' });
    delete process.env.SUPABASE_URL; delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    try {
      const { default: handler } = await import(`../api/${file}.js`);
      const r = res();
      await handler({ method: 'POST', url: `/api/${file}`, query: { callId: 'x' }, body: { CallStatus: 'completed', CallDuration: '9999' }, headers: {} }, r);
      assert.equal(r.code, 403);
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  });
}
