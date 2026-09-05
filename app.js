import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Same pattern as Live Call: project URL is public by design, only the
// anon key ships to the client — every privileged action goes through
// api/*.js using the service-role key server-side instead.
const SUPABASE_URL = 'https://YOUR-PROJECT.supabase.co';
const SUPABASE_ANON_KEY = 'YOUR-ANON-KEY';
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const $ = (id) => document.getElementById(id);
let currentUser = null;
let currentSession = null;

async function authedFetch(url, options = {}) {
  const headers = { ...(options.headers || {}), Authorization: `Bearer ${currentSession?.access_token || ''}` };
  return fetch(url, { ...options, headers });
}

// ---------- tabs ----------
document.querySelectorAll('.tabBtn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tabBtn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active', 'fadeIn'));
    const target = $(`screen-${btn.dataset.tab}`);
    target.classList.add('active', 'fadeIn');
    if (btn.dataset.tab === 'recent') loadCalls();
    if (btn.dataset.tab === 'home') loadCallers();
  });
});

// ---------- auth ----------
const authScreen = $('authScreen');
let authMode = 'signin';

$('authToggleMode').addEventListener('click', () => {
  authMode = authMode === 'signin' ? 'signup' : 'signin';
  $('authSubmit').textContent = authMode === 'signin' ? 'Sign in' : 'Sign up';
  $('authToggleMode').innerHTML = authMode === 'signin' ? 'Need an account? <b>Sign up</b>' : 'Have an account? <b>Sign in</b>';
  $('authHint').textContent = '';
});

$('authSubmit').addEventListener('click', async () => {
  const email = $('authEmail').value.trim();
  const password = $('authPassword').value;
  if (!email || !password) { $('authHint').textContent = 'Enter an email and password.'; return; }
  $('authHint').textContent = 'Working...';
  const { error } = authMode === 'signin'
    ? await supabase.auth.signInWithPassword({ email, password })
    : await supabase.auth.signUp({ email, password });
  if (error) { $('authHint').textContent = error.message; return; }
  if (authMode === 'signup') $('authHint').textContent = 'Check your email to confirm, then wait for approval.';
});

$('googleSignIn').addEventListener('click', async () => {
  await supabase.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: window.location.origin } });
});

$('signOutBtn').addEventListener('click', () => supabase.auth.signOut());
$('pendingSignOut').addEventListener('click', () => supabase.auth.signOut());

async function checkApproval(userId) {
  const { data } = await supabase.from('user_approvals').select('approved').eq('user_id', userId).maybeSingle();
  return !!data?.approved;
}

async function enterApp(session) {
  currentSession = session;
  currentUser = session.user;
  const approved = await checkApproval(currentUser.id);
  if (!approved) {
    authScreen.classList.remove('hidden');
    $('authBoot').style.display = 'none';
    $('authBox').style.display = 'none';
    $('pendingBox').style.display = 'block';
    return;
  }
  $('authBoot').style.display = 'none';
  $('authBox').style.display = 'none';
  $('pendingBox').style.display = 'none';
  authScreen.classList.add('hidden');
  loadCallers();
}

supabase.auth.onAuthStateChange((_event, session) => {
  if (session?.user) {
    enterApp(session);
  } else {
    currentUser = null;
    currentSession = null;
    $('authBoot').style.display = 'none';
    $('authBox').style.display = '';
    $('pendingBox').style.display = 'none';
    authScreen.classList.remove('hidden');
  }
});

// ---------- AI callers ----------
async function loadCallers() {
  if (!currentSession) return;
  const resp = await authedFetch('/api/callers');
  if (!resp.ok) return;
  const { callers } = await resp.json();
  const list = $('callerList');
  list.innerHTML = '';
  if (!callers?.length) {
    list.innerHTML = `<div class="authHint" style="text-align:left;">No AI callers yet — create one to get started.</div>`;
    return;
  }
  for (const c of callers) {
    const el = document.createElement('div');
    el.className = 'callerCard';
    el.innerHTML = `
      <div class="callerAvatar">${(c.name || '?')[0].toUpperCase()}</div>
      <div>
        <div class="callerName">${c.name}</div>
        <div class="callerMeta">${c.personality}</div>
      </div>`;
    el.addEventListener('click', () => { window.__selectedCallerId = c.id; markSelected(el); });
    list.appendChild(el);
  }
}

function markSelected(el) {
  document.querySelectorAll('.callerCard').forEach((c) => c.style.outline = 'none');
  el.style.outline = `2px solid var(--accent)`;
}

$('newCallerBtn').addEventListener('click', async () => {
  const name = window.prompt('Name your AI caller:');
  if (!name) return;
  const instructions = window.prompt('How should it behave? e.g. "Be polite and natural, get to the point but greet first."') || '';
  const resp = await authedFetch('/api/callers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, instructions, personality: 'natural', voiceSource: 'cloned' }),
  });
  if (resp.ok) loadCallers();
});

// ---------- start a call ----------
$('startCallBtn').addEventListener('click', async () => {
  const toNumber = $('toNumber').value.trim();
  const objective = $('objective').value.trim();
  if (!toNumber || !objective) return;
  $('startCallBtn').disabled = true;
  $('startCallBtn').textContent = 'Calling...';
  const resp = await authedFetch('/api/calls-create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callerId: window.__selectedCallerId || null, toNumber, objective }),
  });
  const data = await resp.json();
  $('startCallBtn').disabled = false;
  $('startCallBtn').textContent = 'Start call';
  if (!resp.ok) { alert(data.error || 'Could not start call'); return; }
  $('toNumber').value = '';
  $('objective').value = '';
  document.querySelector('[data-tab="recent"]').click();
});

// ---------- recent calls ----------
async function loadCalls() {
  if (!currentSession) return;
  const resp = await authedFetch('/api/calls-list');
  if (!resp.ok) return;
  const { calls } = await resp.json();
  const list = $('callsList');
  list.innerHTML = '';
  if (!calls?.length) {
    list.innerHTML = `<div class="authHint" style="text-align:left;">No calls yet.</div>`;
    return;
  }
  for (const c of calls) {
    const el = document.createElement('div');
    el.className = 'card';
    el.innerHTML = `
      <div class="cardTitle">${c.to_number}</div>
      <div class="cardMeta">${c.objective}</div>
      ${c.outcome_summary ? `<div class="cardMeta" style="margin-top:6px;">${c.outcome_summary}</div>` : ''}
      <span class="statusPill ${c.status}">${c.status.replace('_', ' ')}</span>`;
    list.appendChild(el);
  }
}

// ---------- theme ----------
document.querySelectorAll('.themeSwatch').forEach((sw) => {
  sw.addEventListener('click', () => {
    document.querySelectorAll('.themeSwatch').forEach((s) => s.classList.remove('active'));
    sw.classList.add('active');
    document.documentElement.setAttribute('data-theme', sw.dataset.theme);
    localStorage.setItem('theme', sw.dataset.theme);
  });
});
const savedTheme = localStorage.getItem('theme');
if (savedTheme) {
  document.documentElement.setAttribute('data-theme', savedTheme);
  document.querySelector(`.themeSwatch[data-theme="${savedTheme}"]`)?.classList.add('active');
  document.querySelector('.themeSwatch.active:not([data-theme="' + savedTheme + '"])')?.classList.remove('active');
}

// ---------- voice cloning ----------
let mediaRecorder, recordedChunks = [];
$('recordVoiceBtn').addEventListener('click', async () => {
  const btn = $('recordVoiceBtn');
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.stop();
    return;
  }
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  recordedChunks = [];
  mediaRecorder = new MediaRecorder(stream);
  mediaRecorder.ondataavailable = (e) => recordedChunks.push(e.data);
  mediaRecorder.onstop = async () => {
    btn.classList.remove('recording');
    btn.textContent = 'Record 10-30s to clone your voice';
    $('voiceStatus').textContent = 'Uploading...';
    const blob = new Blob(recordedChunks, { type: 'audio/webm' });
    const audioBase64 = await blobToBase64(blob);
    const resp = await authedFetch('/api/voice-clone', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ audioBase64, mimeType: 'audio/webm' }),
    });
    $('voiceStatus').textContent = resp.ok ? 'Voice cloned.' : 'Could not clone voice — try a longer, quieter sample.';
    stream.getTracks().forEach((t) => t.stop());
  };
  mediaRecorder.start();
  btn.classList.add('recording');
  btn.textContent = 'Recording... tap to stop';
});

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
