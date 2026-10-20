// Push keys: the public key devices subscribe with must always be the one the server signs with.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import webpush from 'web-push';
import { publicKeyFromPrivate, readVapid, subjectProblem, classifyPushFailure, summarizeFailures } from '../lib/vapid.js';

const good = webpush.generateVAPIDKeys();
const other = webpush.generateVAPIDKeys();
const subject = 'mailto:admin@example.com';

test('the public key derived from a private key is the pair web-push generated', () => {
  assert.equal(publicKeyFromPrivate(good.privateKey), good.publicKey);
  assert.equal(publicKeyFromPrivate(other.privateKey), other.publicKey);
});

test('garbage private keys are rejected instead of throwing', () => {
  for (const bad of ['', 'nope', 'AAAA', null, undefined, good.publicKey]) assert.equal(publicKeyFromPrivate(bad), null);
});

test('a matching pair is configured and not flagged', () => {
  const v = readVapid({ VAPID_PUBLIC_KEY: good.publicKey, VAPID_PRIVATE_KEY: good.privateKey, VAPID_SUBJECT: subject });
  assert.equal(v.configured, true);
  assert.equal(v.keysMismatch, false);
  assert.equal(v.publicKey, good.publicKey);
});

test('a mismatched pair is detected and the private key wins, so devices get the key that signs', () => {
  const v = readVapid({ VAPID_PUBLIC_KEY: other.publicKey, VAPID_PRIVATE_KEY: good.privateKey, VAPID_SUBJECT: subject });
  assert.equal(v.keysMismatch, true);
  assert.equal(v.publicKey, good.publicKey);
  assert.notEqual(v.publicKey, v.envPublicKey);
});

test('only a private key and subject is enough: the public key is derived', () => {
  const v = readVapid({ VAPID_PRIVATE_KEY: good.privateKey, VAPID_SUBJECT: subject });
  assert.equal(v.configured, true);
  assert.equal(v.publicKey, good.publicKey);
});

test('missing pieces are not configured', () => {
  assert.equal(readVapid({}).configured, false);
  assert.equal(readVapid({ VAPID_PUBLIC_KEY: good.publicKey, VAPID_PRIVATE_KEY: good.privateKey }).configured, false);
});

test('subject must be mailto: or https://', () => {
  assert.equal(subjectProblem('mailto:a@b.co'), null);
  assert.equal(subjectProblem('https://emysa.app'), null);
  assert.match(subjectProblem('a@b.co'), /mailto:/);
  assert.match(subjectProblem('http://insecure.test'), /mailto:/);
  assert.match(subjectProblem(''), /not set/);
});

test('with the derived key, the signed request carries the key the device subscribed with', () => {
  const v = readVapid({ VAPID_PUBLIC_KEY: other.publicKey, VAPID_PRIVATE_KEY: good.privateKey, VAPID_SUBJECT: subject });
  const device = crypto.createECDH('prime256v1'); device.generateKeys();
  const sub = { endpoint: 'https://web.push.apple.com/abc', keys: { p256dh: device.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') } };
  webpush.setVapidDetails(v.subject, v.publicKey, v.privateKey);
  const req = webpush.generateRequestDetails(sub, JSON.stringify({ title: 't', body: 'b' }));
  assert.match(req.headers.Authorization, /^vapid /);
  assert.ok(req.headers.Authorization.includes(`k=${good.publicKey}`), 'signed for the derived key');
  assert.ok(!req.headers.Authorization.includes(other.publicKey));
});

test('a failure is explained in words an admin can act on', () => {
  assert.equal(classifyPushFailure({ statusCode: 410 }).kind, 'expired');
  assert.equal(classifyPushFailure({ statusCode: 404 }).kind, 'expired');
  const r = classifyPushFailure({ statusCode: 403, body: 'VapidPkHashMismatch' });
  assert.equal(r.kind, 'rejected');
  assert.match(r.reason, /different key/);
  assert.match(r.reason, /VapidPkHashMismatch/);
  assert.equal(classifyPushFailure({ statusCode: 401, body: 'bad jwt' }).kind, 'rejected');
  assert.equal(classifyPushFailure({ statusCode: 429 }).kind, 'rate');
  assert.equal(classifyPushFailure({ statusCode: 503 }).kind, 'service');
  assert.equal(classifyPushFailure({ message: 'Request timeout' }).kind, 'network');
  assert.equal(classifyPushFailure({ statusCode: 400, body: 'weird' }).kind, 'other');
});

test('failures are grouped one line per cause, most common first', () => {
  const f = [classifyPushFailure({ statusCode: 410 }), classifyPushFailure({ statusCode: 403 }), classifyPushFailure({ statusCode: 403 }), classifyPushFailure({ statusCode: 403 })];
  const s = summarizeFailures(f);
  assert.equal(s.length, 2);
  assert.equal(s[0].kind, 'rejected');
  assert.equal(s[0].count, 3);
  assert.equal(s[1].count, 1);
});

test('every sender uses the shared keys and the key endpoint hands out the signing key', () => {
  const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
  assert.match(read('api/admin.js'), /readVapid\(process\.env\)/);
  assert.match(read('api/assistant.js'), /publicKey: readVapid\(process\.env\)\.publicKey/);
  assert.match(read('lib/summaryPush.js'), /readVapid\(env\)/);
  assert.match(read('lib/adminPush.js'), /readVapid\(env\)/);
  assert.match(read('admin/admin.js'), /data\.reasons/);
  assert.match(read('admin/admin.js'), /await repairAlerts\(\);/);
});
import { readFileSync } from 'node:fs';
