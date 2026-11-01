import test from 'node:test';
import assert from 'node:assert/strict';
import { mintXmaxTemporaryKey, revokeXmaxTemporaryKey, xmaxTokenRoute, xmaxPointsLimit } from '../lib/xmaxToken.js';

const PERM = 'uk-test-permanent-key-1234567890';
const TK = 'tk-test-temporary-abc123';
const supabaseNoRow = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }) };
const fakeRes = () => ({ code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });
const okFetch = (captured) => async (url, init) => {
  captured.push({ url, init });
  return { ok: true, status: 200, text: async () => JSON.stringify({ success: true, data: { temporaryApiKey: TK, expireTimestamp: 123 } }) };
};

test('mint posts the permanent key in the header and never returns it', async () => {
  const calls = [];
  const out = await mintXmaxTemporaryKey({ permanentKey: PERM, pointsLimit: 500, fetchImpl: okFetch(calls) });
  assert.equal(out.temporaryApiKey, TK);
  assert.equal(JSON.stringify(out).includes(PERM), false);
  assert.equal(calls[0].url, 'https://api.xmax.ai/open/api/v1/temporary-api-key');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['X-Api-Key'], PERM);
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body, { expireSeconds: 3600, pointsLimit: 500, temporaryApiKeySessionLimit: 1 });
});

test('mint turns an Xmax error into a thrown error with its status', async () => {
  const bad = async () => ({ ok: false, status: 401, text: async () => JSON.stringify({ success: false, message: 'bad key' }) });
  await assert.rejects(() => mintXmaxTemporaryKey({ permanentKey: PERM, fetchImpl: bad }), (e) => e.status === 401 && /bad key/.test(e.message));
});

test('revoke deactivates the temporary key', async () => {
  const calls = [];
  const ok = await revokeXmaxTemporaryKey({ permanentKey: PERM, temporaryApiKey: TK, fetchImpl: okFetch(calls) });
  assert.equal(ok, true);
  assert.equal(calls[0].url, `https://api.xmax.ai/open/api/v1/temporary-api-key/${TK}/inactive`);
  assert.equal(calls[0].init.method, 'PUT');
});

test('points limit is clamped to a sane range', () => {
  assert.equal(xmaxPointsLimit({}), 3000);
  assert.equal(xmaxPointsLimit({ XMAX_POINTS_LIMIT: '800' }), 800);
  assert.equal(xmaxPointsLimit({ XMAX_POINTS_LIMIT: '999999' }), 3000);
  assert.equal(xmaxPointsLimit({ XMAX_POINTS_LIMIT: 'abc' }), 3000);
});

test('route: GET is refused and a missing key says so', async () => {
  const res = fakeRes();
  await xmaxTokenRoute({ method: 'GET' }, res, supabaseNoRow, 'u1', { env: {} });
  assert.equal(res.code, 405);
  const res2 = fakeRes();
  await xmaxTokenRoute({ method: 'POST', body: { op: 'mint' } }, res2, supabaseNoRow, 'u1', { env: {} });
  assert.equal(res2.code, 400);
  assert.match(res2.body.error, /Save your Xmax API key/);
});

test('route: mint returns only the temporary key; revoke rejects a non-temporary key', async () => {
  const calls = [];
  const res = fakeRes();
  await xmaxTokenRoute({ method: 'POST', body: { op: 'mint' } }, res, supabaseNoRow, 'u1', { getKey: async () => PERM, fetchImpl: okFetch(calls) });
  assert.equal(res.code, 200);
  assert.equal(res.body.temporaryApiKey, TK);
  assert.equal(JSON.stringify(res.body).includes(PERM), false);
  const bad = fakeRes();
  await xmaxTokenRoute({ method: 'POST', body: { op: 'revoke', temporaryApiKey: PERM } }, bad, supabaseNoRow, 'u1', { getKey: async () => PERM, fetchImpl: okFetch([]) });
  assert.equal(bad.code, 400);
});
