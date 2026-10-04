import { test, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { WebSocketServer } from 'ws';
import { decodeFrame, encodeFrame, FRAME } from '../signal-bridge/audio-bridge.mjs';
import { endStatus } from '../signal-bridge/call-status.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });
const root = path.resolve(import.meta.dirname, '..');

test('endStatus maps how a call ended', () => {
  assert.equal(endStatus({ connected: true, reason: 'remote_hangup' }), 'completed');
  assert.equal(endStatus({ connected: false, reason: 'rejected' }), 'declined');
  assert.equal(endStatus({ connected: false, reason: 'remote_busy' }), 'busy');
  assert.equal(endStatus({ connected: false, reason: 'internal_error' }), 'failed');
  assert.equal(endStatus({ connected: false, reason: 'ringrtc_hangup' }), 'no_answer');
});

// ---- harness: fake signal-cli + fake audio tools + fake assistant + fake app callback ----
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sigbridge-'));
const bin = path.join(tmp, 'bin'); fs.mkdirSync(bin);
const rpcLog = path.join(tmp, 'rpc.jsonl'); fs.writeFileSync(rpcLog, '');
const played = path.join(tmp, 'played.raw');
const sh = (name, body) => { fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 }); };
sh('signal-cli', `exec node ${path.join(root, 'tests/fixtures/fake-signal-cli.mjs')} "$@"`);
sh('parecord', `exec node -e "setInterval(()=>process.stdout.write(Buffer.alloc(1920,1)),20)"`);
sh('pacat', `exec sh -c 'cat >> "${played}"'`);
const rpcCalls = () => fs.readFileSync(rpcLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));

const reports = [];
const app = http.createServer((req, res) => {
  let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => {
    reports.push({ url: req.url, secret: req.headers['x-relay-secret'], body: JSON.parse(b || '{}') });
    res.writeHead(200); res.end('{}');
  });
}).listen(0);

const acaf = { hellos: [], audioIn: [], controls: [], conns: [] };
const wss = new WebSocketServer({ port: 0 });
wss.on('connection', (ws) => {
  acaf.conns.push(ws);
  ws.on('message', (data, isBinary) => {
    if (isBinary) return acaf.audioIn.push(decodeFrame(Buffer.from(data)));
    const m = JSON.parse(String(data));
    if (m.type === 'hello') { acaf.hellos.push(m); ws.send(JSON.stringify({ type: 'ready', sessionId: m.sessionId })); } else acaf.controls.push(m);
  });
});

const bridgePort = await freePort();
const rpcPort = await freePort();
const bridge = spawn('node', [path.join(root, 'signal-bridge/server.mjs')], {
  env: {
    ...process.env, PATH: `${bin}:${process.env.PATH}`, PORT: String(bridgePort), SIGNAL_RPC_PORT: String(rpcPort),
    SIGNAL_DATA_DIR: tmp, BRIDGE_SECRET: 'bs', ASSISTANT_MODE: 'acaf',
    ASSISTANT_BRIDGE_URL: `ws://127.0.0.1:${wss.address().port}/stream`, ASSISTANT_BRIDGE_SECRET: 'as',
    APP_API_URL: `http://127.0.0.1:${app.address().port}`, RELAY_CALLBACK_SECRET: 'cs', FAKE_RPC_LOG: rpcLog,
  },
  stdio: ['ignore', 'ignore', 'inherit'],
});
after(() => { bridge.kill('SIGTERM'); wss.close(); app.close(); });

const api = async (method, p, body) => {
  const r = await fetch(`http://127.0.0.1:${bridgePort}${p}`, { method, headers: { 'x-bridge-secret': 'bs', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
for (let i = 0; i < 60; i++) { try { if ((await (await fetch(`http://127.0.0.1:${bridgePort}/healthz`)).json()).daemon) break; } catch { /* starting */ } await sleep(250); }

test('rejects calls without the secret', async () => {
  const r = await fetch(`http://127.0.0.1:${bridgePort}/signal/accounts`);
  assert.equal(r.status, 401);
});

test('QR link: start -> pending -> linked with the number from finishLink (no daemon restart)', async () => {
  const start = await api('POST', '/signal/link/start');
  assert.match(start.body.qr, /^data:image\/png;base64,/);
  assert.match(start.body.uri, /^sgnl:\/\/linkdevice/);
  assert.equal((await api('GET', `/signal/link/${start.body.id}`)).body.status, 'pending');
  await sleep(1600);
  const done = (await api('GET', `/signal/link/${start.body.id}`)).body;
  assert.deepEqual([done.status, done.number], ['linked', '+2348012345678']);
  assert.deepEqual((await api('GET', '/signal/accounts')).body.accounts, ['+2348012345678']);
  assert.equal(rpcCalls().filter((c) => c.method === 'subscribeCallEvents').length, 1, 'daemon was not restarted');
});

test('answered call: reports answered, speaks ACAF, assistant hangup ends it and reports completed', async () => {
  const placed = await api('POST', '/signal/calls', { account: '+2348012345678', to: '+answer', userId: 'user-7' });
  assert.equal(placed.status, 200);
  const id = String(placed.body.callId);
  await sleep(900);
  assert.equal(acaf.hellos.at(-1).sessionId, `call-${id}`);
  assert.equal(acaf.hellos.at(-1).platform, 'signal');
  assert.equal(acaf.hellos.at(-1).secret, 'as');
  assert.equal(acaf.hellos.at(-1).userId, 'user-7');
  assert.ok(acaf.audioIn.length > 5, 'caller audio reaches the assistant');
  assert.ok(reports.some((r) => r.body.platformCallId === id && r.body.status === 'answered'));
  assert.equal(reports[0].url, '/api/social-calling?action=relay-call-status');
  assert.equal(reports[0].secret, 'cs');

  const ws = acaf.conns.at(-1); fs.writeFileSync(played, '');
  ws.send(encodeFrame({ type: FRAME.AUDIO_OUT, sampleRate: 16000, sequence: 0, timestampMs: Date.now(), payload: Buffer.alloc(3200, 2) }));
  await sleep(250);
  assert.ok(fs.statSync(played).size > 0, 'assistant speech is written to the call');

  ws.send(JSON.stringify({ type: 'hangup' })); // the assistant decides the call is over
  await sleep(600);
  assert.ok(rpcCalls().some((c) => c.method === 'hangupCall' && String(c.params.callId) === id && c.params.account === '+2348012345678'));
  const end = reports.filter((r) => r.body.platformCallId === id).at(-1).body;
  assert.equal(end.status, 'completed');
  assert.equal(end.platform, 'signal');
  assert.ok(acaf.controls.some((m) => m.type === 'hangup'));
});

test('declined call reports declined; an event that beats the startCall response is not lost', async () => {
  const a = await api('POST', '/signal/calls', { account: '+2348012345678', to: '+reject' });
  await sleep(500);
  assert.equal(reports.filter((r) => r.body.platformCallId === String(a.body.callId)).at(-1).body.status, 'declined');
  const b = await api('POST', '/signal/calls', { account: '+2348012345678', to: '+earlyend' });
  await sleep(300);
  assert.equal(reports.filter((r) => r.body.platformCallId === String(b.body.callId)).at(-1).body.status, 'failed');
});

test('incoming calls are declined, not left ringing', async () => {
  const s = net.connect(rpcPort, '127.0.0.1'); // a second client of the fake daemon triggers the incoming call
  await new Promise((r) => s.once('connect', r));
  s.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'testIncoming', params: {} }) + '\n');
  await sleep(500); s.destroy();
  assert.ok(rpcCalls().some((c) => c.method === 'rejectCall' && c.params.callId === 777 && c.params.account === '+2348012345678'));
});

test('unknown account -> 404; removing an account uses deleteLocalAccountData without restarting', async () => {
  assert.equal((await api('POST', '/signal/calls', { account: '+999', to: '+answer' })).status, 404);
  assert.equal((await api('DELETE', `/signal/accounts/${encodeURIComponent('+2348012345678')}`)).status, 200);
  const del = rpcCalls().find((c) => c.method === 'deleteLocalAccountData');
  assert.deepEqual([del.params.account, del.params.ignoreRegistered], ['+2348012345678', true]);
  assert.deepEqual((await api('GET', '/signal/accounts')).body.accounts, []);
});
