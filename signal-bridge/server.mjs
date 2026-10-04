// Signal calling bridge. One signal-cli daemon (multi-account) + QR device linking + call control.
// Auth: every request needs the BRIDGE_SECRET (header x-bridge-secret, or ?key= for the /link page).
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import QRCode from 'qrcode';
import { attachAudio, attachAssistant } from './audio-bridge.mjs';

const PORT = Number(process.env.PORT || 8080);
const DATA = process.env.SIGNAL_DATA_DIR || '/data';
const SECRET = process.env.BRIDGE_SECRET;
const RPC_PORT = 7583;
const LINK_TIMEOUT_MS = 110_000; // the link QR is only valid for a short time
if (!SECRET) { console.error('BRIDGE_SECRET is required'); process.exit(1); }

const cli = (args) => new Promise((resolve, reject) =>
  execFile('signal-cli', ['--data-dir', DATA, ...args], { maxBuffer: 10 * 1024 * 1024 },
    (err, stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(stdout))));

async function listAccounts() {
  const out = await cli(['-o', 'json', 'listAccounts']);
  return JSON.parse(out || '[]').map((a) => a.number).filter(Boolean);
}

// ---------- daemon + JSON-RPC over TCP (a persistent connection is needed for call events) ----------
let daemon = null, sock = null, buf = '', nextId = 1;
const pending = new Map();
const calls = new Map(); // callId -> { audio, account }

function onLine(line) {
  if (!line.trim()) return;
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.id != null && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id); pending.delete(msg.id);
    return msg.error ? reject(new Error(msg.error.message || JSON.stringify(msg.error))) : resolve(msg.result);
  }
  if (msg.method === 'callEvent') handleCallEvent(msg.params?.result ?? msg.params);
}

function rpc(method, params = {}) {
  return new Promise((resolve, reject) => {
    if (!sock) return reject(new Error('signal daemon not connected'));
    const id = nextId++;
    pending.set(id, { resolve, reject });
    sock.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(() => { if (pending.delete(id)) reject(new Error(`rpc ${method} timed out`)); }, 30_000);
  });
}

function handleCallEvent(ev) {
  if (!ev) return;
  console.log('[callEvent]', JSON.stringify(ev));
  if (ev.state === 'CONNECTED' && !calls.get(ev.callId)?.audio) {
    try {
      const audio = attachAudio(ev);
      attachAssistant(audio);
      calls.set(ev.callId, { ...(calls.get(ev.callId) || {}), audio });
    } catch (e) { console.error('audio attach failed:', e.message); }
  }
  if (ev.state === 'ENDED') {
    calls.get(ev.callId)?.audio?.close();
    calls.delete(ev.callId);
  }
}

async function startDaemon() {
  if ((await listAccounts()).length === 0) return console.log('no linked accounts yet; daemon not started');
  stopDaemon();
  daemon = spawn('signal-cli', ['--data-dir', DATA, 'daemon', '--tcp', `127.0.0.1:${RPC_PORT}`, '--receive-mode', 'on-start'],
    { stdio: ['ignore', 'inherit', 'inherit'] });
  daemon.on('exit', (c) => { console.error('signal-cli daemon exited', c); daemon = null; sock = null; });
  for (let i = 0; i < 60; i++) { // wait for the TCP port
    await new Promise((r) => setTimeout(r, 1000));
    try {
      await new Promise((resolve, reject) => {
        const s = net.connect(RPC_PORT, '127.0.0.1', () => { sock = s; resolve(); });
        s.on('error', reject);
      });
      break;
    } catch { /* retry */ }
  }
  if (!sock) throw new Error('daemon did not open its RPC port');
  buf = '';
  sock.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { onLine(buf.slice(0, i)); buf = buf.slice(i + 1); } });
  sock.on('close', () => { sock = null; });
  await rpc('subscribeCallEvents'); // without this, call support is off
  console.log('daemon ready, call events subscribed');
}
function stopDaemon() { if (daemon) { daemon.removeAllListeners('exit'); daemon.kill('SIGTERM'); daemon = null; sock = null; } }

// ---------- device linking (QR) ----------
const links = new Map(); // id -> { status, uri, qr, number, error }

async function startLink() {
  const id = crypto.randomUUID();
  const before = new Set(await listAccounts());
  const entry = { status: 'pending', uri: null, qr: null };
  links.set(id, entry);
  const p = spawn('signal-cli', ['--data-dir', DATA, 'link', '-n', 'Live Call'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const timer = setTimeout(() => { if (entry.status === 'pending') { entry.status = 'expired'; p.kill('SIGTERM'); } }, LINK_TIMEOUT_MS);
  let out = '';
  const gotUri = new Promise((resolve) => {
    p.stdout.on('data', async (d) => {
      out += d;
      const m = out.match(/sgnl:\/\/linkdevice\?[^\s]+/);
      if (m && !entry.uri) { entry.uri = m[0]; entry.qr = await QRCode.toDataURL(entry.uri, { margin: 2, width: 360 }); resolve(); }
    });
    p.on('exit', resolve);
  });
  p.stderr.on('data', (d) => { out += d; });
  p.on('exit', async (code) => {
    clearTimeout(timer);
    if (entry.status !== 'pending') return;
    if (code === 0) {
      try {
        const after = await listAccounts();
        entry.number = after.find((n) => !before.has(n)) || null;
        entry.status = 'linked';
        await startDaemon(); // reload so the daemon sees the new account
      } catch (e) { entry.status = 'failed'; entry.error = e.message; }
    } else { entry.status = 'failed'; entry.error = out.slice(-300); }
  });
  await gotUri;
  if (!entry.uri) throw new Error('signal-cli did not print a link URI: ' + out.slice(-300));
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

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/healthz') return json(res, 200, { ok: true, daemon: !!sock });
    if (!authed(req, url)) return json(res, 401, { error: 'unauthorized' });
    if (req.method === 'GET' && url.pathname === '/link') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(LINK_PAGE); }
    if (req.method === 'POST' && url.pathname === '/signal/link/start') return json(res, 200, await startLink());
    const lm = url.pathname.match(/^\/signal\/link\/([\w-]+)$/);
    if (req.method === 'GET' && lm) { const l = links.get(lm[1]); return l ? json(res, 200, { status: l.status, number: l.number, error: l.error }) : json(res, 404, { error: 'unknown link id' }); }
    if (req.method === 'GET' && url.pathname === '/signal/accounts') return json(res, 200, { accounts: await listAccounts() });
    if (req.method === 'POST' && url.pathname === '/signal/calls') {
      const { account, to } = await readBody(req);
      if (!account || !to) return json(res, 400, { error: 'account and to are required' });
      const result = await rpc('startCall', { account, recipient: [to] });
      calls.set(result.callId, { account });
      return json(res, 200, result);
    }
    const dm = url.pathname.match(/^\/signal\/accounts\/(%2B\d+|\+\d+)$/);
    if (req.method === 'DELETE' && dm) {
      // Removes only this server's local copy. The user must also remove "Live Call"
      // under Signal > Settings > Linked devices on their phone.
      const number = decodeURIComponent(dm[1]);
      stopDaemon();
      try { await cli(['-a', number, 'deleteLocalAccountData', '--ignore-registered']); }
      finally { await startDaemon().catch((e) => console.error('daemon restart failed:', e.message)); }
      return json(res, 200, { ok: true });
    }
    const hm = url.pathname.match(/^\/signal\/calls\/(\d+)\/hangup$/);
    if (req.method === 'POST' && hm) {
      const call = calls.get(Number(hm[1]));
      await rpc('hangupCall', { account: call?.account, callId: Number(hm[1]) });
      return json(res, 200, { ok: true });
    }
    json(res, 404, { error: 'not found' });
  } catch (e) { console.error(e); json(res, 500, { error: e.message }); }
}).listen(PORT, () => { console.log('signal-bridge on', PORT); startDaemon().catch((e) => console.error('daemon start failed:', e.message)); });
