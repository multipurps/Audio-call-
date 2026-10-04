// Signal calling bridge: one signal-cli daemon (multi-account), QR device linking over its
// JSON-RPC (no restarts), call control, and the audio link to the Pipecat assistant.
// Auth: every request needs BRIDGE_SECRET (header x-bridge-secret, or ?key= for /link).
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import QRCode from 'qrcode';
import { attachAudio, attachEcho, connectAssistant } from './audio-bridge.mjs';
import { endStatus } from './call-status.mjs';

const PORT = Number(process.env.PORT || 8080);
const DATA = process.env.SIGNAL_DATA_DIR || '/data';
const SECRET = process.env.BRIDGE_SECRET;
const RPC_PORT = Number(process.env.SIGNAL_RPC_PORT || 7583);
const MODE = process.env.ASSISTANT_MODE || 'acaf'; // 'acaf' (Pipecat) or 'echo' (audio-path test)
const ASSISTANT_URL = process.env.ASSISTANT_BRIDGE_URL;
const ASSISTANT_SECRET = process.env.ASSISTANT_BRIDGE_SECRET;
const APP_URL = (process.env.APP_API_URL || '').replace(/\/$/, '');
const CALLBACK_SECRET = process.env.RELAY_CALLBACK_SECRET || ASSISTANT_SECRET;
const LINK_TIMEOUT_MS = 110_000; // the link QR is only valid for a short time
if (!SECRET) { console.error('BRIDGE_SECRET is required'); process.exit(1); }

// ---------- daemon + JSON-RPC over one persistent TCP connection ----------
let daemon = null, sock = null, buf = '', nextId = 1, shuttingDown = false;
const pending = new Map();
const early = new Map(); // callId -> events that arrived before startCall returned
const calls = new Map(); // callId(string) -> { account, userId, audio, link, state, connectedAt, reported, devices }

function onLine(line) {
  if (!line.trim()) return;
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.id != null && pending.has(msg.id)) {
    const { resolve, reject, timer } = pending.get(msg.id); pending.delete(msg.id); clearTimeout(timer);
    return msg.error ? reject(new Error(msg.error.message || JSON.stringify(msg.error))) : resolve(msg.result);
  }
  if (msg.method === 'callEvent') handleCallEvent(msg.params?.result ?? msg.params).catch((e) => console.error('callEvent failed:', e.message));
}

function rpc(method, params = {}, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    if (!sock) return reject(Object.assign(new Error('signal daemon not connected'), { statusCode: 503 }));
    const id = nextId++;
    const timer = setTimeout(() => { if (pending.delete(id)) reject(new Error(`rpc ${method} timed out`)); }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    sock.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
const accountsList = async () => ((await rpc('listAccounts')) || []).map((a) => a.number).filter(Boolean);

async function connectRpc() {
  for (let i = 0; i < 90; i++) { // the JVM takes a while to open its port
    try {
      await new Promise((resolve, reject) => {
        const s = net.connect(RPC_PORT, '127.0.0.1', () => { sock = s; resolve(); });
        s.once('error', reject);
      });
      sock.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { onLine(buf.slice(0, i)); buf = buf.slice(i + 1); } });
      sock.on('close', () => { sock = null; });
      sock.on('error', () => {});
      return;
    } catch { await new Promise((r) => setTimeout(r, 1000)); }
  }
  throw new Error('daemon did not open its RPC port');
}

async function startDaemon() {
  daemon = spawn('signal-cli', ['--data-dir', DATA, 'daemon', '--tcp', `127.0.0.1:${RPC_PORT}`, '--receive-mode', 'on-start'],
    { stdio: ['ignore', 'inherit', 'inherit'] });
  daemon.on('exit', async (code) => {
    console.error('signal-cli daemon exited', code);
    daemon = null; sock = null; buf = '';
    for (const [id, c] of calls) await finishCall(id, c, { reason: 'bridge_restart' }); // the calls died with it
    for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(new Error('signal daemon restarted')); }
    pending.clear();
    if (!shuttingDown) setTimeout(() => startDaemon().catch((e) => console.error('daemon restart failed:', e.message)), 3000);
  });
  await connectRpc();
  await rpc('subscribeCallEvents'); // without this, call support is off
  console.log('daemon ready, call events subscribed');
}

// ---------- reporting a call's state to the app ----------
async function report(callId, body) {
  if (!APP_URL || !CALLBACK_SECRET) return;
  try {
    await fetch(`${APP_URL}/api/social-calling?action=relay-call-status`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-relay-secret': CALLBACK_SECRET },
      body: JSON.stringify({ platform: 'signal', platformCallId: String(callId), ...body }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) { console.error('status report failed:', e.message); }
}

async function finishCall(callId, c, { reason } = {}) {
  if (c.reported) return;
  c.reported = true;
  try { c.link?.close(); } catch { /* ignore */ }
  try { c.audio?.close(); } catch { /* ignore */ }
  calls.delete(callId);
  const connected = !!c.connectedAt;
  await report(callId, {
    status: endStatus({ connected, reason }),
    reason: reason || null,
    durationSeconds: connected ? Math.round((Date.now() - c.connectedAt) / 1000) : 0,
  });
}

async function hangup(account, callId) {
  try { await rpc('hangupCall', { account, callId: Number(callId) }); } catch (e) { console.error('hangupCall failed:', e.message); }
}

async function handleCallEvent(ev) {
  if (!ev || ev.callId == null) return;
  const id = String(ev.callId);
  console.log('[callEvent]', JSON.stringify(ev));
  let c = calls.get(id);

  // Someone is calling one of our linked accounts. Nobody is there to answer, so decline it
  // instead of leaving a tunnel and audio devices ringing for a minute.
  if (!c && ev.state === 'RINGING_INCOMING') {
    for (const account of await accountsList().catch(() => [])) {
      const live = await rpc('listCalls', { account }).catch(() => []);
      if ((live || []).some((x) => String(x.callId) === id)) {
        await rpc('rejectCall', { account, callId: Number(id) }).catch((e) => console.error('rejectCall failed:', e.message));
        break;
      }
    }
    return;
  }
  if (!c) { // usually an event that beat the startCall response: keep it briefly and replay
    const list = early.get(id) || [];
    list.push(ev); early.set(id, list);
    setTimeout(() => early.delete(id), 15_000).unref();
    return;
  }

  if (ev.inputDeviceName) c.devices = { inputDeviceName: ev.inputDeviceName, outputDeviceName: ev.outputDeviceName };
  c.state = ev.state;

  if (ev.state === 'CONNECTED' && !c.connectedAt) {
    c.connectedAt = Date.now();
    report(id, { status: 'answered' });
    try {
      c.audio = attachAudio({ callId: id, ...(c.devices || {}) });
      if (MODE === 'echo') {
        c.link = attachEcho(c.audio);
      } else {
        if (!ASSISTANT_URL || !ASSISTANT_SECRET) throw new Error('ASSISTANT_BRIDGE_URL / ASSISTANT_BRIDGE_SECRET are not set');
        c.link = connectAssistant({
          url: ASSISTANT_URL, secret: ASSISTANT_SECRET, callId: id, userId: c.userId, audio: c.audio,
          onHangup: () => hangup(c.account, id),                 // the assistant decided the call is over
          onFatal: () => hangup(c.account, id),                  // assistant unreachable: do not leave a silent call open
        });
      }
    } catch (e) {
      console.error('could not start call audio:', e.message);
      await hangup(c.account, id);
    }
  }
  if (ev.state === 'ENDED') await finishCall(id, c, { reason: ev.reason });
}

// ---------- device linking (QR) over the daemon's JSON-RPC ----------
const links = new Map(); // id -> { status, uri, qr, number, error }

async function startLink() {
  const { deviceLinkUri } = await rpc('startLink', {}, 20_000);
  const id = crypto.randomUUID();
  const entry = { status: 'pending', uri: deviceLinkUri, qr: await QRCode.toDataURL(deviceLinkUri, { margin: 2, width: 360 }) };
  links.set(id, entry);
  const timer = setTimeout(() => { if (entry.status === 'pending') entry.status = 'expired'; }, LINK_TIMEOUT_MS);
  // finishLink blocks until the QR is scanned. Concurrent links are independent, and the
  // account number comes straight from the result - no guessing from account lists.
  rpc('finishLink', { deviceLinkUri, deviceName: 'Live Call' }, LINK_TIMEOUT_MS + 20_000)
    .then((r) => {
      if (entry.status !== 'pending') return; // already expired
      if (!r?.number) { entry.status = 'failed'; entry.error = 'linked but no account number returned'; return; }
      entry.number = r.number; entry.status = 'linked';
    })
    .catch((e) => { if (entry.status === 'pending') { entry.status = /timed out/i.test(e.message) ? 'expired' : 'failed'; entry.error = e.message; } })
    .finally(() => clearTimeout(timer));
  return { id, ...entry };
}

// ---------- HTTP ----------
const authed = (req, url) => {
  const given = req.headers['x-bridge-secret'] || url.searchParams.get('key') || '';
  const a = Buffer.from(String(given)), b = Buffer.from(SECRET);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};
const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const readBody = (req) => new Promise((resolve) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } }); });

const LINK_PAGE = `<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><title>Link Signal</title>
<body style="font-family:system-ui;text-align:center;padding:24px"><h2>Link your Signal account</h2>
<p>On your phone: Signal &rarr; Settings &rarr; Linked devices &rarr; + &rarr; scan this code.</p>
<img id=qr width=300 height=300 alt="" style="display:none"><p id=s>Preparing&hellip;</p>
<script>
const key=new URLSearchParams(location.search).get('key');const H={'x-bridge-secret':key};
async function go(){const r=await fetch('/signal/link/start',{method:'POST',headers:H});const d=await r.json();
if(!d.qr){s.textContent='Error: '+(d.error||'unknown');return}
qr.src=d.qr;qr.style.display='block';s.textContent='Waiting for scan (about 2 minutes)...';
const t=setInterval(async()=>{const x=await (await fetch('/signal/link/'+d.id,{headers:H})).json();
if(x.status==='linked'){clearInterval(t);qr.style.display='none';s.textContent='Linked'+(x.number?': '+x.number:'')+' - you can close this page.'}
else if(x.status!=='pending'){clearInterval(t);qr.style.display='none';s.innerHTML='Link '+x.status+'. <a href="">Try again</a>'}},2000)}
go();</script></body>`;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/healthz') return json(res, 200, { ok: true, daemon: !!sock, activeCalls: calls.size, mode: MODE });
    if (!authed(req, url)) return json(res, 401, { error: 'unauthorized' });
    if (req.method === 'GET' && url.pathname === '/link') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(LINK_PAGE); }
    if (req.method === 'POST' && url.pathname === '/signal/link/start') return json(res, 200, await startLink());
    const lm = url.pathname.match(/^\/signal\/link\/([\w-]+)$/);
    if (req.method === 'GET' && lm) { const l = links.get(lm[1]); return l ? json(res, 200, { status: l.status, number: l.number, error: l.error }) : json(res, 404, { error: 'unknown link id' }); }
    if (req.method === 'GET' && url.pathname === '/signal/accounts') return json(res, 200, { accounts: await accountsList() });

    const dm = url.pathname.match(/^\/signal\/accounts\/([^/]+)$/);
    if (req.method === 'DELETE' && dm) {
      // Removes only this server's copy, with no daemon restart. The user should also remove
      // "Live Call" under Signal > Settings > Linked devices on their phone.
      const number = decodeURIComponent(dm[1]);
      if ([...calls.values()].some((c) => c.account === number)) return json(res, 409, { error: 'a call is in progress on this account' });
      await rpc('deleteLocalAccountData', { account: number, ignoreRegistered: true }, 60_000);
      return json(res, 200, { ok: true });
    }

    if (req.method === 'POST' && url.pathname === '/signal/calls') {
      const { account, to, userId } = await readBody(req);
      if (!account || !to) return json(res, 400, { error: 'account and to are required' });
      if (!(await accountsList()).includes(account)) return json(res, 404, { error: 'unknown account' });
      const r = await rpc('startCall', { account, recipient: [String(to)] }, 40_000);
      const id = String(r.callId);
      if (!calls.has(id)) calls.set(id, { account, userId: userId || null, state: r.state, reported: false });
      else Object.assign(calls.get(id), { account, userId: userId || null });
      const buffered = early.get(id) || []; early.delete(id);
      for (const ev of buffered) await handleCallEvent(ev);
      return json(res, 200, { callId: r.callId, state: r.state });
    }
    const hm = url.pathname.match(/^\/signal\/calls\/(\d+)\/hangup$/);
    if (req.method === 'POST' && hm) {
      const c = calls.get(hm[1]);
      if (!c) return json(res, 200, { ok: true, alreadyEnded: true });
      await rpc('hangupCall', { account: c.account, callId: Number(hm[1]) });
      return json(res, 200, { ok: true });
    }
    json(res, 404, { error: 'not found' });
  } catch (e) { console.error(e); json(res, e.statusCode || 500, { error: e.message }); }
});

server.listen(PORT, () => { console.log('signal-bridge on', PORT); startDaemon().catch((e) => console.error('daemon start failed:', e.message)); });
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { shuttingDown = true; daemon?.kill('SIGTERM'); server.close(); setTimeout(() => process.exit(0), 500); });
