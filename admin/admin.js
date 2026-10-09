import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

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

supabase.auth.onAuthStateChange((_event, session) => {
  currentSession = session;
  if (session?.user) enterAdmin();
  else showSignInForm();
});

async function enterAdmin() {
  try {
    // The /api/admin-* endpoints already check ADMIN_EMAIL server-side —
    // this call doubles as the gate for this page too, same source of truth,
    // no separate admin check to keep in sync.
    const resp = await withTimeout(authedFetch('/api/admin?action=list-users'), 10000);
    $('authBoot').classList.add('hidden');
    $('authBox').classList.add('hidden');
    if (!resp.ok) {
      $('notAdminBox').classList.remove('hidden');
      $('adminApp').classList.add('hidden');
      return;
    }
    $('notAdminBox').classList.add('hidden');
    document.getElementById('authScreen').classList.add('hidden');
    $('adminApp').classList.remove('hidden');
    initPanel((await resp.json()).users);
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
document.documentElement.setAttribute('data-theme', localStorage.getItem('theme') === 'brave' ? 'brave' : 'dark');
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
const TITLES = { overview: 'Overview', users: 'Users', usage: 'Usage', credits: 'Credits', costs: 'Costs & providers', content: 'Content & push' };
const loaders = { overview: loadOverview, users: loadUsers, usage: loadUsage, credits: loadCredits, costs: loadCosts, content: loadBackgrounds };

function openSection(name) {
  current = name;
  $('adminApp').classList.remove('open');
  document.querySelectorAll('.aSec').forEach((el) => el.classList.toggle('on', el.id === `sec-${name}`));
  document.querySelectorAll('#aDrawer .nav[data-s]').forEach((el) => el.classList.toggle('on', el.dataset.s === name));
  $('aTitle').textContent = TITLES[name];
  $('aChips').style.display = name === 'overview' || name === 'usage' ? '' : 'none';
  loaders[name]();
}
function initPanel(users) {
  usersCache = users;
  $('menuBtn').onclick = () => $('adminApp').classList.add('open');
  $('aScrim').onclick = () => $('adminApp').classList.remove('open');
  $('refreshBtn').onclick = () => loaders[current]();
  document.querySelectorAll('#aDrawer .nav[data-s]').forEach((el) => { el.onclick = () => openSection(el.dataset.s); });
  document.querySelectorAll('#aChips button').forEach((el) => {
    el.onclick = () => {
      range = Number(el.dataset.d);
      document.querySelectorAll('#aChips button').forEach((b) => b.classList.toggle('on', b === el));
      loaders[current]();
    };
  });
  openSection('overview');
}
const emailOf = (id) => usersCache.find((u) => u.id === id)?.email || id.slice(0, 8);

// ---------- overview: revenue + analysis ----------
async function loadOverview() {
  const el = $('sec-overview');
  el.innerHTML = '<div class="aHint">Loading…</div>';
  try {
    const o = await api('overview', { qs: `&days=${range}` });
    const hasRates = o.ratePerMin > 0;
    const profit = o.revenue - o.cost;
    const max = Math.max(...o.series.map((x) => x.revenue), 1);
    el.innerHTML = `<div class="aGrid">
      ${card('Revenue', money(o.revenue, o.currency), `${o.purchases} purchase${o.purchases === 1 ? '' : 's'} · ${money(o.allTimeRevenue, o.currency)} all time`)}
      ${card('Est. profit', hasRates ? `<span class="${profit < 0 ? 'aNeg' : 'aPos'}">${money(profit, o.currency)}</span>` : '—', hasRates ? `after ${money(o.cost, o.currency)} provider cost` : 'set provider rates in Costs')}
      ${card('Minutes sold', num(o.minutesSold), `${o.payingUsers} paying user${o.payingUsers === 1 ? '' : 's'}`)}
      ${card('Minutes used', num(o.minutesUsed), `${o.calls} calls`)}
      ${card('Active users', num(o.activeUsers), `of ${num(o.totalUsers)} total`)}
      ${card('Avg per call', o.calls ? `${num(o.minutesUsed / o.calls)}m` : '—', `last ${o.days} days`)}
      <div class="aCard wide"><div class="l">Daily revenue</div><div class="aBars">${o.series.map((x) => `<i title="${x.d}: ${money(x.revenue, o.currency)}" style="height:${Math.max(2, (x.revenue / max) * 100)}%"></i>`).join('')}</div></div>
    </div>`;
  } catch (err) { fail(el, err); }
}

// ---------- users ----------
async function loadUsers() {
  const el = $('sec-users');
  try { usersCache = (await api('list-users')).users; } catch (err) { return fail(el, err); }
  el.innerHTML = `<div class="aField"><input type="search" id="userSearch" placeholder="Search email"></div><div id="userRows"></div>`;
  const draw = () => {
    const q = $('userSearch').value.trim().toLowerCase();
    $('userRows').innerHTML = usersCache.filter((u) => (u.email || '').toLowerCase().includes(q)).map((u) => `
      <div class="aRow" data-id="${u.id}">
        <div class="aFlex"><div style="min-width:0"><div class="t">${esc(u.email)}</div>
          <div class="m">${num(Math.max(0, u.minutes_limit + u.bonus_minutes - u.minutes_used))} min left · used ${num(u.minutes_used)} of ${num(u.minutes_limit)}${u.bonus_minutes ? ` + ${num(u.bonus_minutes)} credit` : ''}</div></div>
          <button class="aBtn sm ${u.approved ? 'ghost' : ''}" data-a="approve">${u.approved ? 'Approved' : 'Approve'}</button></div>
        <div class="aFlex" style="margin-top:10px;"><input type="number" min="0" step="10" value="${u.minutes_limit}" style="width:90px;" aria-label="Monthly limit">
          <button class="aBtn ghost sm" data-a="limit">Save limit</button><button class="aBtn ghost sm" data-a="credit" style="margin-left:auto;">+ Credit</button></div>
      </div>`).join('') || '<div class="aHint">No users.</div>';
  };
  draw();
  $('userSearch').oninput = draw;
  $('userRows').onclick = async (e) => {
    const btn = e.target.closest('button[data-a]'); if (!btn) return;
    const row = btn.closest('.aRow'); const u = usersCache.find((x) => x.id === row.dataset.id);
    if (btn.dataset.a === 'credit') { openSection('credits'); $('creditUser').value = u.id; return; }
    const val = Number(row.querySelector('input').value);
    if (btn.dataset.a === 'limit' && (!Number.isFinite(val) || val < 0)) return;
    btn.textContent = '…';
    try {
      await api('set-approval', { method: 'POST', body: btn.dataset.a === 'approve' ? { targetUserId: u.id, approved: !u.approved } : { targetUserId: u.id, monthlyMinuteLimit: val } });
      loadUsers();
    } catch (err) { btn.textContent = 'Failed'; }
  };
}

// ---------- usage ----------
async function loadUsage() {
  const el = $('sec-usage');
  el.innerHTML = '<div class="aHint">Loading…</div>';
  try {
    const { users } = await api('analytics', { qs: `&days=${range}` });
    if (!users.length) { el.innerHTML = `<div class="aHint">No calls in the last ${range} days.</div>`; return; }
    const max = Math.max(...users.map((u) => u.minutes), 1);
    el.innerHTML = users.map((u) => `<div class="aRow"><div class="aFlex"><div class="t" style="min-width:0">${esc(u.email)}</div><b>${num(u.minutes)}m</b></div>
      <div class="aBars" style="height:6px;margin:8px 0 4px;display:block;background:var(--line);border-radius:3px;"><i style="display:block;height:6px;width:${(u.minutes / max) * 100}%;border-radius:3px;"></i></div>
      <div class="m">${u.calls} call${u.calls === 1 ? '' : 's'}${u.lastActive ? ' · last ' + new Date(u.lastActive).toLocaleDateString() : ''}</div></div>`).join('');
  } catch (err) { fail(el, err); }
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

// ---------- costs: provider rates per call minute ----------
async function loadCosts() {
  const el = $('sec-costs');
  try {
    const { rates, currency, pricePerMin } = await api('rates');
    const field = (k, label) => `<div class="aField"><label>${label} (${currency} per call minute)</label><input type="number" min="0" step="0.001" id="rate_${k}" value="${rates[k] || ''}" placeholder="0"></div>`;
    el.innerHTML = `<div class="aCard"><div class="aHint" style="margin:0 0 12px;">Enter what each provider costs you per minute of call time, from your own bills. The panel multiplies this by minutes used to estimate cost and profit.</div>
      ${field('twilio', 'Twilio')}${field('fish', 'Fish Audio')}${field('openai', 'OpenAI')}
      <button class="aBtn" id="rateSave">Save rates</button><div class="aHint" id="rateHint"></div></div>
      <div class="aGrid" id="rateSummary" style="margin-top:12px;"></div>`;
    const summary = () => {
      const cost = ['twilio', 'fish', 'openai'].reduce((a, k) => a + (Number($(`rate_${k}`).value) || 0), 0);
      $('rateSummary').innerHTML = card('Your cost / min', money(cost, currency)) + card('You charge / min', pricePerMin ? money(pricePerMin, currency) : '—', 'avg of paid purchases')
        + (pricePerMin ? card('Margin / min', `<span class="${pricePerMin - cost < 0 ? 'aNeg' : 'aPos'}">${money(pricePerMin - cost, currency)}</span>`, `${((1 - cost / pricePerMin) * 100).toFixed(0)}% of price`, true) : '');
    };
    summary();
    ['twilio', 'fish', 'openai'].forEach((k) => { $(`rate_${k}`).oninput = summary; });
    $('rateSave').onclick = async () => {
      $('rateHint').textContent = 'Saving…';
      try { await api('rates', { method: 'POST', body: { twilio: $('rate_twilio').value || 0, fish: $('rate_fish').value || 0, openai: $('rate_openai').value || 0 } }); $('rateHint').textContent = 'Saved.'; }
      catch (err) { $('rateHint').textContent = err.message; }
    };
  } catch (err) { fail(el, err); }
}

// ---------- welcome/login/signup background gallery (images + video) ----------
async function loadBackgrounds() {
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
  const title = $('announceTitle').value.trim();
  const body = $('announceBody').value.trim();
  if (!title || !body) { $('announceHint').textContent = 'Fill in both fields.'; return; }
  $('announceHint').textContent = 'Sending…';
  const resp = await authedFetch('/api/admin?action=send-announcement', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, body }),
  });
  const data = await resp.json();
  if (!resp.ok) { $('announceHint').textContent = data.error || 'Send failed.'; return; }
  $('announceHint').textContent = `Sent to ${data.sent} of ${data.total} subscribed users.`;
  $('announceTitle').value = '';
  $('announceBody').value = '';
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
    if (data.session?.user) enterAdmin();
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
