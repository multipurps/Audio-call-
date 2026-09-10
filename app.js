import { createClient } from './vendor/supabase.js';

// Installed PWAs (especially iOS "Add to Home Screen") can keep showing a
// stale build after a new deploy, since there's no browser reload gesture
// to trigger a re-fetch. Check a small version marker on every open; if it
// doesn't match what we last saw, force one reload to pick up the new code.
// The sessionStorage guard stops a reload loop if the check itself is
// flaky offline.
(async () => {
  try {
    const resp = await fetch('/version.json', { cache: 'no-store' });
    const { version } = await resp.json();
    const seen = localStorage.getItem('appVersion');
    if (seen && seen !== version && !sessionStorage.getItem('reloadedForVersion')) {
      sessionStorage.setItem('reloadedForVersion', '1');
      localStorage.setItem('appVersion', version);
      location.reload();
      return;
    }
    localStorage.setItem('appVersion', version);
  } catch {
    // offline or blocked — just continue with whatever's already loaded
  }
})();

// Same pattern as Live Call: project URL is public by design, only the
// anon key ships to the client — every privileged action goes through
// api/*.js using the service-role key server-side instead.
const SUPABASE_URL = 'https://gucblbvfzuraaozswfwd.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imd1Y2JsYnZmenVyYWFvenN3ZndkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU0NzQ0ODQsImV4cCI6MjA5MTA1MDQ4NH0.OCsEC_FfOJmoL5sQWP8zYnw9SmWuy4xggfcpIIxQw-c';
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const $ = (id) => document.getElementById(id);
let currentUser = null;
let currentSession = null;

// ---------- iOS PWA true-height fix ----------
// In standalone (home-screen installed) mode, iOS Safari sizes anything
// using position:fixed against a shrunk internal "layout viewport" that's
// shorter than the real screen — no CSS height (100dvh, -webkit-fill-available,
// even a JS-measured innerHeight) can see past that cap, so fixed full-bleed
// screens end up with a gap above the home indicator no matter what number
// you feed them.
//
// The fix is to stop relying on position:fixed for full-bleed layout at all:
// body stays position:relative (set in CSS) and gets its height set here
// directly from window.screen.height, which reports the true physical
// screen size rather than the shrunk one. Every full-bleed screen
// (#app, #authScreen, #callScreen, .sheetScreen, #tabBar, #homeInputBar) is
// position:absolute anchored inside that correctly-sized body, and absolute
// positioning isn't subject to the same iOS cap — it just fills whatever
// box it's given.
function isStandalonePWA() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

function setAppHeight() {
  if (!isStandalonePWA()) return; // normal browser tabs are fine with the dvh/fill-available CSS fallback
  const h = window.screen.height;
  if (h) document.body.style.height = `${h}px`;
}

setAppHeight();
window.addEventListener('resize', setAppHeight);
window.addEventListener('orientationchange', setAppHeight);

async function authedFetch(url, options = {}) {
  const headers = { ...(options.headers || {}), Authorization: `Bearer ${currentSession?.access_token || ''}` };
  return fetch(url, { ...options, headers });
}

// ---------- tabs ----------
let gliderReady = false;
function moveTabGlider(name) {
  const glider = $('tabGlider');
  const btn = document.querySelector(`#tabBar .tabBtn[data-tab="${name}"]`);
  if (!glider || !btn) return;
  const barRect = $('tabBar').getBoundingClientRect();
  const btnRect = btn.getBoundingClientRect();
  if (btnRect.width === 0) return;
  if (!gliderReady) {
    // Suppress the transition for the very first placement so the glider
    // doesn't visibly slide in from a default position on load — that's
    // what was reading as the app "moving around" on open.
    glider.style.transition = 'none';
    gliderReady = true;
    requestAnimationFrame(() => { glider.style.transition = ''; });
  }
  glider.style.transform = `translateX(${btnRect.left - barRect.left - 6}px)`;
}

document.querySelectorAll('.tabBtn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tabBtn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active', 'fadeIn'));
    const target = $(`screen-${btn.dataset.tab}`);
    target.classList.add('active', 'fadeIn');
    moveTabGlider(btn.dataset.tab);
    $('homeInputBar').classList.toggle('visible', btn.dataset.tab === 'home');
    if (btn.dataset.tab === 'recent') loadCalls();
    if (btn.dataset.tab === 'profile') renderProfileHeader();
    if (btn.dataset.tab === 'home') startMessagePolling(); else stopMessagePolling();
  });
});
window.addEventListener('resize', () => {
  moveTabGlider(document.querySelector('#tabBar .tabBtn.active')?.dataset.tab || 'home');
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
$('pendingRecheck').addEventListener('click', () => { if (currentSession) enterApp(currentSession); });

// ---------- push notifications ----------
const VAPID_PUBLIC_KEY = 'BERe9PaZxK_8m5HY4fqmzJrDcjXd5jDrcgrV8GTiiWC_HXWVKXM-li-jHId_oJ9CE73EYlxTQPhlAOlG_4NdgHw';

function urlBase64ToUint8Array(base64String) {
  const padded = (base64String + '='.repeat((4 - (base64String.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(padded);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

async function ensureNotificationsEnabled() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    if (await reg.pushManager.getSubscription()) return;
    if (Notification.permission === 'denied') return;
    if ((await Notification.requestPermission()) !== 'granted') return;
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
    });
    await fetch('/api/save-push-subscription', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${currentSession?.access_token || ''}` },
      body: JSON.stringify({ subscription: sub.toJSON() }),
    });
  } catch (err) {
    console.error('ensureNotificationsEnabled failed:', err);
  }
}

async function checkApproval(userId) {
  const { data } = await supabase.from('user_approvals').select('approved').eq('user_id', userId).maybeSingle();
  return !!data?.approved;
}

// A user stuck on the pending screen had no way to find out they'd been
// approved short of signing out and back in — poll while pending so
// approval takes effect on its own.
let pendingPollTimer = null;
function stopPendingPoll() {
  if (pendingPollTimer) { clearInterval(pendingPollTimer); pendingPollTimer = null; }
}
function startPendingPoll() {
  stopPendingPoll();
  pendingPollTimer = setInterval(async () => {
    if (!currentUser) { stopPendingPoll(); return; }
    const approved = await checkApproval(currentUser.id);
    if (approved) { stopPendingPoll(); enterApp(currentSession); }
  }, 15000);
}

async function enterApp(session) {
  currentSession = session;
  currentUser = session.user;
  // This Supabase project may be shared with other apps of yours — mark this
  // user as belonging to Audio Call so the admin's user list can filter to
  // just this app instead of showing every account on the shared project.
  // Best-effort only: this must never block the boot sequence below.
  try {
    await supabase.from('profiles').upsert(
      { user_id: currentUser.id },
      { onConflict: 'user_id', ignoreDuplicates: true }
    );
  } catch (err) {
    console.error('profile tagging failed (non-fatal):', err);
  }
  const approved = await checkApproval(currentUser.id);
  $('authBoot').style.display = 'none';
  document.querySelectorAll('.authPanel').forEach((p) => p.classList.remove('active'));
  if (!approved) {
    authScreen.classList.remove('hidden');
    $('pendingBox').style.display = 'block';
    startPendingPoll();
    return;
  }
  stopPendingPoll();
  $('pendingBox').style.display = 'none';
  authScreen.classList.add('hidden');
  ensureNotificationsEnabled();
  renderProfileHeader();
  initHomeChat();
  moveTabGlider('home');
}

function renderAvatar(url) {
  const el = $('profileAvatarCircle');
  const initial = ($('profileEmailDisplay').textContent || currentUser?.email || '?')[0].toUpperCase();
  if (url) {
    el.innerHTML = `<img src="${url}" alt="">`;
  } else {
    el.textContent = initial;
  }
}

async function renderProfileHeader() {
  if (!currentUser) return;
  const { data } = await supabase.from('profiles').select('avatar_url, name, language').eq('user_id', currentUser.id).maybeSingle();
  const displayName = data?.name || (currentUser.email || '').split('@')[0] || 'You';
  $('profileEmailDisplay').textContent = displayName;
  renderAvatar(data?.avatar_url || null);
  if (data?.name && !$('profileName').value) $('profileName').value = data.name;
  if (data?.language) $('profileLanguage').value = data.language;
}

supabase.auth.onAuthStateChange((_event, session) => {
  if (session?.user) {
    enterApp(session);
  } else {
    currentUser = null;
    currentSession = null;
    stopMessagePolling();
    $('authBoot').style.display = 'none';
    $('pendingBox').style.display = 'none';
    authScreen.classList.remove('hidden');
    startAuthFlow();
  }
});

// Don't rely solely on onAuthStateChange to ever fire — check the current
// session directly on load too, so the splash screen can't get stuck
// forever if that event is slow, doesn't arrive, or something above throws.
supabase.auth.getSession()
  .then(({ data }) => {
    if (data.session?.user && !currentUser) enterApp(data.session);
    else if (!data.session && $('authBoot').style.display !== 'none') {
      $('authBoot').style.display = 'none';
      authScreen.classList.remove('hidden');
      startAuthFlow();
    }
  })
  .catch((err) => {
    console.error('getSession failed:', err);
    $('authBoot').style.display = 'none';
    authScreen.classList.remove('hidden');
    startAuthFlow();
  });

// ---------- Home: chat with the assistant (Emysa) ----------
// Replaces the old "type a raw phone number" composer: you talk to the
// assistant in plain language, it looks up who you mean in your saved
// Contacts, places the call itself, and status updates (busy, no answer,
// finished) get posted back into this same thread asynchronously by the
// Twilio status webhook (api/calls-status.js) — see api/assistant.js for
// the actual orchestration.
let homeMessageIds = new Set();
let pollTimer = null;
let currentChatSessionId = null;

function greetingForNow(name) {
  const h = new Date().getHours();
  const time = h < 5 ? 'night' : h < 12 ? 'morning' : h < 17 ? 'afternoon' : h < 21 ? 'evening' : 'night';
  const who = name ? `, ${name}` : '';
  return `Good ${time}${who}, what can I help you with today?`;
}

async function initHomeChat() {
  if (!currentUser) return;
  const { data } = await supabase.from('profiles').select('name').eq('user_id', currentUser.id).maybeSingle();
  const displayName = data?.name || (currentUser.email || '').split('@')[0];
  $('homeIdleGreeting').textContent = greetingForNow(displayName);

  const resp = await authedFetch('/api/assistant?action=messages');
  if (resp.ok) {
    const { messages, sessionId } = await resp.json();
    currentChatSessionId = sessionId || null;
    renderHomeMessages(messages || [], true);
  }
  startMessagePolling();
  resumeActiveCallIfAny();
}

async function openChatSession(sessionId) {
  stopMessagePolling();
  currentChatSessionId = sessionId;
  homeMessageIds.clear();
  $('homeChat').innerHTML = '';
  setHomeChatActive(false);
  const resp = await authedFetch(`/api/assistant?action=messages&sessionId=${encodeURIComponent(sessionId)}`);
  if (resp.ok) {
    const { messages } = await resp.json();
    renderHomeMessages(messages || [], true);
  }
  startMessagePolling();
}

function startNewChat() {
  stopMessagePolling();
  currentChatSessionId = null;
  homeMessageIds.clear();
  $('homeChat').innerHTML = '';
  setHomeChatActive(false);
}

function setHomeChatActive(active) {
  $('homeIdle').classList.toggle('hidden', active);
  $('homeChat').classList.toggle('hidden', !active);
  $('homeHeaderLogoWrap').classList.toggle('hidden', !active);
}

function renderHomeMessages(messages, replaceAll) {
  if (replaceAll) {
    $('homeChat').innerHTML = '';
    homeMessageIds.clear();
  }
  let added = false;
  let lastDay = replaceAll ? null : dayKey(lastRenderedAt());
  for (const m of messages) {
    if (homeMessageIds.has(m.id)) continue;
    homeMessageIds.add(m.id);
    added = true;
    const day = dayKey(m.created_at);
    if (day !== lastDay) {
      const div = document.createElement('div');
      div.className = 'chatDayDivider';
      div.textContent = formatDayLabel(m.created_at);
      $('homeChat').appendChild(div);
      lastDay = day;
    }
    appendChatBubble(m);
  }
  if (added) setHomeChatActive(true);
  if (added || replaceAll) {
    if (messages.length === 0) setHomeChatActive(false);
    $('homeChat').scrollTop = $('homeChat').scrollHeight;
  }
}

function lastRenderedAt() {
  const nodes = $('homeChat').querySelectorAll('[data-created]');
  return nodes.length ? nodes[nodes.length - 1].dataset.created : null;
}

function dayKey(iso) {
  if (!iso) return null;
  return new Date(iso).toDateString();
}

function formatDayLabel(iso) {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === yesterday.toDateString()) return `Yesterday ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function appendChatBubble(m) {
  const el = document.createElement('div');
  el.className = `chatMsg ${m.role === 'user' ? 'chatMsgUser' : 'chatMsgAssistant'}`;
  el.dataset.created = m.created_at;
  el.textContent = m.content;
  if (m.call_id) {
    el.classList.add('chatMsgTappable');
    el.addEventListener('click', () => openCallFromMessage(m.call_id));
  }
  $('homeChat').appendChild(el);
}

async function openCallFromMessage(callId) {
  const resp = await authedFetch('/api/calls?action=list');
  if (!resp.ok) return;
  const { calls } = await resp.json();
  const call = (calls || []).find((c) => c.id === callId);
  if (!call || !['queued', 'ringing', 'in_progress'].includes(call.status)) return; // call's over, nothing live to show
  openCallScreen(call.id, call.to_number, call.contact_name);
}

// ---------- Header logo: shows a spinning ring while a call placed from
// this chat is actually happening, and opens the live call screen (with
// transcript) when tapped. ----------
let activeHeaderCall = null; // { id, toNumber, contactName } | null
let headerCallChannel = null;

function trackActiveCall(callId, toNumber, contactName) {
  activeHeaderCall = { id: callId, toNumber, contactName };
  $('homeHeaderLogoWrap').classList.add('calling');
  if (headerCallChannel) supabase.removeChannel(headerCallChannel);
  headerCallChannel = supabase
    .channel(`header-call-${callId}`)
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'calls', filter: `id=eq.${callId}` }, (payload) => {
      if (['completed', 'failed', 'no_answer'].includes(payload.new.status)) clearActiveCall();
    })
    .subscribe();
}

function clearActiveCall() {
  activeHeaderCall = null;
  $('homeHeaderLogoWrap').classList.remove('calling');
  if (headerCallChannel) { supabase.removeChannel(headerCallChannel); headerCallChannel = null; }
}

// If a call placed earlier is still going (app was backgrounded, tab
// switched away, page reloaded), pick the ring back up rather than losing
// the indicator until the next message.
async function resumeActiveCallIfAny() {
  const resp = await authedFetch('/api/calls?action=list');
  if (!resp.ok) return;
  const { calls } = await resp.json();
  const live = (calls || []).find((c) => ['queued', 'ringing', 'in_progress'].includes(c.status));
  if (live) trackActiveCall(live.id, live.to_number, live.contact_name);
}

$('homeHeaderLogoWrap').addEventListener('click', () => {
  if (activeHeaderCall) openCallScreen(activeHeaderCall.id, activeHeaderCall.toNumber, activeHeaderCall.contactName);
});

async function sendChatMessage(text, onReply) {
  appendChatBubble({ id: `local-${Date.now()}`, role: 'user', content: text, created_at: new Date().toISOString() });
  setHomeChatActive(true);
  $('homeChat').scrollTop = $('homeChat').scrollHeight;

  const resp = await authedFetch('/api/assistant?action=send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, sessionId: currentChatSessionId }),
  });
  const data = await resp.json();
  if (!resp.ok) {
    const errText = data.error || 'Something went wrong.';
    appendChatBubble({ id: `err-${Date.now()}`, role: 'assistant', content: errText, created_at: new Date().toISOString() });
    if (onReply) onReply(errText);
    return;
  }
  if (data.sessionId) currentChatSessionId = data.sessionId;
  if (data.callId && data.toNumber) trackActiveCall(data.callId, data.toNumber, data.contactName);
  // The optimistic user bubble above already shows this turn; mark the
  // server's saved copy of it as seen (without re-rendering) so the next
  // poll doesn't draw a second, duplicate copy of the same user message.
  const savedUserMsg = (data.messages || []).find((m) => m.role === 'user');
  if (savedUserMsg) homeMessageIds.add(savedUserMsg.id);
  const replies = (data.messages || []).filter((m) => m.role !== 'user');
  renderHomeMessages(replies, false);
  if (onReply) onReply(replies.map((m) => m.content).join(' ') || '');
}

async function sendBrief() {
  const text = $('briefInput').value.trim();
  if (!text) return;
  $('sendBtn').disabled = true;
  $('briefInput').value = '';
  $('briefInput').style.height = 'auto';
  await sendChatMessage(text);
  $('sendBtn').disabled = false;
}

$('sendBtn').addEventListener('click', sendBrief);
$('briefInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendBrief(); }
});
$('briefInput').addEventListener('input', () => {
  const el = $('briefInput');
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 120) + 'px';
});

function startMessagePolling() {
  if (pollTimer || !currentUser) return;
  pollTimer = setInterval(async () => {
    if (!currentChatSessionId) return;
    const resp = await authedFetch(`/api/assistant?action=messages&sessionId=${encodeURIComponent(currentChatSessionId)}`);
    if (!resp.ok) return;
    const { messages } = await resp.json();
    renderHomeMessages(messages || [], false);
  }, 5000);
}
function stopMessagePolling() {
  clearInterval(pollTimer);
  pollTimer = null;
}

// ---------- Home header: hamburger menu (Saved Chats) + wave (voice input) ----------
function monthGroupLabel(iso) {
  return new Date(iso).toLocaleDateString([], { month: 'long', year: new Date(iso).getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
}
function shortDateLabel(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

let savedChatSessions = [];

async function loadSavedChats() {
  const list = $('savedChatsList');
  list.innerHTML = '<div class="authHint">Loading…</div>';
  const resp = await authedFetch('/api/assistant?action=sessions');
  if (!resp.ok) { list.innerHTML = '<div class="authHint">Could not load saved chats.</div>'; return; }
  const { sessions } = await resp.json();
  savedChatSessions = sessions || [];
  renderSavedChats(savedChatSessions);
}

function renderSavedChats(sessions) {
  const list = $('savedChatsList');
  if (!sessions.length) {
    list.innerHTML = '<div class="authHint" style="margin-top:20px;">No saved chats yet — start one from Home.</div>';
    return;
  }
  let lastGroup = null;
  list.innerHTML = '';
  for (const s of sessions) {
    const group = monthGroupLabel(s.updated_at);
    if (group !== lastGroup) {
      const h = document.createElement('div');
      h.className = 'sectionLabel';
      h.textContent = group;
      list.appendChild(h);
      lastGroup = group;
    }
    const row = document.createElement('div');
    row.className = 'savedChatRow';
    row.innerHTML = `<div class="savedChatTitle">${s.title}</div><div class="savedChatDate">${shortDateLabel(s.updated_at)}</div>`;
    row.addEventListener('click', () => { openChatSession(s.id); closeSheets(); });
    list.appendChild(row);
  }
}

$('savedChatsSearch').addEventListener('input', () => {
  const q = $('savedChatsSearch').value.trim().toLowerCase();
  renderSavedChats(!q ? savedChatSessions : savedChatSessions.filter((s) => s.title.toLowerCase().includes(q)));
});

$('newChatBtn').addEventListener('click', () => { startNewChat(); closeSheets(); });
$('homeMenuBtn').addEventListener('click', () => { loadSavedChats(); openSheet('sheet-home-menu'); });

let waveRecorder = null;
let waveChunks = [];
let assistantCallOpen = false;
let assistantListening = false;
let assistantMuted = false;

function appendCallTranscriptLine(speaker, content) {
  const panel = $('transcriptPanel');
  const el = document.createElement('div');
  el.className = `transcriptLine ${speaker}`;
  el.innerHTML = `<div class="transcriptDot"></div><div class="transcriptBubble">${content}</div>`;
  panel.appendChild(el);
  panel.scrollTop = panel.scrollHeight;
}

function openAssistantCallScreen() {
  assistantCallOpen = true;
  assistantMuted = false;
  $('callScreen').classList.remove('hidden');
  $('callScreen').classList.add('assistantMode');
  $('callContactAvatar').style.display = 'none';
  $('callTitleText').textContent = 'Emysa';
  $('transcriptPanel').innerHTML = '';
  $('waveRow').classList.remove('speaking');
  $('callMuteBtn').classList.remove('active');

  const startedAt = Date.now();
  clearInterval(callTimerInterval);
  callTimerInterval = setInterval(() => {
    const secs = Math.floor((Date.now() - startedAt) / 1000);
    const m = String(Math.floor(secs / 60)).padStart(2, '0');
    const s = String(secs % 60).padStart(2, '0');
    $('callTimer').textContent = `${m}:${s}`;
  }, 1000);

  $('callEndBtn').onclick = () => {
    if (waveRecorder && waveRecorder.state === 'recording') waveRecorder.stop();
    assistantCallOpen = false;
    clearInterval(callTimerInterval);
    $('callScreen').classList.add('hidden');
    $('callScreen').classList.remove('assistantMode');
    $('callContactAvatar').style.display = '';
  };
  $('callMuteBtn').onclick = () => {
    assistantMuted = !assistantMuted;
    $('callMuteBtn').classList.toggle('active', assistantMuted);
    if (assistantMuted && waveRecorder?.state === 'recording') waveRecorder.stop();
    else if (!assistantMuted && assistantCallOpen) startAssistantListening();
  };
  $('callAudioBtn').onclick = () => $('callAudioBtn').classList.toggle('active');
  $('callKeypadBtn').onclick = () => {};
  $('waveRow').onclick = () => {
    if (waveRecorder && waveRecorder.state === 'recording') waveRecorder.stop();
    else if (!assistantListening) startAssistantListening();
  };

  startAssistantListening();
}

async function startAssistantListening() {
  if (assistantListening || assistantMuted || !assistantCallOpen) return;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    waveChunks = [];
    // Don't hardcode a mimeType — Safari/iOS doesn't support webm at all
    // and silently records something else regardless of what you ask for,
    // so pick from what this browser actually says it supports and use
    // that same real value later, instead of always claiming "audio/webm".
    const recorderMime = ['audio/webm', 'audio/mp4', 'audio/aac', 'audio/ogg']
      .find((t) => window.MediaRecorder?.isTypeSupported?.(t)) || '';
    waveRecorder = recorderMime ? new MediaRecorder(stream, { mimeType: recorderMime }) : new MediaRecorder(stream);
    assistantListening = true;
    $('waveRow').classList.add('speaking');
    waveRecorder.ondataavailable = (e) => waveChunks.push(e.data);

    // Auto-stop on silence, the same idea as the phone-call relay's turn
    // detection — without this, recording only ever ended if the person
    // tapped the wave a second time, which they had no reason to know to
    // do, and just looked like the assistant never responding.
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 512;
    audioCtx.createMediaStreamSource(stream).connect(analyser);
    const levels = new Uint8Array(analyser.frequencyBinCount);
    let hasSpoken = false;
    let lastLoudAt = Date.now();
    let watchdog = null;

    function checkSilence() {
      if (!waveRecorder || waveRecorder.state !== 'recording') return;
      analyser.getByteTimeDomainData(levels);
      let sumSq = 0;
      for (let i = 0; i < levels.length; i++) { const v = (levels[i] - 128) / 128; sumSq += v * v; }
      const volume = Math.sqrt(sumSq / levels.length);
      const now = Date.now();
      if (volume > 0.04) { hasSpoken = true; lastLoudAt = now; }
      if (hasSpoken && now - lastLoudAt > 900) { waveRecorder.stop(); return; }
      if (!hasSpoken && now - lastLoudAt > 8000) { waveRecorder.stop(); return; } // gave up waiting for any speech at all
      watchdog = requestAnimationFrame(checkSilence);
    }
    watchdog = requestAnimationFrame(checkSilence);

    waveRecorder.onstop = async () => {
      cancelAnimationFrame(watchdog);
      audioCtx.close().catch(() => {});
      stream.getTracks().forEach((t) => t.stop());
      assistantListening = false;
      $('waveRow').classList.remove('speaking');
      if (!waveChunks.length || !assistantCallOpen || !hasSpoken) return;
      try {
        const actualMime = waveRecorder.mimeType || recorderMime || 'audio/webm';
        const blob = new Blob(waveChunks, { type: actualMime });
        const base64 = await blobToBase64(blob);
        const resp = await authedFetch('/api/assistant?action=transcribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ audioBase64: base64, mimeType: actualMime }),
        });
        const data = await resp.json();
        if (!assistantCallOpen) return;
        if (resp.ok && data.text?.trim()) {
          appendCallTranscriptLine('user', data.text.trim());
          await sendChatMessage(data.text.trim(), (reply) => {
            if (assistantCallOpen && reply) appendCallTranscriptLine('ai', reply);
          });
        } else if (!resp.ok) {
          appendCallTranscriptLine('ai', data.error || "Sorry, I didn't catch that.");
        }
      } catch (err) {
        // A silent failure here used to mean the whole turn just vanished
        // with no feedback at all — now it always shows something.
        if (assistantCallOpen) appendCallTranscriptLine('ai', "Sorry, something went wrong there — try again.");
      }
      if (assistantCallOpen && !assistantMuted) startAssistantListening();
    };
    waveRecorder.start();
  } catch (err) {
    assistantListening = false;
    alert('Microphone access is needed to talk to Emysa by voice.');
  }
}

$('homeWaveBtn').addEventListener('click', () => openAssistantCallScreen());

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// ---------- Contacts (so the assistant can call people by name) ----------
async function loadContacts() {
  const resp = await authedFetch('/api/contacts');
  if (!resp.ok) return;
  const { contacts } = await resp.json();
  const list = $('contactsList');
  list.innerHTML = '';
  if (!contacts?.length) {
    list.innerHTML = `<div class="authHint" style="text-align:left;">No contacts saved yet.</div>`;
    return;
  }
  for (const c of contacts) {
    const el = document.createElement('div');
    el.className = 'profileCard';
    el.innerHTML = `
      <div class="cIcon">${(c.name || '?')[0].toUpperCase()}</div>
      <div class="cBody"><div class="cValue">${c.name}</div><div class="cLabel">${c.phone_number}</div></div>`;
    const del = document.createElement('button');
    del.className = 'plainInput';
    del.style.cssText = 'width:auto; padding:8px 12px; cursor:pointer; color:#ff6b6b;';
    del.textContent = 'Remove';
    del.addEventListener('click', async () => {
      await authedFetch('/api/contacts', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: c.id }) });
      loadContacts();
    });
    el.appendChild(del);
    list.appendChild(el);
  }
}

$('addContactBtn').addEventListener('click', async () => {
  const name = $('newContactName').value.trim();
  const phoneNumber = $('newContactPhone').value.trim();
  if (!name || !phoneNumber) { $('contactStatus').textContent = 'Name and phone number are both required.'; return; }
  $('contactStatus').textContent = 'Saving…';
  const resp = await authedFetch('/api/contacts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, phoneNumber }),
  });
  const data = await resp.json();
  if (!resp.ok) { $('contactStatus').textContent = data.error || 'Could not save contact.'; return; }
  $('newContactName').value = '';
  $('newContactPhone').value = '';
  $('contactStatus').textContent = 'Contact added.';
  loadContacts();
});

// ---------- active call screen ----------
let activeCallChannel = null;
let callTimerInterval = null;
let callAiMuted = false;

function openCallScreen(callId, toNumber, contactName) {
  $('callScreen').classList.remove('hidden');
  $('callScreen').classList.remove('assistantMode');
  $('callContactAvatar').style.display = '';
  const displayName = contactName || toNumber;
  $('callContactAvatar').textContent = (contactName ? contactName[0] : toNumber.replace(/[^0-9]/g, '').slice(-2)) || '?';
  $('callTitleText').textContent = `Emysa & ${displayName}`;
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
    await authedFetch('/api/calls?action=hangup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callId }),
    });
    clearActiveCall();
    closeCallScreen();
  };

  $('callMuteBtn').onclick = async () => {
    callAiMuted = !callAiMuted;
    $('callMuteBtn').classList.toggle('active', callAiMuted);
    await authedFetch('/api/calls?action=mute', {
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
    const dot = line.speaker === 'ai' ? '<img src="icon-192.png" alt="">' : '';
    el.innerHTML = `<div class="transcriptDot">${dot}</div><div class="transcriptBubble">${line.content}</div>`;
    panel.appendChild(el);
  }
  panel.scrollTop = panel.scrollHeight;
  const last = history[history.length - 1];
  $('waveRow').classList.toggle('speaking', last?.speaker === 'ai');
}

// ---------- recent calls ----------
function relativeCallDate(iso) {
  const d = new Date(iso);
  const now = new Date();
  const diffDays = Math.floor((now.setHours(0, 0, 0, 0) - new Date(d).setHours(0, 0, 0, 0)) / 86400000);
  if (diffDays === 0) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (diffDays === 1) return 'Yesterday';
  if (diffDays > 1 && diffDays < 7) return d.toLocaleDateString([], { weekday: 'long' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function callSummaryLine(c) {
  if (c.outcome_summary) return c.outcome_summary;
  const name = c.contact_name || c.to_number;
  switch (c.status) {
    case 'queued': return 'Starting the call…';
    case 'ringing': return `Calling ${name}…`;
    case 'in_progress': return `On the call with ${name}`;
    case 'no_answer': return `Reached ${name}'s voicemail and hung up`;
    case 'failed': return `Couldn't reach ${name} — the call failed to connect`;
    case 'completed': return c.duration_seconds
      ? `Finished the call with ${name} (about ${Math.max(1, Math.round(c.duration_seconds / 60))} min)`
      : `Finished the call with ${name}`;
    default: return c.objective || '';
  }
}

// Deterministic per-contact hue so the same person always gets the same
// avatar color across the list, without storing anything extra.
function hueForName(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) % 360;
  return hash;
}

let lastLoadedCalls = [];

function renderCallsList(calls) {
  const list = $('callsList');
  list.innerHTML = '';
  if (!calls?.length) {
    list.innerHTML = `<div class="authHint" style="text-align:left;">No calls yet.</div>`;
    return;
  }
  for (const c of calls) {
    const name = c.contact_name || c.to_number;
    const hue = hueForName(name);
    const el = document.createElement('div');
    el.className = 'recentRow';
    el.innerHTML = `
      <div class="recentAvatar" style="background:linear-gradient(135deg, hsl(${hue},55%,58%), hsl(${(hue + 40) % 360},45%,38%));">${(name || '?')[0].toUpperCase()}</div>
      <div class="recentBody">
        <div class="recentName">${name}</div>
        <div class="recentPreview">${callSummaryLine(c)}</div>
      </div>
      <div class="recentDate">${relativeCallDate(c.created_at)}</div>`;
    list.appendChild(el);
  }
}

$('recentSearch').addEventListener('input', () => {
  const q = $('recentSearch').value.trim().toLowerCase();
  if (!q) { renderCallsList(lastLoadedCalls); return; }
  renderCallsList(lastLoadedCalls.filter((c) => (c.contact_name || c.to_number || '').toLowerCase().includes(q)));
});

async function loadCalls() {
  if (!currentSession) return;
  const resp = await authedFetch('/api/calls?action=list');
  if (!resp.ok) return;
  const { calls } = await resp.json();
  lastLoadedCalls = calls || [];
  renderCallsList(lastLoadedCalls);
}

// ---------- name (persist on blur) ----------
$('profileName').addEventListener('blur', async () => {
  if (!currentUser) return;
  const name = $('profileName').value.trim();
  await supabase.from('profiles').upsert({ user_id: currentUser.id, name }, { onConflict: 'user_id' });
});

// ---------- profile picture upload ----------
$('avatarEditBtn').addEventListener('click', () => $('avatarFileInput').click());
$('avatarFileInput').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file || !currentUser) return;
  if (!file.type.startsWith('image/')) {
    $('avatarStatus').textContent = 'Please choose an image file.';
    return;
  }
  if (file.size > 8 * 1024 * 1024) {
    $('avatarStatus').textContent = 'Image is too large (max 8MB).';
    return;
  }
  $('avatarStatus').textContent = 'Uploading...';
  try {
    const ext = (file.name.split('.').pop() || 'jpg').toLowerCase();
    const path = `${currentUser.id}/avatar.${ext}`;
    const { error: uploadError } = await supabase.storage
      .from('avatars')
      .upload(path, file, { upsert: true, contentType: file.type });
    if (uploadError) throw uploadError;
    const { data: pub } = supabase.storage.from('avatars').getPublicUrl(path);
    // Cache-bust so the new photo shows immediately even though the URL path is unchanged.
    const url = `${pub.publicUrl}?v=${Date.now()}`;
    const { error: dbError } = await supabase
      .from('profiles')
      .upsert({ user_id: currentUser.id, avatar_url: url }, { onConflict: 'user_id' });
    if (dbError) throw dbError;
    renderAvatar(url);
    $('avatarStatus').textContent = 'Profile picture updated.';
  } catch (err) {
    console.error('avatar upload failed:', err);
    // Surface the real reason instead of a generic message: "bucket not found"
    // means the 'avatars' storage bucket + policies in sql/006_avatars.sql
    // haven't been applied to this Supabase project yet, which is a distinct
    // fix from "your file is too big" and shouldn't be masked as the same thing.
    const reason = (err?.message || err?.error_description || '').toLowerCase();
    if (reason.includes('bucket not found')) {
      $('avatarStatus').textContent = 'Storage isn\'t set up yet (avatars bucket missing) — run sql/006_avatars.sql against this project, then try again.';
    } else if (reason.includes('row-level security') || reason.includes('permission') || reason.includes('policy')) {
      $('avatarStatus').textContent = 'Not allowed to upload (storage policy). Check sql/006_avatars.sql has been applied.';
    } else if (err?.message) {
      $('avatarStatus').textContent = `Could not upload photo: ${err.message}`;
    } else {
      $('avatarStatus').textContent = 'Could not upload photo — try a smaller image.';
    }
  }
});

// ---------- notifications & haptics toggles ----------
const HAPTICS_KEY = 'emysa_haptics_enabled';

function setToggle(el, on) {
  el.classList.toggle('on', !!on);
}

function haptic() {
  if (localStorage.getItem(HAPTICS_KEY) !== '0' && navigator.vibrate) navigator.vibrate(8);
}

async function refreshNotificationsToggle() {
  const supported = 'Notification' in window;
  const granted = supported && Notification.permission === 'granted';
  setToggle($('notificationsToggle'), granted);
  $('notificationsStatus').textContent = !supported
    ? 'Notifications aren\'t supported in this browser.'
    : Notification.permission === 'denied'
      ? 'Blocked at the browser/OS level — enable in system settings to turn this back on.'
      : '';
}

$('notificationsToggle').addEventListener('click', async () => {
  haptic();
  if (!('Notification' in window)) return;
  if (Notification.permission === 'granted') {
    $('notificationsStatus').textContent = 'To turn notifications off, disable them for this app in your browser or OS settings.';
    return;
  }
  if (Notification.permission === 'denied') {
    $('notificationsStatus').textContent = 'Blocked at the browser/OS level — enable in system settings to turn this back on.';
    return;
  }
  await ensureNotificationsEnabled();
  await refreshNotificationsToggle();
});

setToggle($('hapticToggle'), localStorage.getItem(HAPTICS_KEY) !== '0');
$('hapticToggle').addEventListener('click', () => {
  const nowOn = localStorage.getItem(HAPTICS_KEY) === '0'; // was off, turning on
  localStorage.setItem(HAPTICS_KEY, nowOn ? '1' : '0');
  setToggle($('hapticToggle'), nowOn);
  if (nowOn) haptic();
});

refreshNotificationsToggle();

// ---------- legal / help / data-controls sheets ----------
const SUPPORT_EMAIL = 'support@emysa.app'; // update to your real support inbox
document.querySelectorAll('#termsContactEmail, #privacyContactEmail, #helpContactEmail').forEach((el) => { el.textContent = SUPPORT_EMAIL; });

const todayLabel = new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
$('termsUpdatedDate').textContent = todayLabel;
$('privacyUpdatedDate').textContent = todayLabel;

function openSheet(id) {
  haptic();
  document.querySelectorAll('.sheetScreen').forEach((s) => s.classList.add('hidden'));
  $(id).classList.remove('hidden');
}
function closeSheets() {
  document.querySelectorAll('.sheetScreen').forEach((s) => s.classList.add('hidden'));
}
document.querySelectorAll('[data-close-sheet]').forEach((btn) => btn.addEventListener('click', closeSheets));

$('termsBtn').addEventListener('click', () => openSheet('sheet-terms'));
$('privacyBtn').addEventListener('click', () => openSheet('sheet-privacy'));
$('helpFaqBtn').addEventListener('click', () => openSheet('sheet-help'));
$('dataControlsBtn').addEventListener('click', () => openSheet('sheet-data'));
$('dataToPrivacyLink').addEventListener('click', () => openSheet('sheet-privacy'));

// ---------- new profile rows (Account, Voice, Theme, Permissions, Get Started,
// plus placeholders for features that don't exist yet) ----------
$('accountBtn').addEventListener('click', () => {
  $('accountEmailDisplay').textContent = currentUser?.email || '–';
  openSheet('sheet-account');
});
$('themeBtn').addEventListener('click', () => openSheet('sheet-theme'));
$('upgradeBtn').addEventListener('click', () => openSheet('sheet-upgrade'));
$('referralsBtn').addEventListener('click', () => openSheet('sheet-referrals'));
$('callAnsweringBtn').addEventListener('click', () => openSheet('sheet-call-answering'));
$('memoriesBtn').addEventListener('click', () => openSheet('sheet-memories'));
$('callSettingsBtn').addEventListener('click', () => openSheet('sheet-call-settings'));
$('contactsBtn').addEventListener('click', () => openSheet('sheet-contacts'));
$('archiveBtn').addEventListener('click', () => openSheet('sheet-archive'));
$('getStartedBtn').addEventListener('click', () => openSheet('sheet-get-started'));

$('permissionsBtn').addEventListener('click', () => {
  refreshPermissionsSheet();
  openSheet('sheet-permissions');
});
function refreshPermissionsSheet() {
  const perm = ('Notification' in window) ? Notification.permission : 'unsupported';
  const label = { granted: 'Allowed', denied: 'Blocked — enable in your device Settings', default: 'Not yet requested', unsupported: 'Not supported on this browser' }[perm];
  $('permissionsNotifStatus').textContent = label;
  $('permissionsNotifBtn').style.display = perm === 'default' ? '' : 'none';
}
$('permissionsNotifBtn').addEventListener('click', async () => {
  if (!('Notification' in window)) return;
  await Notification.requestPermission();
  refreshPermissionsSheet();
});

function mailtoSupport(subject, body) {
  const email = currentUser?.email ? ` (account: ${currentUser.email})` : '';
  window.location.href = `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body + email)}`;
}
$('exportDataBtn').addEventListener('click', () => mailtoSupport('Data export request', 'Please send me a copy of the personal data associated with my account.'));
$('deleteAccountBtn').addEventListener('click', () => {
  if (!confirm('This permanently deletes your account and all associated data. Continue?')) return;
  mailtoSupport('Delete my account', 'Please permanently delete my account and all associated data.');
});

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
async function refreshVoiceStatus() {
  const resp = await authedFetch('/api/voice-clone');
  if (!resp.ok) return;
  const { status } = await resp.json();
  const ready = status === 'ready';
  $('voiceCloneSection').style.display = ready ? 'none' : 'flex';
  $('voicePreviewRow').classList.toggle('hidden', !ready);
  $('voiceRecordStatus').textContent = status === 'pending' ? 'Cloning your voice…' : status === 'failed' ? 'Last attempt failed — try again with a longer, quieter sample.' : '10–30s of clear speech, quiet room, no music.';
}

async function uploadVoiceClip(blob, mimeType) {
  $('voiceRecordStatus').textContent = 'Uploading…';
  const audioBase64 = await blobToBase64(blob);
  const resp = await authedFetch('/api/voice-clone', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ audioBase64, mimeType }),
  });
  const data = await resp.json();
  $('voiceRecordStatus').textContent = resp.ok ? 'Voice cloned.' : (data.error || 'Could not clone voice — try a longer, quieter sample.');
  if (resp.ok) refreshVoiceStatus();
}

let mediaRecorder, recordedChunks = [];
$('recordVoiceBtn').addEventListener('click', async () => {
  const btn = $('recordVoiceBtn');
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.stop();
    return;
  }
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  recordedChunks = [];
  const recorderMime = ['audio/webm', 'audio/mp4', 'audio/aac', 'audio/ogg']
    .find((t) => window.MediaRecorder?.isTypeSupported?.(t)) || '';
  mediaRecorder = recorderMime ? new MediaRecorder(stream, { mimeType: recorderMime }) : new MediaRecorder(stream);
  mediaRecorder.ondataavailable = (e) => recordedChunks.push(e.data);
  mediaRecorder.onstop = async () => {
    btn.classList.remove('recording');
    btn.textContent = 'Record';
    const actualMime = mediaRecorder.mimeType || recorderMime || 'audio/webm';
    const blob = new Blob(recordedChunks, { type: actualMime });
    stream.getTracks().forEach((t) => t.stop());
    await uploadVoiceClip(blob, actualMime);
  };
  mediaRecorder.start();
  btn.classList.add('recording');
  btn.textContent = 'Stop';
});

$('uploadVoiceBtn').addEventListener('click', () => $('voiceFileInput').click());
$('voiceFileInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  await uploadVoiceClip(file, file.type || 'audio/mpeg');
});

$('voicePreviewBtn').addEventListener('click', async () => {
  const audio = $('voicePreviewAudio');
  if (audio.src && !audio.paused) { audio.pause(); return; }
  if (audio.src) { audio.play().catch(() => {}); return; }
  $('voicePreviewBtn').disabled = true;
  const resp = await authedFetch('/api/voice-clone?action=preview', { method: 'POST' });
  const data = await resp.json();
  $('voicePreviewBtn').disabled = false;
  if (!resp.ok) { $('voiceRecordStatus').textContent = data.error || 'Could not generate a preview.'; return; }
  audio.src = `data:${data.mimeType};base64,${data.audioBase64}`;
  audio.play().catch(() => {});
});
$('voicePreviewAudio').addEventListener('play', () => { $('voicePreviewBtn').innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>'; });
$('voicePreviewAudio').addEventListener('pause', () => { $('voicePreviewBtn').innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>'; });
$('voicePreviewAudio').addEventListener('ended', () => { $('voicePreviewBtn').innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>'; });

$('deleteVoiceBtn').addEventListener('click', async () => {
  if (!confirm('Delete your cloned voice? You can record or upload a new one any time.')) return;
  await authedFetch('/api/voice-clone', { method: 'DELETE' });
  $('voicePreviewAudio').removeAttribute('src');
  refreshVoiceStatus();
});

$('voiceBtn').addEventListener('click', () => { openSheet('sheet-voice'); refreshVoiceStatus(); });

// ---------- language ----------
$('profileLanguage').addEventListener('change', async () => {
  if (!currentUser) return;
  await supabase.from('profiles').upsert({ user_id: currentUser.id, language: $('profileLanguage').value }, { onConflict: 'user_id' });
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}

// ---------- admin ----------
// The tab only appears if the admin-only endpoint actually accepts this
// user — server-side ADMIN_EMAIL check decides that, not anything in this
// client code, so this is just about not showing the tab to people it
// would reject anyway.
// ---------- welcome/login/signup backgrounds (gallery set by the admin app, auto-rotates here) ----------
const authBgLayers = [$('authBgA'), $('authBgB')];
let authBgUrls = [];
let authBgIndex = 0;
let authBgActiveLayer = 0;

function showAuthBg(url) {
  const nextLayer = authBgActiveLayer === 0 ? 1 : 0;
  authBgLayers[nextLayer].style.backgroundImage = `url('${url}')`;
  authBgLayers[nextLayer].style.opacity = '1';
  authBgLayers[authBgActiveLayer].style.opacity = '0';
  authBgActiveLayer = nextLayer;
}

// Public read (no sign-in needed) so the welcome/login screens can be
// themed before anyone has authenticated.
(async () => {
  const { data } = await supabase.from('auth_backgrounds').select('url').order('created_at', { ascending: true });
  authBgUrls = (data || []).map((r) => r.url);
  if (!authBgUrls.length) return;
  showAuthBg(authBgUrls[0]);
  if (authBgUrls.length > 1) {
    setInterval(() => {
      authBgIndex = (authBgIndex + 1) % authBgUrls.length;
      showAuthBg(authBgUrls[authBgIndex]);
    }, 6000);
  }
})();
