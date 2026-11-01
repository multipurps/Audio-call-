import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { sheet, confirmSheet, promptSheet, successSheet, errorSheet } from '../lib/statusSheet.js';
import { relTime, statusOf, channelName, dur, pctLabel, trendDir, chartGeometry, compact, hueOf, initialOf } from './ui.js?v=2026-10-31.1';
import { loadAiBehavior } from './aiBehavior.js?v=2026-10-31.1';
import { loadTrainerCall, stopTrainerCall } from './trainerCall.js?v=2026-10-31.1';

const SUPABASE_URL = 'https://gucblbvfzuraaozswfwd.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imd1Y2JsYnZmenVyYWFvenN3ZndkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU0NzQ0ODQsImV4cCI6MjA5MTA1MDQ4NH0.OCsEC_FfOJmoL5sQWP8zYnw9SmWuy4xggfcpIIxQw-c';
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const $ = (id) => document.getElementById(id);
let currentSession = null;

async function authedFetch(url, options = {}) {
  const headers = { ...(options.headers || {}), Authorization: `Bearer ${currentSession?.access_token || ''}` };
  return fetch(url, { ...options, headers });
}

$('authSubmit').addEventListener('click', async () => {
  const email = $('authEmail').value.trim();
  const password = $('authPassword').value;
  if (!email || !password) { $('authHint').textContent = 'Enter an email and password.'; return; }
  $('authHint').textContent = 'Working...';
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) $('authHint').textContent = error.message;
});

$('signOutBtn').addEventListener('click', () => supabase.auth.signOut());
$('notAdminSignOut').addEventListener('click', () => supabase.auth.signOut());

// Locked to whichever Google account's email matches ADMIN_EMAIL — the
// server-side check in requireAdmin() (used by every /api/admin-* route,
// and by enterAdmin() below to gate this page) is the real enforcement.
// Any other Google account just lands on the "Not an admin account" screen.
$('googleSignIn').addEventListener('click', () => {
  supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: window.location.origin + window.location.pathname },
  });
});

// Resuming a minimized app makes supabase-js emit SIGNED_IN / TOKEN_REFRESHED again. For the person who
// is already inside the panel that must not re-run start-up, which would jump back to Overview (and stop
// a live Call Emysa session). enteredFor is the user the panel is currently showing.
let enteredFor = null;
const alreadyInPanel = (session) => Boolean(session?.user && enteredFor === session.user.id && !$('adminApp').classList.contains('hidden'));

supabase.auth.onAuthStateChange((_event, session) => {
  currentSession = session;
  if (alreadyInPanel(session)) return;
  if (session?.user) enterAdmin();
  else { enteredFor = null; showSignInForm(); }
});

let myRole = null;

// Not an admin (yet): say where this account stands, and let it ask.
function showNotAdmin(access) {
  enteredFor = null;
  const status = access?.status || 'none';
  const copy = {
    none: ['Not an admin yet', 'This account is not an admin. You can ask the owner for access.'],
    pending: ['Request sent', 'The owner has to approve it. Tap Check again once they have.'],
    revoked: ['Access removed', "The owner removed this account's admin access."],
    unverified: ['Confirm your email', 'The owner approved this email address, but it has not been confirmed. Confirm it, then sign in again.'],
  }[status] || ['Not an admin account', 'This account is not an admin.'];
  $('authBoot').classList.add('hidden');
  $('authBox').classList.add('hidden');
  $('adminApp').classList.add('hidden');
  document.getElementById('authScreen').classList.remove('hidden');
  $('notAdminBox').classList.remove('hidden');
  $('notAdminTitle').textContent = copy[0];
  $('notAdminText').textContent = copy[1];
  $('requestAccessBtn').style.display = status === 'none' ? '' : 'none';
  $('checkAccessBtn').style.display = status === 'pending' || status === 'unverified' ? '' : 'none';
  $('notAdminHint').textContent = '';
}

$('requestAccessBtn').addEventListener('click', async () => {
  $('requestAccessBtn').disabled = true;
  $('notAdminHint').textContent = 'Sending…';
  try {
    const r = await api('request-access', { method: 'POST', body: {} });
    showNotAdmin({ status: r.status });
  } catch (err) { $('notAdminHint').textContent = err.message; }
  finally { $('requestAccessBtn').disabled = false; }
});
$('checkAccessBtn').addEventListener('click', () => { $('notAdminHint').textContent = 'Checking…'; enterAdmin(); });

async function enterAdmin() {
  try {
    // The server decides who is an admin (the owner, or an account the owner
    // approved); this page only reflects its answer.
    const resp = await withTimeout(authedFetch('/api/admin?action=access-status'), 10000);
    $('authBoot').classList.add('hidden');
    $('authBox').classList.add('hidden');
    if (!resp.ok) { showNotAdmin({ status: 'none' }); return; }
    const access = await resp.json();
    if (!access.role) { showNotAdmin(access); return; }
    myRole = access.role;
    // Approving other admins is the one thing only the owner can do.
    $('navAdmins').style.display = myRole === 'owner' ? '' : 'none';
    $('navKeys').style.display = myRole === 'owner' ? '' : 'none';
    // Anyone else the owner approves is an investor with read-only access: the server only answers
    // INVESTOR_ACTIONS for them, and the menu only offers those sections.
    document.querySelectorAll('#aDrawer .nav[data-s]').forEach((el) => {
      if (myRole !== 'owner' && !INVESTOR_SECTIONS.includes(el.dataset.s)) el.style.display = 'none';
    });
    let users = [];
    if (myRole === 'owner') {
      const usersResp = await withTimeout(authedFetch('/api/admin?action=list-users'), 15000);
      if (!usersResp.ok) throw new Error(`Could not load the admin panel (${usersResp.status}).`);
      users = (await usersResp.json()).users;
    }
    $('notAdminBox').classList.add('hidden');
    document.getElementById('authScreen').classList.add('hidden');
    $('adminApp').classList.remove('hidden');
    enteredFor = currentSession?.user?.id || null;
    initPanel(users);
  } catch (err) {
    // A thrown error in here used to leave the splash screen stuck forever
    // with zero feedback — any network hiccup on the first fetch, and
    // nothing after that line ever ran. Now it surfaces instead of hanging.
    if (err?.message === 'TIMEOUT') {
      showBootError(new Error('The admin check timed out.'), true);
    } else {
      showBootError(err);
    }
  }
}

// ---------- panel shell ----------
// The admin follows the theme chosen in the app (dark, cream or white); dark when none was chosen.
try { const t = localStorage.getItem('theme'); document.documentElement.setAttribute('data-theme', t === 'cream' || t === 'white' ? t : 'dark'); }
catch { document.documentElement.setAttribute('data-theme', 'dark'); }
const isPWA = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
const fitHeight = () => { if (isPWA && window.screen.height) document.body.style.height = `${window.screen.height}px`; };
fitHeight(); window.addEventListener('resize', fitHeight);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
async function api(action, { method = 'GET', body, qs = '' } = {}) {
  const resp = await authedFetch(`/api/admin?action=${action}${qs}`, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data.error || `Request failed (${resp.status})`);
  return data;
}
const money = (n, cur = 'USD') => { try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: cur, maximumFractionDigits: 2 }).format(n || 0); } catch { return `${cur} ${(n || 0).toFixed(2)}`; } };
const num = (n) => Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 1 });
const card = (l, v, s = '', wide = false) => `<div class="aCard${wide ? ' wide' : ''}"><div class="l">${l}</div><div class="v">${v}</div><div class="s">${s}</div></div>`;
const fail = (el, err) => { el.innerHTML = `<div class="aHint">${esc(err.message)}</div>`; };

let range = 30, usersCache = [], current = 'overview';
// What a read-only (investor) admin may open. Must match INVESTOR_ACTIONS in api/admin.js.
const INVESTOR_SECTIONS = ['overview', 'usage', 'costs'];
const canOpen = (name) => Boolean(loaders[name]) && (myRole === 'owner' || INVESTOR_SECTIONS.includes(name));
const TITLES = { overview: 'Overview', users: 'Users', usage: 'Usage', credits: 'Credits', costs: 'Costs & providers', ai: 'AI behavior', train: 'Call Emysa', content: 'Content & push', admins: 'Admins' };
const loaders = { overview: loadOverview, users: loadUsers, usage: loadUsage, credits: loadCredits, costs: loadCosts, keys: loadKeys, ai: () => loadAiBehavior($('sec-ai'), { api, esc }), train: () => loadTrainerCall($('sec-train'), { api, esc, supabase }), content: loadBackgrounds, admins: loadAdmins };

const SECTION_KEY = 'adminSection';
function openSection(name) {
  if (!canOpen(name)) name = 'overview';
  if (current === 'train' && name !== 'train') stopTrainerCall();
  current = name;
  try { localStorage.setItem(SECTION_KEY, name); } catch { /* private mode: it just will not be remembered */ }
  $('adminApp').classList.remove('open');
  document.querySelectorAll('.aSec').forEach((el) => el.classList.toggle('on', el.id === `sec-${name}`));
  document.querySelectorAll('#aDrawer .nav[data-s]').forEach((el) => el.classList.toggle('on', el.dataset.s === name));
  $('aTitle').textContent = TITLES[name];
  $('aChips').style.display = name === 'overview' || name === 'usage' ? '' : 'none';
  closeDetail();
  loaders[name]();
  syncLive();
}
function initPanel(users) {
  usersCache = users;
  $('menuBtn').onclick = () => $('adminApp').classList.add('open');
  $('aScrim').onclick = () => $('adminApp').classList.remove('open');
  $('refreshBtn').onclick = () => { loaders[current](); refreshLive(); };
  $('dBack').onclick = closeDetail;
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { refreshLive(); } syncLive(); });
  document.querySelectorAll('#aDrawer .nav[data-s]').forEach((el) => { el.onclick = () => openSection(el.dataset.s); });
  document.querySelectorAll('#aChips button').forEach((el) => {
    el.onclick = () => {
      range = Number(el.dataset.d);
      document.querySelectorAll('#aChips button').forEach((b) => b.classList.toggle('on', b === el));
      loaders[current]();
    };
  });
  // Back where they left off (a reload after the phone discarded the page lands here too).
  let saved = null;
  try { saved = localStorage.getItem(SECTION_KEY); } catch { /* ignore */ }
  openSection(saved && canOpen(saved) ? saved : 'overview');
}
const emailOf = (id) => usersCache.find((u) => u.id === id)?.email || id.slice(0, 8);

// ---------- overview: everything here is real, read from your database ----------
const ICON = {
  up: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/></svg>',
  down: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7l6 6 4-4 8 8"/><path d="M15 17h6v-6"/></svg>',
  chev: '<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5l7 7-7 7"/></svg>',
};
const kpi = (tone, label, value, trend) => `<div class="kpi ${tone}"><div class="top"><span>${label}</span><span class="ic">${ICON[trendDir(trend)]}</span></div><div class="bot"><span class="val">${value}</span><span class="dl">${pctLabel(trend)}</span></div></div>`;
const skeleton = (n = 4) => Array.from({ length: n }, () => '<div class="skel"></div>').join('');
const shortDay = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });

let ov = null, chartTab = 'calls';
const TABS = [['calls', 'Calls'], ['minutes', 'Minutes'], ['users', 'Active users'], ['revenue', 'Revenue']];
const SERIES_KEY = { calls: 'calls', minutes: 'minutes', users: 'activeUsers', revenue: 'revenue' };

function lineChart(o) {
  const vals = o.series.map((x) => x[SERIES_KEY[chartTab]]);
  if (!vals.some((v) => v > 0)) return `<div class="empty">No ${TABS.find((t) => t[0] === chartTab)[1].toLowerCase()} in the last ${o.days} days yet.</div>`;
  const W = 320, H = 150, g = chartGeometry(vals, W, H, 12);
  const fmt = (v) => (chartTab === 'revenue' ? money(v, o.currency) : num(v));
  const top = g.markers.reduce((m, i) => (vals[i] > vals[m] ? i : m), g.markers[0]);
  const idx = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(f * (o.series.length - 1)));
  return `<div class="lineBox"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${chartTab} per day">
      <defs><linearGradient id="ag" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color:var(--accent);stop-opacity:.22"/><stop offset="1" style="stop-color:var(--accent);stop-opacity:0"/></linearGradient></defs>
      <path class="area" d="${g.area}" fill="url(#ag)"/><path class="ln" d="${g.line}"/>
      ${g.markers.map((i) => `<line class="stem" x1="${g.pts[i][0].toFixed(1)}" x2="${g.pts[i][0].toFixed(1)}" y1="${g.pts[i][1].toFixed(1)}" y2="${H - 12}"/><circle class="mk" cx="${g.pts[i][0].toFixed(1)}" cy="${g.pts[i][1].toFixed(1)}" r="3.6"/>`).join('')}
    </svg><div class="tip ${g.pts[top][0] / W > 0.72 ? 'r' : g.pts[top][0] / W < 0.28 ? 'l' : ''}" style="left:${(g.pts[top][0] / W) * 100}%;top:calc(${(g.pts[top][1] / H) * 100}% + 30px)">${fmt(vals[top])} · ${shortDay(o.series[top].d)}</div></div>
    <div class="xlab">${idx.map((i) => `<span>${shortDay(o.series[i].d)}</span>`).join('')}</div>`;
}

function channelsPanel(o) {
  if (!o.channels.length) return '<div class="empty">No calls in this range yet.</div>';
  const rows = o.channels.slice(0, 6);
  const max = Math.max(...rows.map((r) => r.calls), 1);
  return `<div class="barRow">${rows.map((r, i) => `<div class="barCol${i === 0 ? ' hi' : ''}">${i === 0 ? `<span class="tip">${compact(r.calls)}</span>` : ''}<i style="height:${Math.max(8, (r.calls / max) * 100)}%"></i></div>`).join('')}</div>
    <div class="barLab">${rows.map((r) => `<span>${esc(channelName(r.platform))}</span>`).join('')}</div>`;
}

function drawOverview() {
  const o = ov, el = $('sec-overview');
  const hasRates = o.ratePerMin > 0, profit = o.revenue - o.cost;
  el.innerHTML = `
    ${myRole === 'owner' ? `<div class="liveBar"><span class="livePill"><span class="liveDot" id="liveDot"></span><span id="liveLabel">Live</span></span><span id="liveStamp"></span></div>
    <div class="panel" id="liveCard"><div class="liveBig"><b id="liveActive">–</b><span>calls happening now</span></div><div class="liveSub" id="liveSub"></div></div>` : ''}
    <div class="kpiGrid">
      ${kpi('blue', 'Calls', num(o.calls), o.trends.calls)}
      ${kpi('dark', 'Minutes used', num(o.minutesUsed), o.trends.minutes)}
      ${kpi('dark', 'New users', num(o.newUsers), o.trends.newUsers)}
      ${kpi('blue', 'Active users', num(o.activeUsers), o.trends.activeUsers)}
    </div>
    <div class="panel"><div class="ptabs" id="ptabs">${TABS.map(([k, l]) => `<button data-t="${k}" class="${k === chartTab ? 'on' : ''}">${l}</button>`).join('')}</div><div id="chartHost">${lineChart(o)}</div></div>
    <div class="panel"><h3>Calls by channel</h3>${channelsPanel(o)}</div>
    <div class="grp">
      <div class="gr"><span class="k">Revenue</span><span class="v">${money(o.revenue, o.currency)} <small>${pctLabel(o.trends.revenue)}</small></span></div>
      <div class="gr"><span class="k">Est. profit</span><span class="v">${hasRates ? `<span class="${profit < 0 ? 'aNeg' : 'aPos'}">${money(profit, o.currency)}</span>` : 'set provider rates in Costs'}</span></div>
      <div class="gr"><span class="k">Minutes sold</span><span class="v">${num(o.minutesSold)} · ${o.payingUsers} paying</span></div>
      <div class="gr"><span class="k">Avg per call</span><span class="v">${o.calls ? `${num(o.minutesUsed / o.calls)}m` : '—'}</span></div>
      <div class="gr"><span class="k">All-time revenue</span><span class="v">${money(o.allTimeRevenue, o.currency)}</span></div>
      <div class="gr"><span class="k">Total users</span><span class="v">${num(o.totalUsers)}</span></div>
    </div>
    ${myRole === 'owner' ? '<div class="sectionT">RECENT CALLS</div><div id="recentCalls"><div class="empty">Loading…</div></div>' : ''}`;
  $('ptabs').onclick = (e) => {
    const b = e.target.closest('button[data-t]'); if (!b) return;
    chartTab = b.dataset.t;
    $('ptabs').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    $('chartHost').innerHTML = lineChart(ov);
  };
  if (liveData) paintLive(liveData);
  if (myRole === 'owner') renderAlertsCard(el);
}

async function loadOverview({ quiet = false } = {}) {
  const el = $('sec-overview');
  if (!quiet || !ov) el.innerHTML = skeleton(4);
  try {
    ov = await api('overview', { qs: `&days=${range}` });
    if (current === 'overview') drawOverview();
  } catch (err) { if (!quiet) fail(el, err); }
}

// ---------- live: polled every few seconds while the overview is on screen ----------
let liveData = null, liveTimer = 0, ovTimer = 0, stampTimer = 0, lastLiveAt = 0, liveFailing = false;
function paintLive(d) {
  const c = d.counts;
  const set = (id, html) => { const n = $(id); if (n) n.innerHTML = html; };
  set('liveActive', num(c.active));
  $('liveDot')?.classList.toggle('on', c.active > 0);
  set('liveLabel', c.active > 0 ? 'Live' : 'Idle');
  set('liveSub', `<span><b>${num(c.talking)}</b> talking</span><span><b>${num(c.ringing)}</b> ringing</span><span>last 24h: <b>${num(c.calls24h)}</b> calls · <b>${num(c.completed24h)}</b> complete · <b>${num(c.noAnswer24h)}</b> no answer · <b>${num(c.failed24h)}</b> failed</span>`);
  const host = $('recentCalls');
  if (host && d.recent) {
    host.innerHTML = d.recent.length ? d.recent.map((r) => {
      const st = statusOf(r.status);
      const when = relTime(r.createdAt) + (r.seconds ? ` · ${dur(r.seconds)}` : '');
      return `<div class="oc"><div class="h"><span>#${esc(r.id.slice(0, 6).toUpperCase())}</span><span class="chip ${st.tone}">${st.label}</span></div>
        <div class="r"><span class="k">User</span><span class="v">${esc(r.user)}</span></div>
        <div class="r"><span class="k">Channel</span><span class="v">${esc(channelName(r.platform))} · ${r.direction === 'inbound' ? 'inbound' : 'outbound'}</span></div>
        <div class="r"><span class="k">Number</span><span class="v">${esc(r.number)}</span></div>
        <div class="r"><span class="k">Date</span><span class="v" data-ts="${esc(r.createdAt)}" data-secs="${r.seconds}">${esc(when)}</span></div></div>`;
    }).join('') : '<div class="empty">No calls yet.</div>';
  }
  paintStamp();
}
function paintStamp() {
  const n = $('liveStamp'); if (!n) return;
  n.textContent = liveFailing ? 'Offline, retrying…' : (lastLiveAt ? `Updated ${Math.max(0, Math.round((Date.now() - lastLiveAt) / 1000))}s ago` : '');
  document.querySelectorAll('#recentCalls [data-ts]').forEach((v) => { v.textContent = relTime(v.dataset.ts) + (Number(v.dataset.secs) ? ` · ${dur(Number(v.dataset.secs))}` : ''); });
}
async function refreshLive() {
  if (document.hidden || current !== 'overview' || myRole !== 'owner') return; // live calls are owner-only; investors stay read-only
  try { liveData = await api('live'); lastLiveAt = Date.now(); liveFailing = false; paintLive(liveData); }
  catch { liveFailing = true; paintStamp(); }
}
function syncLive() {
  clearInterval(liveTimer); clearInterval(ovTimer); clearInterval(stampTimer);
  liveTimer = ovTimer = stampTimer = 0;
  if (document.hidden || !(current === 'overview' || current === 'usage')) return;
  if (current === 'overview' && myRole === 'owner') { refreshLive(); liveTimer = setInterval(refreshLive, 5000); stampTimer = setInterval(paintStamp, 1000); }
  ovTimer = setInterval(() => loaders[current]({ quiet: true }), 30000);
}

// ---------- admins (owner only) ----------
async function loadAdmins() {
  const el = $('sec-admins');
  if (myRole !== 'owner') { el.innerHTML = '<div class="aHint">Only the owner can manage admins.</div>'; return; }
  el.innerHTML = '<div class="aHint">Loading…</div>';
  let data;
  try { data = await api('admin-list'); } catch (err) { return fail(el, err); }
  const label = { pending: 'Waiting for your approval', approved: 'Admin', revoked: 'Removed' };
  const buttons = (r) => (r.status === 'pending'
    ? `<button class="aBtn sm" data-d="approve">Approve</button><button class="aBtn ghost sm" data-d="revoke">Decline</button>`
    : r.status === 'approved'
      ? `<button class="aBtn ghost sm" data-d="revoke">Remove</button>`
      : `<button class="aBtn sm" data-d="approve">Approve again</button>`);
  el.innerHTML = `<div class="aCard"><div class="l" style="margin-bottom:8px;">Add an admin by email</div>
      <div class="aField"><input type="email" id="adminAddEmail" placeholder="name@example.com" autocomplete="off" autocapitalize="off"></div>
      <button class="aBtn" id="adminAddBtn">Approve as admin</button>
      <div class="aHint" id="adminAddHint">Approved admins get a read-only investor view: Overview (revenue), Usage and Costs. They cannot change anything, and AI behavior, Call Emysa, Users, Credits, Content and push stay hidden from them. They sign in on this page with that email, or tap Request access and you approve them here.</div></div>
    <div class="l" style="margin:16px 4px 8px;color:var(--muted);font-size:13px;">Requests and admins</div>
    <div id="adminRows">${data.admins.map((r) => `<div class="aRow" data-email="${esc(r.email)}">
      <div class="aFlex"><div style="min-width:0"><div class="t">${esc(r.email)}</div>
        <div class="m">${label[r.status] || r.status} · ${new Date(r.decided_at || r.requested_at).toLocaleDateString()}</div></div>
        <div class="aFlex" style="gap:6px;">${buttons(r)}</div></div></div>`).join('') || '<div class="aHint">No requests yet.</div>'}</div>`;
  const decide = async (email, decision, btn) => {
    if (btn) btn.textContent = '…';
    try { await api('admin-decide', { method: 'POST', body: { email, decision } }); loadAdmins(); }
    catch (err) { $('adminAddHint').textContent = err.message; if (btn) btn.textContent = 'Failed'; }
  };
  $('adminAddBtn').onclick = () => {
    const email = $('adminAddEmail').value.trim();
    if (!email) { $('adminAddHint').textContent = 'Enter an email address.'; return; }
    decide(email, 'approve', $('adminAddBtn'));
  };
  $('adminRows').onclick = (e) => {
    const btn = e.target.closest('button[data-d]'); if (!btn) return;
    decide(btn.closest('.aRow').dataset.email, btn.dataset.d, btn);
  };
}

// ---------- purchase alerts (web push to this device) ----------
const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const keyBytes = (b64) => { const p = '='.repeat((4 - (b64.length % 4)) % 4); const raw = atob((b64 + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from([...raw].map((c) => c.charCodeAt(0))); };
const sameKey = (sub, bytes) => { const cur = sub.options?.applicationServerKey; if (!cur) return false; const a = new Uint8Array(cur); return a.length === bytes.length && a.every((v, i) => v === bytes[i]); };

async function alertsOn() {
  if (!pushSupported() || Notification.permission !== 'granted') return false;
  try { return Boolean(await (await navigator.serviceWorker.ready).pushManager.getSubscription()); } catch { return false; }
}

async function enableAlerts() {
  if (!pushSupported()) throw new Error('This browser cannot show notifications. On iPhone, add this page to your Home Screen and open it from there.');
  if (Notification.permission === 'denied') throw new Error('Notifications are blocked for this page. Allow them in your phone settings.');
  if (Notification.permission !== 'granted' && (await Notification.requestPermission()) !== 'granted') throw new Error('Notifications were not allowed.');
  const reg = await navigator.serviceWorker.ready;
  const keyResp = await authedFetch('/api/assistant?action=pushKey');
  const { publicKey } = await keyResp.json().catch(() => ({}));
  if (!publicKey) throw new Error('Notifications are not set up on the server yet.');
  const bytes = keyBytes(publicKey);
  let sub = await reg.pushManager.getSubscription();
  if (sub && !sameKey(sub, bytes)) { await sub.unsubscribe().catch(() => {}); sub = null; }
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes });
  const saved = await authedFetch('/api/assistant?action=savePushSubscription', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscription: sub.toJSON() }),
  });
  if (!saved.ok) throw new Error('Could not save this device for notifications.');
}

// A device subscribed under a different key than the server signs with cannot receive anything, and
// looks "on" anyway. When permission is already granted, quietly re-register it with the server's key.
async function repairAlerts() {
  try {
    if (!pushSupported() || Notification.permission !== 'granted') return;
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (!sub) return;
    const keyResp = await authedFetch('/api/assistant?action=pushKey');
    const { publicKey } = await keyResp.json().catch(() => ({}));
    if (publicKey && !sameKey(sub, keyBytes(publicKey))) await enableAlerts();
  } catch { /* the card below still offers the button */ }
}

async function renderAlertsCard(el) {
  await repairAlerts();
  const on = await alertsOn();
  const box = document.createElement('div');
  box.className = 'aCard wide';
  box.style.marginTop = '12px';
  box.innerHTML = `<div class="l">Purchase alerts</div>
    <div class="s" style="margin:6px 0 10px;">${on ? 'On for this device. You get a notification whenever someone pays for minutes.' : 'Get a notification on this device whenever someone pays for minutes.'}</div>
    ${on ? '' : '<button class="aBtn" id="alertsBtn">Turn on purchase alerts</button>'}<div class="aHint" id="alertsHint"></div>`;
  el.appendChild(box);
  const btn = box.querySelector('#alertsBtn');
  if (btn) btn.onclick = async () => {
    btn.disabled = true;
    try { await enableAlerts(); renderAlertsRefresh(el); }
    catch (err) { box.querySelector('#alertsHint').textContent = err.message; btn.disabled = false; }
  };
}
function renderAlertsRefresh(el) { el.querySelector('.aCard.wide:last-child')?.remove(); renderAlertsCard(el); }

// ---------- users ----------
const avatar = (email, cls = '') => `<span class="av ${cls}" style="background:linear-gradient(135deg,hsl(${hueOf(email)} 70% 58%),hsl(${(hueOf(email) + 40) % 360} 70% 46%))">${esc(initialOf(email))}</span>`;
const minutesLeft = (u) => Math.max(0, u.minutes_limit + u.bonus_minutes - u.minutes_used);

async function loadUsers({ quiet = false } = {}) {
  const el = $('sec-users');
  if (!quiet) el.innerHTML = skeleton(5);
  try { usersCache = (await api('list-users')).users; } catch (err) { return fail(el, err); }
  el.innerHTML = `<div class="aField"><input type="search" id="userSearch" placeholder="Search email"></div><div class="liveBar"><span id="userCount"></span></div><div id="userRows"></div>`;
  const draw = () => {
    const q = $('userSearch').value.trim().toLowerCase();
    const list = usersCache.filter((u) => (u.email || '').toLowerCase().includes(q));
    $('userCount').textContent = `${list.length} of ${usersCache.length} users`;
    $('userRows').innerHTML = list.map((u) => {
      const total = Math.max(1, u.minutes_limit + u.bonus_minutes);
      return `<button class="person" data-id="${u.id}">${avatar(u.email)}<span class="who"><div class="t">${esc(u.email)}</div><div class="m">${num(minutesLeft(u))} min left · used ${num(u.minutes_used)}</div><div class="meter"><i style="width:${Math.min(100, (minutesLeft(u) / total) * 100)}%"></i></div></span>${ICON.chev}</button>`;
    }).join('') || '<div class="empty">No users.</div>';
  };
  draw();
  $('userSearch').oninput = draw;
  $('userRows').onclick = (e) => { const b = e.target.closest('.person'); if (b) openDetail(b.dataset.id); };
}

// ---- one person: opens over the list like a page, edits through the app's own sheets ----
let detailId = null;
function closeDetail() { detailId = null; $('aDetail').classList.remove('on'); $('aDetail').setAttribute('aria-hidden', 'true'); }
async function openDetail(id) {
  detailId = id;
  const u = usersCache.find((x) => x.id === id); if (!u) return;
  $('aDetail').classList.add('on'); $('aDetail').setAttribute('aria-hidden', 'false');
  const row = (k, v) => `<div class="gr"><span class="k">${k}</span><span class="v">${v}</span></div>`;
  $('dBody').innerHTML = `<div class="dHero">${avatar(u.email)}<div class="nm">${esc(u.email)}</div></div>
    <div class="grp">${row('Email', esc(u.email))}${row('Joined', u.created_at ? new Date(u.created_at).toLocaleDateString() : '—')}${row('Number rental', u.approved ? 'Allowed' : 'Not allowed')}</div>
    <div class="grp">${row('Minutes left', num(minutesLeft(u)))}${row('Used this period', num(u.minutes_used))}${row('Monthly limit', num(u.minutes_limit))}${row('Credit minutes', num(u.bonus_minutes))}</div>
    <div class="dActions"><button class="aBtn ghost" id="dLimit">Set limit</button><button class="aBtn ghost" id="dCredit">Add credit</button><button class="aBtn ghost" id="dRent">${u.approved ? 'Stop rental' : 'Allow rental'}</button></div>
    <div class="sectionT">RECENT CALLS</div><div class="grp" id="dCalls"><div class="gr"><span class="k">Loading…</span></div></div>`;
  $('dLimit').onclick = async () => {
    const v = await promptSheet({ title: 'Monthly limit', message: 'Call minutes per month for this account.', value: String(u.minutes_limit), placeholder: 'Minutes', multiline: false, confirmLabel: 'Save' });
    if (v === null || v === undefined) return;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) return errorSheet('Enter minutes of 0 or more.');
    await act(() => api('set-approval', { method: 'POST', body: { targetUserId: u.id, monthlyMinuteLimit: n } }), 'Limit saved.', id);
  };
  $('dCredit').onclick = async () => {
    const v = await promptSheet({ title: 'Add credit', message: `Minutes to add for ${u.email}. Use a negative number to remove.`, placeholder: 'Minutes', multiline: false, confirmLabel: 'Apply' });
    if (v === null || v === undefined) return;
    const n = Number(v);
    if (!Number.isFinite(n) || n === 0) return errorSheet('Enter minutes, not 0.');
    await act(() => api('grant-credit', { method: 'POST', body: { targetUserId: u.id, minutes: n, note: 'Admin' } }), `${n > 0 ? '+' : ''}${n} min applied.`, id);
  };
  $('dRent').onclick = async () => {
    const ok = await confirmSheet({ title: u.approved ? 'Stop number rental?' : 'Allow number rental?', message: 'New accounts do not need approval. This only controls renting a phone number.', confirmLabel: u.approved ? 'Stop' : 'Allow', destructive: !!u.approved });
    if (!ok) return;
    await act(() => api('set-approval', { method: 'POST', body: { targetUserId: u.id, approved: !u.approved } }), 'Saved.', id);
  };
  try {
    const { calls } = await api('user-calls', { qs: `&uid=${u.id}` });
    if (detailId !== id) return;
    $('dCalls').innerHTML = calls.length ? calls.map((c) => { const st = statusOf(c.status); return `<div class="gr"><span class="k">${esc(channelName(c.platform))}<small>${esc(c.number)} · ${esc(relTime(c.createdAt))}${c.seconds ? ' · ' + esc(dur(c.seconds)) : ''}</small></span><span class="chip ${st.tone}">${st.label}</span></div>`; }).join('') : '<div class="gr"><span class="k">No calls yet.</span></div>';
  } catch (err) { if (detailId === id) $('dCalls').innerHTML = `<div class="gr"><span class="k">${esc(err.message)}</span></div>`; }
}
async function act(fn, okMessage, id) {
  try {
    await fn();
    usersCache = (await api('list-users')).users;
    if (detailId === id) openDetail(id);
    if (current === 'users') loadUsers({ quiet: true });
    await successSheet(okMessage);
  } catch (err) { errorSheet(err.message || 'That did not work.'); }
}

// ---------- usage ----------
async function loadUsage({ quiet = false } = {}) {
  const el = $('sec-usage');
  if (!quiet) el.innerHTML = skeleton(4);
  try {
    const { users } = await api('analytics', { qs: `&days=${range}` });
    if (!users.length) { el.innerHTML = `<div class="empty">No calls in the last ${range} days.</div>`; return; }
    const max = Math.max(...users.map((u) => u.minutes), 1);
    el.innerHTML = `<div class="liveBar"><span>${users.length} user${users.length === 1 ? '' : 's'} on calls · last ${range} days</span></div>` + users.map((u) => `<div class="person" style="cursor:default">${avatar(u.email)}<span class="who"><div class="t">${esc(u.email)}</div>
      <div class="m">${u.calls} call${u.calls === 1 ? '' : 's'}${u.lastActive ? ' · last ' + esc(relTime(u.lastActive)) : ''}</div><div class="meter"><i style="width:${(u.minutes / max) * 100}%"></i></div></span><b>${num(u.minutes)}m</b></div>`).join('');
  } catch (err) { if (!quiet) fail(el, err); }
}

// ---------- credits: apply minutes + history ----------
async function loadCredits() {
  const el = $('sec-credits');
  const keep = $('creditUser')?.value;
  try { usersCache = (await api('list-users')).users; } catch (err) { return fail(el, err); }
  el.innerHTML = `<div class="aCard"><div class="l" style="margin-bottom:8px;">Apply credit to a user</div>
    <div class="aField"><select id="creditUser">${usersCache.map((u) => `<option value="${u.id}">${esc(u.email)} (${num(Math.max(0, u.minutes_limit + u.bonus_minutes - u.minutes_used))} left)</option>`).join('')}</select></div>
    <div class="aField"><input type="number" id="creditMin" placeholder="Minutes" min="1" step="1"></div>
    <div class="aField"><input type="text" id="creditNote" placeholder="Note (optional)" maxlength="200"></div>
    <div class="aFlex"><button class="aBtn" id="creditAdd" style="flex:1">Add minutes</button><button class="aBtn ghost" id="creditSub" style="flex:1">Remove</button></div>
    <div class="aHint" id="creditHint">Purchases are credited automatically after payment. Use this for gifts, refunds and fixes.</div></div>
    <div class="l" style="margin:16px 4px 8px;color:var(--muted);font-size:13px;">Recent credits</div><div id="ledger"><div class="aHint">Loading…</div></div>`;
  if (keep) $('creditUser').value = keep;
  const apply = async (sign) => {
    const m = Number($('creditMin').value);
    if (!Number.isFinite(m) || m <= 0) { $('creditHint').textContent = 'Enter minutes above 0.'; return; }
    $('creditHint').textContent = 'Applying…';
    try {
      const r = await api('grant-credit', { method: 'POST', body: { targetUserId: $('creditUser').value, minutes: sign * m, note: $('creditNote').value } });
      $('creditHint').textContent = `Done. Credit balance is now ${num(r.bonus_minutes)} min.`;
      $('creditMin').value = ''; $('creditNote').value = '';
      loadLedger();
    } catch (err) { $('creditHint').textContent = err.message; }
  };
  $('creditAdd').onclick = () => apply(1);
  $('creditSub').onclick = () => apply(-1);
  loadLedger();
}
async function loadLedger() {
  const el = $('ledger');
  try {
    const { entries } = await api('credit-ledger');
    el.innerHTML = entries.map((e) => `<div class="aRow"><div class="aFlex"><div class="t" style="min-width:0">${esc(emailOf(e.user_id))}</div><b class="${e.minutes < 0 ? 'aNeg' : 'aPos'}">${e.minutes > 0 ? '+' : ''}${num(e.minutes)}m</b></div>
      <div class="m">${e.source === 'purchase' ? 'Purchase' : 'Admin'}${e.note ? ' · ' + esc(e.note) : ''} · ${new Date(e.at).toLocaleString()}</div></div>`).join('') || '<div class="aHint">No credits yet.</div>';
  } catch (err) { fail(el, err); }
}

// ---------- keys: platform API keys, owner only ----------
async function loadKeys() {
  const el = $('sec-keys');
  try {
    const { keys } = await api('keys-status');
    el.innerHTML = Object.entries(keys).map(([name, k]) => {
      const state = k.set
        ? `Set · ends in ${esc(k.last4)} · from ${k.source === 'admin' ? 'this panel' : 'the server settings'}${k.updatedAt ? ' · ' + new Date(k.updatedAt).toLocaleString() : ''}`
        : 'Not set.';
      return `<div class="aCard" data-key="${esc(name)}">
        <div class="aHint" style="margin:0 0 12px;">${esc(k.label)}. Saved here, it takes effect within a minute. Keep it private: it is never shown in full.</div>
        <div class="aHint" style="margin:0 0 12px;">${state}</div>
        <div class="aField"><label>New ${esc(k.label)}</label><input type="password" class="keyValue" autocomplete="off" placeholder="Paste the key"></div>
        <button class="aBtn keySave">Save key</button><div class="aHint keyHint"></div></div>`;
    }).join('');
    el.querySelectorAll('.aCard').forEach((card) => {
      card.querySelector('.keySave').onclick = async () => {
        const hint = card.querySelector('.keyHint');
        hint.textContent = 'Saving…';
        try {
          await api('keys-save', { method: 'POST', body: { name: card.dataset.key, value: card.querySelector('.keyValue').value } });
          hint.textContent = 'Saved.';
          await loadKeys();
        } catch (err) { hint.textContent = err.message; }
      };
    });
  } catch (err) { fail(el, err); }
}

// ---------- costs: provider rates per call minute ----------
async function loadCosts() {
  const el = $('sec-costs');
  try {
    const { rates, currency, pricePerMin } = await api('rates');
    const ro = myRole !== 'owner';
    const field = (k, label) => `<div class="aField"><label>${label} (${currency} per call minute)</label><input type="number" min="0" step="0.001" id="rate_${k}" value="${rates[k] || ''}" placeholder="0"${ro ? ' disabled' : ''}></div>`;
    el.innerHTML = `<div class="aCard"><div class="aHint" style="margin:0 0 12px;">${ro ? 'Provider cost per minute of call time, used to estimate cost and profit. View only.' : 'Enter what each provider costs you per minute of call time, from your own bills. The panel multiplies this by minutes used to estimate cost and profit.'}</div>
      ${field('twilio', 'Twilio')}${field('xai', 'xAI (Grok)')}${field('openai', 'OpenAI')}
      ${ro ? '' : '<button class="aBtn" id="rateSave">Save rates</button>'}<div class="aHint" id="rateHint"></div></div>
      <div class="aGrid" id="rateSummary" style="margin-top:12px;"></div>`;
    const summary = () => {
      const cost = ['twilio', 'xai', 'openai'].reduce((a, k) => a + (Number($(`rate_${k}`).value) || 0), 0);
      $('rateSummary').innerHTML = card('Your cost / min', money(cost, currency)) + card('You charge / min', pricePerMin ? money(pricePerMin, currency) : '—', 'avg of paid purchases')
        + (pricePerMin ? card('Margin / min', `<span class="${pricePerMin - cost < 0 ? 'aNeg' : 'aPos'}">${money(pricePerMin - cost, currency)}</span>`, `${((1 - cost / pricePerMin) * 100).toFixed(0)}% of price`, true) : '');
    };
    summary();
    ['twilio', 'xai', 'openai'].forEach((k) => { $(`rate_${k}`).oninput = summary; });
    if (!ro) $('rateSave').onclick = async () => {
      $('rateHint').textContent = 'Saving…';
      try { await api('rates', { method: 'POST', body: { twilio: $('rate_twilio').value || 0, xai: $('rate_xai').value || 0, openai: $('rate_openai').value || 0 } }); $('rateHint').textContent = 'Saved.'; }
      catch (err) { $('rateHint').textContent = err.message; }
    };
  } catch (err) { fail(el, err); }
}

// ---------- welcome/login/signup background gallery (images + video) ----------
async function loadBackgrounds() {
  loadLandingMedia();
  const { data } = await supabase.from('auth_backgrounds').select('id,url,media_type').order('created_at', { ascending: false });
  const grid = $('bgGrid');
  grid.innerHTML = (data || []).map((row) => `
    <div class="bgCard">
      ${row.media_type === 'video'
        ? `<video src="${row.url}" muted loop playsinline autoplay></video>`
        : `<img src="${row.url}" alt="">`}
      <button data-id="${row.id}" title="Remove">✕</button>
    </div>
  `).join('') || '<div class="authHint" style="grid-column:1/-1;">No backgrounds yet.</div>';

  grid.querySelectorAll('button[data-id]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      const resp = await authedFetch('/api/admin?action=delete-background', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: btn.dataset.id }),
      });
      const data = await resp.json();
      if (!resp.ok) { $('bgUploadStatus').textContent = data.error || 'Delete failed.'; btn.disabled = false; return; }
      loadBackgrounds();
    });
  });
}

$('uploadBgBtn').addEventListener('click', () => $('bgFileInput').click());
$('bgFileInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const mediaType = file.type.startsWith('video') ? 'video' : 'image';

  $('bgUploadStatus').textContent = 'Preparing upload…';
  const createResp = await authedFetch('/api/admin?action=create-background-upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mimeType: file.type, mediaType }),
  });
  const createData = await createResp.json();
  if (!createResp.ok) { $('bgUploadStatus').textContent = createData.error || 'Could not start upload.'; return; }

  $('bgUploadStatus').textContent = mediaType === 'video' ? 'Uploading video…' : 'Uploading…';
  // Goes straight from this browser to Supabase Storage — never touches our
  // own server, so there's no small body-size ceiling to hit on a video file.
  const { error: uploadErr } = await supabase.storage
    .from('app-assets')
    .uploadToSignedUrl(createData.path, createData.token, file);
  if (uploadErr) { $('bgUploadStatus').textContent = uploadErr.message || 'Upload failed.'; return; }

  const confirmResp = await authedFetch('/api/admin?action=confirm-background', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: createData.path, mediaType }),
  });
  const confirmData = await confirmResp.json();
  $('bgUploadStatus').textContent = confirmResp.ok
    ? 'Added — this plays on the welcome, login and sign-up screens.'
    : (confirmData.error || 'Could not save the upload.');
  if (confirmResp.ok) loadBackgrounds();
});

// ---------- Home screen GIF ----------
async function loadHero() {
  const { data } = await supabase.from('home_hero').select('url').order('created_at', { ascending: false }).limit(1).maybeSingle();
  $('heroPreview').innerHTML = data ? `<div class="bgCard"><img src="${data.url}" alt=""></div>` : '<div class="authHint" style="grid-column:1/-1;">No GIF yet.</div>';
  $('removeHeroBtn').style.display = data ? '' : 'none';
}
loadHero();

$('uploadHeroBtn').addEventListener('click', () => $('heroFileInput').click());
$('heroFileInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  if (file.type !== 'image/gif') { $('heroUploadStatus').textContent = 'Choose a GIF file.'; return; }
  $('heroUploadStatus').textContent = 'Preparing upload…';
  const createResp = await authedFetch('/api/admin?action=create-hero-upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mimeType: file.type }),
  });
  const createData = await createResp.json();
  if (!createResp.ok) { $('heroUploadStatus').textContent = createData.error || 'Could not start upload.'; return; }
  $('heroUploadStatus').textContent = 'Uploading…';
  const { error: uploadErr } = await supabase.storage.from('app-assets').uploadToSignedUrl(createData.path, createData.token, file);
  if (uploadErr) { $('heroUploadStatus').textContent = uploadErr.message || 'Upload failed.'; return; }
  const confirmResp = await authedFetch('/api/admin?action=confirm-hero', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: createData.path }),
  });
  const confirmData = await confirmResp.json();
  $('heroUploadStatus').textContent = confirmResp.ok ? 'Added. It now shows on Home.' : (confirmData.error || 'Could not save the upload.');
  if (confirmResp.ok) loadHero();
});
$('removeHeroBtn').addEventListener('click', async () => {
  $('removeHeroBtn').disabled = true;
  const resp = await authedFetch('/api/admin?action=delete-hero', { method: 'POST' });
  const data = await resp.json().catch(() => ({}));
  $('heroUploadStatus').textContent = resp.ok ? 'Removed.' : (data.error || 'Delete failed.');
  $('removeHeroBtn').disabled = false;
  loadHero();
});

// ---------- announcements ----------
$('announceSendBtn').addEventListener('click', async () => {
  const btn = $('announceSendBtn');
  if (btn.disabled) return;
  const title = $('announceTitle').value.trim();
  const body = $('announceBody').value.trim();
  if (!title || !body) { $('announceHint').textContent = 'Fill in both fields.'; return; }
  $('announceHint').textContent = 'Sending…';
  btn.disabled = true; // btnLoading.js shows the spinner while this is disabled
  window.btnLoading?.start(btn);
  try {
    const resp = await authedFetch('/api/admin?action=send-announcement', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, body }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) { $('announceHint').textContent = data.error || 'Send failed.'; return; }
    const why = (data.reasons || []).map((r) => `${r.count}× ${r.reason}`);
    if (data.subjectFixed) why.push('VAPID_SUBJECT in Vercel has a space or brackets. The server cleaned it for this send. Set it to exactly mailto:you@example.com.');
    if (data.keysMismatch) why.push('The server\u2019s push keys were not a matching pair. The app now uses the private key\u2019s own public key, so each device re-registers the next time the app is opened.');
    $('announceHint').textContent = `Sent to ${data.sent} of ${data.total} subscribed users.${why.length ? ` ${why.join(' ')}` : ''}`;
    $('announceTitle').value = '';
    $('announceBody').value = '';
  } catch {
    $('announceHint').textContent = 'Send failed. Check your connection.';
  } finally {
    btn.disabled = false;
    window.btnLoading?.stop(btn);
  }
});

// Don't rely solely on onAuthStateChange to ever fire — check the current
// session directly on load so the boot screen can't get stuck forever if
// that event is slow or doesn't arrive.
//
// Belt-and-suspenders on top of that: supabase-js's own getSession() can
// itself hang indefinitely (a known issue upstream — it takes an internal
// lock to refresh the token, and a stale/corrupted session in localStorage,
// or a previous tab that crashed mid-refresh, can leave that lock stuck).
// That's the failure mode that produces a *silent* stuck splash with no
// error at all, since a promise that never settles never throws. Race it
// against a timeout so the splash always resolves to something actionable.
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), ms)),
  ]);
}

withTimeout(supabase.auth.getSession(), 8000)
  .then(({ data }) => {
    currentSession = data.session;
    if (data.session?.user) { if (!alreadyInPanel(data.session)) enterAdmin(); }
    else showSignInForm();
  })
  .catch((err) => {
    if (err?.message === 'TIMEOUT') {
      showBootError(new Error('Timed out talking to Supabase.'), true);
    } else {
      showBootError(err);
    }
  });

function showSignInForm() {
  $('authBoot').classList.add('hidden');
  $('authBox').classList.remove('hidden');
  $('notAdminBox').classList.add('hidden');
  $('adminApp').classList.add('hidden');
  document.getElementById('authScreen').classList.remove('hidden');
}

function showBootError(err, offerReset = false) {
  const resetBtn = offerReset
    ? `<button id="bootResetBtn" style="margin-top:14px; font-size:12.5px; padding:8px 14px; border-radius:10px; background:rgba(255,255,255,0.12); color:#fff;">Clear session & retry</button>`
    : '';
  $('authBoot').innerHTML = `<div style="text-align:center; padding:0 24px; color:var(--dim); font-size:13.5px;">Couldn't reach Supabase.<br>${(err && err.message) || String(err)}${resetBtn}</div>`;
  document.getElementById('bootResetBtn')?.addEventListener('click', () => {
    // Nuke whatever supabase-js has persisted locally — this is what's
    // stuck if getSession() itself never resolved — then reload clean.
    Object.keys(localStorage).filter((k) => k.startsWith('sb-')).forEach((k) => localStorage.removeItem(k));
    location.reload();
  });
}

// Landing assets use the existing signed-upload pipeline and app-assets bucket.
// All slot definitions are intentionally explicit; no arbitrary URL or path input.
const LANDING_SLOTS = [
  ['hero_background', 'Hero background (fallback)', 'The hero uses the login screen background. Only used if that is empty'],
  ['how_it_works', 'Tell it once. It makes the call. (video)', 'Screen recording of the set-up and a first call. Plays muted on its own when visible and pauses when scrolled away. MP4, MOV or WebM, up to 50 MB'],
  ['your_voice', 'In your own voice. (screenshot)', 'Screenshot of the voice page'],
  ['live_call_video', 'Hear it live. (video)', 'Plays muted on its own when visible and pauses when scrolled away. MP4, MOV or WebM, up to 50 MB'],
  ['call_summary', 'Every call, summarized. (screenshot)', 'Screenshot of a finished call summary or transcript'],
  ['call_in_app', 'Call Emysa in the app. (screenshot)', 'Screenshot of talking to Emysa by voice inside the app'],
  ['import_chats', 'Turn your chats into memory. (screenshot)', 'Screenshot of the chat import and memories screen'],
  ['channels', 'Wherever they pick up. (screenshot)', 'Screenshot of phone, WhatsApp and Telegram connections'],
  ['footer_background', 'Footer background', 'Optional GIF, image or video. If empty, the footer reuses the login screen background'],
  ['hero_overlay', 'More screenshots', 'Extra screenshots shown in a swipe row near the end; upload several and reorder'],
  ['call_screenshots', 'More call screenshots', 'Extra screenshots, same swipe row'],
  ['feature_media', 'More feature media', 'Extra images or GIFs, same swipe row'],
  ['demo_video', 'Optional demonstration video', 'Muted, inline video; MP4 or WebM'],
  ['objective_background', 'Retired: objective background', 'No longer shown on the page'],
  ['objective_overlay', 'Extra screenshot: objective', 'Goes into the swipe row'],
  ['conversation_background', 'Retired: conversation background', 'No longer shown on the page'],
  ['conversation_overlay', 'Extra screenshot: conversation', 'Goes into the swipe row'],
  ['voice_orb', 'Retired: voice orb', 'No longer shown on the page'],
];
const GALLERIES = new Set(['call_screenshots', 'feature_media', 'hero_overlay']);
const typesFor = (slot) => slot === 'voice_orb' ? ['image/gif'] : isVideoSlot(slot) ? ['video/mp4', 'video/webm', 'video/quicktime'] : slot === 'footer_background' ? ['image/gif', 'image/png', 'image/jpeg', 'image/webp', 'video/mp4', 'video/webm', 'video/quicktime'] : ['image/gif', 'image/png', 'image/jpeg', 'image/webp'];
let landingRows = [];
async function loadLandingMedia() {
  const area = $('landingSlots');
  try {
    landingRows = (await api('landing-media')).media;
    area.innerHTML = LANDING_SLOTS.map(([key, name, hint]) => {
      const rows = landingRows.filter((r) => r.slot === key);
      return `<div class="landingSlot" data-slot="${key}"><h3>${name}</h3><p>${hint}</p>
        ${rows.map((r, i) => `<div class="landingItem" data-id="${r.id}">
          ${r.media_type.startsWith('video/') ? `<video src="${esc(r.url)}" muted playsinline controls preload="none"></video>` : `<img src="${esc(r.url)}" alt="${name} preview" loading="lazy">`}
          <div><div class="aHint">${r.media_type}</div>
            ${GALLERIES.has(key) ? `<button class="aBtn ghost sm" data-act="up" aria-label="Move ${name} up" ${i === 0 ? 'disabled' : ''}>↑</button><button class="aBtn ghost sm" data-act="down" aria-label="Move ${name} down" ${i === rows.length - 1 ? 'disabled' : ''}>↓</button>` : ''}
            <button class="aBtn ghost sm" data-act="remove" aria-label="Remove ${name}">Remove</button></div></div>`).join('') || '<div class="aHint">No asset yet — landing uses a designed fallback.</div>'}
        <button class="aBtn ghost sm" data-act="upload">${rows.length && !GALLERIES.has(key) ? 'Replace' : 'Upload'}</button>
        <input type="file" hidden accept="${typesFor(key).join(',')}"></div>`;
    }).join('');
  } catch (err) { area.textContent = `Could not load landing media: ${err.message}`; }
}
$('landingSlots').addEventListener('click', async (event) => {
  const btn = event.target.closest('button[data-act]');
  if (!btn) return;
  const slotEl = btn.closest('[data-slot]');
  const slot = slotEl.dataset.slot;
  const status = $('landingStatus');
  if (btn.dataset.act === 'upload') { slotEl.querySelector('input[type=file]').click(); return; }
  btn.disabled = true;
  status.textContent = 'Saving…';
  try {
    if (btn.dataset.act === 'remove') await api('delete-landing-media', { method: 'POST', body: { id: btn.closest('[data-id]').dataset.id } });
    else {
      const rows = landingRows.filter((r) => r.slot === slot);
      const index = rows.findIndex((r) => r.id === btn.closest('[data-id]').dataset.id);
      const other = index + (btn.dataset.act === 'up' ? -1 : 1);
      [rows[index], rows[other]] = [rows[other], rows[index]];
      await api('reorder-landing-media', { method: 'POST', body: { slot, ids: rows.map((r) => r.id) } });
    }
    status.textContent = 'Saved.';
    await loadLandingMedia();
  } catch (err) { status.textContent = err.message; btn.disabled = false; }
});
$('landingSlots').addEventListener('change', async (event) => {
  if (event.target.type !== 'file') return;
  const file = event.target.files[0];
  event.target.value = '';
  if (!file) return;
  const slotEl = event.target.closest('[data-slot]');
  const slot = slotEl.dataset.slot;
  const status = $('landingStatus');
  const type = guessType(file);
  const limit = type.startsWith('video/') ? 50 : 20;
  const mb = (file.size / 1048576).toFixed(1);
  const say = (text, kind = '') => { let n = slotEl.querySelector('.slotMsg'); if (!n) { n = document.createElement('div'); n.className = 'slotMsg'; slotEl.querySelector('p').after(n); } n.className = `slotMsg ${kind}`; n.textContent = text; };
  if (!typesFor(slot).includes(type)) { say(`${file.name} is ${type || 'an unknown type'}. This slot accepts ${typesFor(slot).map((t) => t.split('/')[1]).join(', ')}.`, 'err'); status.textContent = ''; return; }
  if (!file.size) { say(`${file.name} is empty.`, 'err'); return; }
  if (file.size > limit * 1024 * 1024) { say(`${file.name} is ${mb} MB. The limit is ${limit} MB. Compress or trim it and try again.`, 'err'); status.textContent = ''; return; }
  // Immediate, visible feedback inside the slot: local preview, file name, moving bar, elapsed time.
  const preview = URL.createObjectURL(file);
  const tile = document.createElement('div');
  tile.className = 'landingItem pending';
  tile.innerHTML = `${type.startsWith('video/') ? '<div class="pvBox">video</div>' : `<img src="${preview}" alt="">`}<div><b>${esc(file.name)}</b> <span class="aHint">${(file.size / 1048576).toFixed(1)} MB</span><div class="bar"><i></i></div><span class="aHint step">Preparing…</span></div>`;
  slotEl.querySelector('p').after(tile);
  const up = slotEl.querySelector('[data-act=upload]'); up.disabled = true; up.textContent = 'Uploading…';
  const t0 = Date.now(), step = tile.querySelector('.step'); let stage = 'Preparing';
  const timer = setInterval(() => { step.textContent = `${stage}… ${Math.round((Date.now() - t0) / 1000)}s`; }, 500);
  const setStage = (s) => { stage = s; step.textContent = `${s}…`; status.textContent = `${s} ${file.name}…`; };
  try {
    setStage('Preparing');
    const { path, token } = await api('create-landing-upload', { method: 'POST', body: { slot, mimeType: type, size: file.size } });
    setStage('Uploading');
    const { error } = await supabase.storage.from('app-assets').uploadToSignedUrl(path, token, file, { contentType: type });
    if (error) throw error;
    setStage('Saving');
    await api('confirm-landing-upload', { method: 'POST', body: { slot, mimeType: type, path } });
    clearInterval(timer); URL.revokeObjectURL(preview);
    status.textContent = 'Saved. The public page will update shortly.';
    await loadLandingMedia();
    const again = document.querySelector(`[data-slot="${slot}"]`); const n = document.createElement('div'); n.className = 'slotMsg ok'; n.textContent = 'Saved'; again.querySelector('p').after(n);
  } catch (err) {
    clearInterval(timer); tile.remove(); up.disabled = false; up.textContent = 'Upload';
    say(`Upload failed: ${err.message}`, 'err'); status.textContent = `Upload failed: ${err.message}`;
  }
});

function isVideoSlot(s) { return s === 'demo_video' || s === 'live_call_video' || s === 'how_it_works'; }
// iPhone and Files often give an empty MIME type, so fall back to the extension.
function guessType(f) { return f.type || ({ mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', gif: 'image/gif', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' })[(f.name.split('.').pop() || '').toLowerCase()] || ''; }
