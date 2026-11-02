// Runs the Wacalls site on Fly.io: serves the static files and the Vercel-style handlers in api/.
// Same routes as vercel.json. Listens on 0.0.0.0:$PORT (fly.toml: internal_port 8080).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8080;

// Folders / files that are never served as static files (Vercel does not serve api/ either).
const DENY = new Set(['api', 'node_modules', 'server', 'server-social', 'signal-bridge', 'pipecat-service', 'telegram-call-bridge',
  'tests', 'scripts', 'sql', 'package.json', 'package-lock.json', 'Dockerfile', 'fly.toml', 'fly-server.mjs', 'vercel.json', 'LICENSE', 'README.md']);
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.mp4': 'video/mp4', '.webm': 'video/webm', '.txt': 'text/plain; charset=utf-8',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.map': 'application/json',
};
const GZIP = new Set(['.html', '.js', '.mjs', '.css', '.json', '.svg', '.txt', '.webmanifest']);

const handlers = new Map(); // api name -> { handler, config }
async function loadHandler(name) {
  if (!/^[a-z0-9-]+$/i.test(name)) return null;
  if (handlers.has(name)) return handlers.get(name);
  const file = path.join(ROOT, 'api', `${name}.js`);
  if (!fs.existsSync(file)) return null;
  const mod = await import(pathToFileURL(file).href);
  const entry = { handler: mod.default, config: mod.config || {} };
  handlers.set(name, entry);
  return entry;
}

function decorate(res) {
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (obj) => { if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(obj)); return res; };
  res.send = (body) => {
    if (body !== null && typeof body === 'object' && !Buffer.isBuffer(body)) return res.json(body);
    res.end(body); return res;
  };
  res.redirect = (a, b) => { const [code, url] = typeof a === 'number' ? [a, b] : [307, a]; res.statusCode = code; res.setHeader('Location', url); res.end(); return res; };
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks);
}
function parseBody(buf, type = '') {
  if (!buf.length) return undefined;
  const t = type.split(';')[0].trim().toLowerCase();
  if (t === 'application/json') { try { return JSON.parse(buf.toString('utf8')); } catch { return {}; } }
  if (t === 'application/x-www-form-urlencoded') return Object.fromEntries(new URLSearchParams(buf.toString('utf8')));
  if (t.startsWith('text/')) return buf.toString('utf8');
  return buf;
}

async function runApi(name, url, extraQuery, req, res) {
  const entry = await loadHandler(name);
  if (!entry) { res.statusCode = 404; res.setHeader('Content-Type', 'application/json'); res.end('{"error":"Not found"}'); return; }
  decorate(res);
  const query = {};
  for (const [k, v] of url.searchParams) query[k] = k in query ? [].concat(query[k], v) : v;
  Object.assign(query, extraQuery);
  req.query = query;
  if (entry.config?.api?.bodyParser !== false && !['GET', 'HEAD'].includes(req.method)) {
    const buf = await readBody(req);
    req.rawBody = buf;
    req.body = parseBody(buf, req.headers['content-type']);
  }
  try {
    await entry.handler(req, res);
  } catch (err) {
    console.error(`api/${name} failed:`, err);
    if (!res.headersSent) { res.statusCode = 500; res.setHeader('Content-Type', 'application/json'); res.end('{"error":"Server error"}'); }
    else res.end();
  }
}

function serveStatic(pathname, req, res) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { res.statusCode = 400; res.end(); return; }
  if (rel === '/') rel = '/home.html';
  const abs = path.normalize(path.join(ROOT, rel));
  if (!abs.startsWith(ROOT + path.sep)) { res.statusCode = 403; res.end(); return; }
  const parts = path.relative(ROOT, abs).split(path.sep);
  if (parts.some((p) => p.startsWith('.')) || DENY.has(parts[0])) { res.statusCode = 404; res.end('Not found'); return; }
  let file = abs;
  try { if (fs.statSync(file).isDirectory()) file = path.join(file, 'index.html'); } catch { res.statusCode = 404; res.end('Not found'); return; }
  let stat;
  try { stat = fs.statSync(file); } catch { res.statusCode = 404; res.end('Not found'); return; }
  const ext = path.extname(file).toLowerCase();
  res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
  const relFile = path.relative(ROOT, file).split(path.sep).join('/');
  if (/^(index\.html|home\.html|admin\/.*\.html)$/.test(relFile) || relFile === 'sw.js' || relFile === 'version.json') res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  else if (relFile.startsWith('assets/call/')) res.setHeader('Cache-Control', 'public, max-age=604800, stale-while-revalidate=86400');
  else res.setHeader('Cache-Control', 'public, max-age=300');
  if (req.method === 'HEAD') { res.setHeader('Content-Length', stat.size); res.end(); return; }
  if (GZIP.has(ext) && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
    res.setHeader('Content-Encoding', 'gzip'); res.setHeader('Vary', 'Accept-Encoding');
    fs.createReadStream(file).pipe(zlib.createGzip()).pipe(res);
  } else {
    res.setHeader('Content-Length', stat.size);
    fs.createReadStream(file).pipe(res);
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    if (p === '/healthz') { res.setHeader('Content-Type', 'text/plain'); res.end('ok'); return; }
    // Same rewrites as vercel.json
    if (/^\/anam-llm(\/v1\/chat\/completions)?$/.test(p)) return await runApi('assistant', url, { action: 'anam-llm' }, req, res);
    if (p === '/api/bachs-webhook') return await runApi('referrals', url, { action: 'webhook' }, req, res);
    if (p === '/landing.html') { res.statusCode = 308; res.setHeader('Location', '/'); res.end(); return; }
    const m = p.match(/^\/api\/([a-z0-9-]+)\/?$/i);
    if (m) return await runApi(m[1], url, {}, req, res);
    if (!['GET', 'HEAD'].includes(req.method)) { res.statusCode = 405; res.end('Method not allowed'); return; }
    serveStatic(p, req, res);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) { res.statusCode = 500; res.end('Server error'); } else res.end();
  }
});
server.keepAliveTimeout = 65_000;
server.listen(PORT, '0.0.0.0', () => console.log(`Wacalls listening on 0.0.0.0:${PORT}`));
