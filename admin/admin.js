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

supabase.auth.onAuthStateChange((_event, session) => {
  currentSession = session;
  if (session?.user) enterAdmin();
  else showSignInForm();
});

async function enterAdmin() {
  // The /api/admin-* endpoints already check ADMIN_EMAIL server-side —
  // this call doubles as the gate for this page too, same source of truth,
  // no separate admin check to keep in sync.
  const resp = await authedFetch('/api/admin-list-users');
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
  renderUsers(await resp.json());
  loadBackgrounds();
  loadUsage();
}

// ---------- users: approve + per-user minute limit ----------
function renderUsers({ users }) {
  const list = $('adminUserList');
  list.innerHTML = '';
  for (const u of users) {
    const row = document.createElement('div');
    row.className = 'adminUserRow';
    row.style.flexDirection = 'column';
    row.style.alignItems = 'stretch';
    row.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center; gap:10px;">
        <div>
          <div class="adminUserEmail">${u.email}</div>
          <div class="adminUserMeta">${u.minutes_used}/${u.minutes_limit} min used this period</div>
        </div>
        <button class="adminApproveBtn ${u.approved ? 'approved' : ''}">${u.approved ? 'Approved' : 'Approve'}</button>
      </div>
      <div class="minuteLimitRow">
        <span style="font-size:11.5px; color:var(--dim);">Monthly limit</span>
        <input type="number" min="0" step="10" value="${u.minutes_limit}" class="minuteLimitInput">
        <button class="minuteLimitSave">Save</button>
      </div>`;

    row.querySelector('.adminApproveBtn').addEventListener('click', async () => {
      await authedFetch('/api/admin-set-approval', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetUserId: u.id, approved: !u.approved }),
      });
      const resp = await authedFetch('/api/admin-list-users');
      if (resp.ok) renderUsers(await resp.json());
    });

    row.querySelector('.minuteLimitSave').addEventListener('click', async (e) => {
      const input = row.querySelector('.minuteLimitInput');
      const val = Number(input.value);
      if (!Number.isFinite(val) || val < 0) return;
      e.target.textContent = 'Saving...';
      await authedFetch('/api/admin-set-approval', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetUserId: u.id, monthlyMinuteLimit: val }),
      });
      e.target.textContent = 'Saved';
      setTimeout(() => { e.target.textContent = 'Save'; }, 1200);
      const meta = row.querySelector('.adminUserMeta');
      meta.textContent = `${u.minutes_used}/${val} min used this period`;
    });

    list.appendChild(row);
  }
}

// ---------- welcome/login/signup background gallery ----------
async function loadBackgrounds() {
  const { data } = await supabase.from('auth_backgrounds').select('id,url').order('created_at', { ascending: false });
  const grid = $('bgGrid');
  grid.innerHTML = (data || []).map((row) => `
    <div class="bgCard">
      <img src="${row.url}" alt="">
      <button data-id="${row.id}" title="Remove">✕</button>
    </div>
  `).join('') || '<div class="authHint" style="grid-column:1/-1;">No images yet.</div>';

  grid.querySelectorAll('button[data-id]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      const resp = await authedFetch('/api/admin-upload-background', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'delete', id: btn.dataset.id }),
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
  if (!file) return;
  $('bgUploadStatus').textContent = 'Uploading...';
  const imageBase64 = await blobToBase64(file);
  const resp = await authedFetch('/api/admin-upload-background', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ imageBase64, mimeType: file.type }),
  });
  const data = await resp.json();
  $('bgFileInput').value = '';
  $('bgUploadStatus').textContent = resp.ok ? 'Added — the app fades between all uploaded images on the welcome, login and sign-up screens.' : (data.error || 'Upload failed.');
  if (resp.ok) loadBackgrounds();
});

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// ---------- usage ----------
async function loadUsage() {
  const list = $('adminUsageList');
  list.innerHTML = '<div class="authHint">Loading…</div>';
  const resp = await authedFetch('/api/admin-analytics');
  const data = await resp.json();
  if (!resp.ok) { list.innerHTML = `<div class="authHint">${data.error || 'Could not load usage.'}</div>`; return; }
  if (!data.users.length) { list.innerHTML = '<div class="authHint">No call activity yet.</div>'; return; }
  list.innerHTML = data.users.map((u) => `
    <div class="statRow">
      <div style="flex:1; min-width:0;">
        <div class="email">${u.email}</div>
        <div class="sub">${u.calls} call${u.calls === 1 ? '' : 's'}${u.lastActive ? ' · last active ' + new Date(u.lastActive).toLocaleDateString() : ''}</div>
      </div>
      <div class="total">${u.minutes}m</div>
    </div>
  `).join('');
}

// Don't rely solely on onAuthStateChange to ever fire — check the current
// session directly on load so the boot screen can't get stuck forever if
// that event is slow or doesn't arrive.
supabase.auth.getSession()
  .then(({ data }) => {
    currentSession = data.session;
    if (data.session?.user) enterAdmin();
    else showSignInForm();
  })
  .catch((err) => showBootError(err));

function showSignInForm() {
  $('authBoot').classList.add('hidden');
  $('authBox').classList.remove('hidden');
  $('notAdminBox').classList.add('hidden');
  $('adminApp').classList.add('hidden');
  document.getElementById('authScreen').classList.remove('hidden');
}

function showBootError(err) {
  $('authBoot').innerHTML = `<div style="text-align:center; padding:0 24px; color:var(--dim); font-size:13.5px;">Couldn't reach Supabase.<br>${(err && err.message) || String(err)}</div>`;
}
