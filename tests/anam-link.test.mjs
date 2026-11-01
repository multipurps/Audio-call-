import test from 'node:test';
import assert from 'node:assert/strict';
import { anamLlmSecret, userFromAnamLlmSecret, ensureAnamLlm, anamLlmRoute, anamVoiceRoute } from '../lib/anamLink.js';

const KEY = 'anam-server-key-1234567890';
const ME = '11111111-1111-1111-1111-111111111111';

function fakeDb(seed = {}) {
  const tables = JSON.parse(JSON.stringify(seed));
  const from = (name) => {
    tables[name] ||= [];
    const filters = [];
    let op = 'select', payload = null;
    const matches = (r) => filters.every(([c, v]) => r[c] === v);
    const run = () => {
      const list = tables[name];
      if (op === 'upsert') {
        const row = list.find((r) => r.user_id === payload.user_id);
        if (row) Object.assign(row, payload); else list.push({ ...payload });
        return [];
      }
      return list.filter(matches).map((r) => ({ ...r }));
    };
    const q = {
      select() { return q; }, eq(c, v) { filters.push([c, v]); return q; },
      order() { return q; }, upsert(p) { op = 'upsert'; payload = p; return q; },
      async maybeSingle() { return { data: run()[0] || null, error: null }; },
      then(res, rej) { return Promise.resolve({ data: run(), error: null }).then(res, rej); },
    };
    return q;
  };
  return { from, tables };
}
const fakeRes = () => ({
  code: 200, body: null, headers: {}, chunks: [],
  status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; },
  setHeader(k, v) { this.headers[k] = v; }, write(c) { this.chunks.push(c); }, end() { this.ended = true; return this; },
});

test('the LLM secret identifies the person and cannot be forged', () => {
  const token = anamLlmSecret(ME, KEY);
  assert.equal(userFromAnamLlmSecret(token, KEY), ME);
  assert.equal(userFromAnamLlmSecret(token, 'another-key-value-here'), null);
  assert.equal(userFromAnamLlmSecret(`${ME}.${'0'.repeat(64)}`, KEY), null);
  assert.equal(userFromAnamLlmSecret('nonsense', KEY), null);
});

test('ensureAnamLlm registers once, points at /anam-llm, and reuses the id', async () => {
  const db = fakeDb();
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return { ok: true, status: 201, text: async () => JSON.stringify({ id: 'llm-9' }) };
  };
  const id = await ensureAnamLlm({ supabase: db, userId: ME, apiKey: KEY, appUrl: 'https://emysa.example', fetchImpl });
  assert.equal(id, 'llm-9');
  assert.equal(calls[0].url, 'https://api.anam.ai/v1/llms');
  assert.equal(calls[0].body.llmFormat, 'openai');
  assert.deepEqual(calls[0].body.urls, [{ url: 'https://emysa.example/anam-llm' }]);
  assert.equal(calls[0].body.secret, anamLlmSecret(ME, KEY));
  const again = await ensureAnamLlm({ supabase: db, userId: ME, apiKey: KEY, appUrl: 'https://emysa.example', fetchImpl });
  assert.equal(again, 'llm-9');
  assert.equal(calls.length, 1);
});

test('anam-llm: refuses a request without the person’s secret', async () => {
  const res = fakeRes();
  await anamLlmRoute({ method: 'POST', headers: { authorization: 'Bearer wrong' }, body: { messages: [] } }, res, fakeDb(), {
    env: { ANAM_API_KEY: KEY }, generate: async () => ({ content: 'x' }),
  });
  assert.equal(res.code, 401);
});

test('anam-llm: streams the brain’s reply in OpenAI chunk format and strips control tags', async () => {
  const seen = [];
  const res = fakeRes();
  await anamLlmRoute({
    method: 'POST', headers: { authorization: `Bearer ${anamLlmSecret(ME, KEY)}` },
    body: { messages: [{ role: 'system', content: 'Say hi to Tunde.' }, { role: 'user', content: 'hello' }] },
  }, res, fakeDb({ profiles: [{ user_id: ME, language: 'en' }], contacts: [] }), {
    env: { ANAM_API_KEY: KEY },
    generate: async ({ messages }) => { seen.push(messages); return { content: 'Hi Tunde! [[MOOD:happy]]' }; },
  });
  assert.equal(res.code, 200);
  assert.equal(res.headers['Content-Type'], 'text/event-stream');
  const text = res.chunks.join('');
  assert.match(text, /"content":"Hi Tunde!"/);
  assert.equal(text.includes('MOOD'), false);
  assert.match(text, /data: \[DONE\]/);
  assert.match(seen[0][0].content, /.+/);
  assert.match(seen[0][1].content, /Say hi to Tunde/);
});

test('anam-voice: clones the recording at Anam and keeps its id for the person', async () => {
  const db = fakeDb({ profiles: [{ user_id: ME, name: 'Ariana Silver' }] });
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, body: init.body }); return { ok: true, status: 201, text: async () => JSON.stringify({ id: 'voice-7' }) }; };
  const res = fakeRes();
  await anamVoiceRoute({ method: 'POST', body: { sample: { type: 'audio/wav', data: Buffer.from('RIFFxxxx').toString('base64') } } }, res, db, ME, { env: { ANAM_API_KEY: KEY }, fetchImpl });
  assert.equal(res.code, 201);
  assert.equal(calls[0].url, 'https://api.anam.ai/v1/voices');
  assert.equal(calls[0].body.get('name'), 'Ariana Silver voice');
  assert.equal(db.tables.user_video_settings[0].anam_voice_id, 'voice-7');
});

test('anam-voice: refuses an empty or oversized recording without calling Anam', async () => {
  const res = fakeRes();
  await anamVoiceRoute({ method: 'POST', body: { sample: { data: '' } } }, res, fakeDb(), ME, { env: { ANAM_API_KEY: KEY }, fetchImpl: async () => { throw new Error('no'); } });
  assert.equal(res.code, 400);
  const big = fakeRes();
  await anamVoiceRoute({ method: 'POST', body: { sample: { data: Buffer.alloc(5 * 1024 * 1024).toString('base64') } } }, big, fakeDb(), ME, { env: { ANAM_API_KEY: KEY }, fetchImpl: async () => { throw new Error('no'); } });
  assert.equal(big.code, 400);
});
