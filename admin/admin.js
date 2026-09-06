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
}

function renderUsers({ users }) {
  const list = $('adminUserList');
  list.innerHTML = '';
  for (const u of users) {
    const row = document.createElement('div');
    row.className = 'adminUserRow';
    row.innerHTML = `
      <div>
        <div class="adminUserEmail">${u.email}</div>
        <div class="adminUserMeta">${u.minutes_used}/${u.minutes_limit} min used this period</div>
      </div>
      <button class="adminApproveBtn ${u.approved ? 'approved' : ''}">${u.approved ? 'Approved' : 'Approve'}</button>`;
    row.querySelector('button').addEventListener('click', async () => {
      await authedFetch('/api/admin-set-approval', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetUserId: u.id, approved: !u.approved }),
      });
      const resp = await authedFetch('/api/admin-list-users');
      if (resp.ok) renderUsers(await resp.json());
    });
    list.appendChild(row);
  }
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
  $('bgUploadStatus').textContent = resp.ok ? 'Background updated — it will show on the main app\'s welcome, login and sign-up screens.' : (data.error || 'Upload failed.');
});

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
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
