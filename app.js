import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Same pattern as Live Call: project URL is public by design, only the
// anon key ships to the client — every privileged action goes through
// api/*.js using the service-role key server-side instead.
const SUPABASE_URL = 'https://gucblbvfzuraaozswfwd.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imd1Y2JsYnZmenVyYWFvenN3ZndkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU0NzQ0ODQsImV4cCI6MjA5MTA1MDQ4NH0.OCsEC_FfOJmoL5sQWP8zYnw9SmWuy4xggfcpIIxQw-c';
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
const ONBOARD_KEY = 'emysa_seen_onboarding';

function showAuthPanel(name) {
  document.querySelectorAll('.authPanel').forEach((p) => p.classList.remove('active'));
  $(`panel${name}`).classList.add('active');
}

function startAuthFlow() {
  showAuthPanel(localStorage.getItem(ONBOARD_KEY) ? 'Login' : 'GetStarted');
}

$('gsSignUp').addEventListener('click', () => { localStorage.setItem(ONBOARD_KEY, '1'); showAuthPanel('Signup'); });
$('gsLogIn').addEventListener('click', () => { localStorage.setItem(ONBOARD_KEY, '1'); showAuthPanel('Login'); });
$('loginBack').addEventListener('click', () => showAuthPanel('GetStarted'));
$('signupBack').addEventListener('click', () => showAuthPanel('GetStarted'));
$('loginToSignup').addEventListener('click', () => showAuthPanel('Signup'));
$('signupToLogin').addEventListener('click', () => showAuthPanel('Login'));

const EYE_OPEN = `<svg viewBox="0 0 24 24" fill="none"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" stroke="currentColor" stroke-width="1.6"/><circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="1.6"/></svg>`;
const EYE_OFF = `<svg viewBox="0 0 24 24" fill="none"><path d="M3 3l18 18M10.6 10.6a3 3 0 0 0 4.24 4.24M6.6 6.7C4.5 8.1 3 12 3 12s3.5 7 10 7c1.7 0 3.15-.47 4.36-1.13M9.9 4.24C10.58 4.09 11.28 4 12 4c6.5 0 10 7 10 7-.35.7-1.08 1.9-2.16 3.13" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`;

function wireEyeToggle(inputId, btnId) {
  const input = $(inputId), btn = $(btnId);
  btn.innerHTML = EYE_OPEN;
  btn.addEventListener('click', () => {
    const showing = input.type === 'text';
    input.type = showing ? 'password' : 'text';
    btn.innerHTML = showing ? EYE_OPEN : EYE_OFF;
  });
}
wireEyeToggle('loginPassword', 'loginEyeBtn');
wireEyeToggle('signupPassword', 'signupEyeBtn');

$('loginSubmit').addEventListener('click', async () => {
  const email = $('loginEmail').value.trim();
  const password = $('loginPassword').value;
  if (!email || !password) { $('loginHint').textContent = 'Enter your email and password.'; return; }
  $('loginHint').textContent = 'Working...';
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) $('loginHint').textContent = error.message;
});

$('signupSubmit').addEventListener('click', async () => {
  const fullName = $('signupName').value.trim();
  const email = $('signupEmail').value.trim();
  const password = $('signupPassword').value;
  if (!fullName || !email || !password) { $('signupHint').textContent = 'Fill in your name, email and password.'; return; }
  $('signupHint').textContent = 'Working...';
  const { error } = await supabase.auth.signUp({ email, password, options: { data: { full_name: fullName } } });
  if (error) { $('signupHint').textContent = error.message; return; }
  $('signupHint').textContent = 'Check your email to confirm, then wait for approval.';
});

$('loginGoogle').addEventListener('click', () => supabase.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: window.location.origin } }));
$('signupGoogle').addEventListener('click', () => supabase.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: window.location.origin } }));
// Apple sign-in needs the Apple provider enabled in Supabase Auth settings to actually work.
$('loginApple').addEventListener('click', () => supabase.auth.signInWithOAuth({ provider: 'apple', options: { redirectTo: window.location.origin } }));
$('signupApple').addEventListener('click', () => supabase.auth.signInWithOAuth({ provider: 'apple', options: { redirectTo: window.location.origin } }));

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
  $('authBoot').style.display = 'none';
  document.querySelectorAll('.authPanel').forEach((p) => p.classList.remove('active'));
  if (!approved) {
    authScreen.classList.remove('hidden');
    $('pendingBox').style.display = 'block';
    return;
  }
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
    $('pendingBox').style.display = 'none';
    authScreen.classList.remove('hidden');
    startAuthFlow();
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
  openCallScreen(data.callId, toNumber);
});

// ---------- active call screen ----------
let activeCallChannel = null;
let callTimerInterval = null;
let callAiMuted = false;

function openCallScreen(callId, toNumber) {
  $('callScreen').classList.remove('hidden');
  $('callContactAvatar').textContent = toNumber.replace(/[^0-9]/g, '').slice(-2) || '?';
  $('callTitleText').textContent = toNumber;
  $('transcriptPanel').innerHTML = '';
  $('waveRow').classList.remove('speaking');
  callAiMuted = false;
  $('callMuteBtn').classList.remove('active');

  const startedAt = Date.now();
  clearInterval(callTimerInterval);
  callTimerInterval = setInterval(() => {
    const secs = Math.floor((Date.now() - startedAt) / 1000);
    const m = String(Math.floor(secs / 60)).padStart(2, '0');
    const s = String(secs % 60).padStart(2, '0');
    $('callTimer').textContent = `${m}:${s}`;
  }, 1000);

  if (activeCallChannel) supabase.removeChannel(activeCallChannel);
  activeCallChannel = supabase
    .channel(`call-${callId}`)
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'calls', filter: `id=eq.${callId}` }, (payload) => {
      renderTranscript(payload.new.transcript || []);
      if (['completed', 'failed', 'no_answer'].includes(payload.new.status)) closeCallScreen();
    })
    .subscribe();

  $('callEndBtn').onclick = async () => {
    await authedFetch('/api/calls-hangup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callId }),
    });
    closeCallScreen();
  };

  $('callMuteBtn').onclick = async () => {
    callAiMuted = !callAiMuted;
    $('callMuteBtn').classList.toggle('active', callAiMuted);
    await authedFetch('/api/calls-mute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callId, muted: callAiMuted }),
    });
  };

  // Audio (speaker route) and Keypad (DTMF) aren't wired to anything real
  // yet — this app doesn't currently pipe live audio to the browser, and
  // sending in-call DTMF safely alongside the media stream needs more
  // work. They're here for visual parity with the reference call screen.
  $('callAudioBtn').onclick = () => $('callAudioBtn').classList.toggle('active');
  $('callKeypadBtn').onclick = () => alert('Keypad during a live AI call is not wired up yet.');
}

function closeCallScreen() {
  clearInterval(callTimerInterval);
  if (activeCallChannel) { supabase.removeChannel(activeCallChannel); activeCallChannel = null; }
  $('callScreen').classList.add('hidden');
  loadCalls();
}

function renderTranscript(history) {
  const panel = $('transcriptPanel');
  panel.innerHTML = '';
  for (const line of history) {
    const el = document.createElement('div');
    el.className = `transcriptLine ${line.speaker}`;
    el.innerHTML = `<div class="transcriptDot"></div><div class="transcriptBubble">${line.content}</div>`;
    panel.appendChild(el);
  }
  panel.scrollTop = panel.scrollHeight;
  const last = history[history.length - 1];
  $('waveRow').classList.toggle('speaking', last?.speaker === 'ai');
}

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

// ---------- admin ----------
// The tab only appears if the admin-only endpoint actually accepts this
// user — server-side ADMIN_EMAIL check decides that, not anything in this
// client code, so this is just about not showing the tab to people it
// would reject anyway.
// ---------- login background (set by the admin app, shown here) ----------
function applyAuthBackground(url) {
  authScreen.style.backgroundImage = `linear-gradient(rgba(10,8,6,0.55), rgba(10,8,6,0.85)), url('${url}')`;
  authScreen.style.backgroundSize = 'cover';
  authScreen.style.backgroundPosition = 'center';
}

// Public read (no sign-in needed) so the login screen itself can be
// themed before anyone has authenticated.
(async () => {
  const { data } = await supabase.from('app_settings').select('value').eq('key', 'auth_background_url').maybeSingle();
  if (data?.value) applyAuthBackground(data.value);
})();
