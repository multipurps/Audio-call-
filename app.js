import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

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

// Supabase auto-refreshes the underlying access token in the background, but
// this app kept its own separate copy in `currentSession` that was only ever
// set once at sign-in — so an hour into any session, every request kept
// using the original, now-expired token and every call failed with "Not
// signed in". This keeps currentSession pointed at whatever token is
// actually current.
supabase.auth.onAuthStateChange((_event, session) => {
  if (session) currentSession = session;
});

const $ = (id) => document.getElementById(id);

// Referral capture: ?ref=CODE on first load gets stashed until sign-up
// completes and there's a user to actually attach it to.
(() => {
  const ref = new URLSearchParams(window.location.search).get('ref');
  if (ref) {
    localStorage.setItem('emysa_pending_referral', ref.toUpperCase());
    const url = new URL(window.location.href);
    url.searchParams.delete('ref');
    window.history.replaceState({}, '', url.toString());
  }
})();
let currentUser = null;
let userAvatarUrl = null; // cached so home-chat bubbles can show it without a re-fetch per message
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
    if (btn.dataset.tab === 'recent') { loadRecentChats(); loadCalls(); }
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
    await fetch('/api/assistant?action=savePushSubscription', {
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
  redeemPendingReferral();
}

async function redeemPendingReferral() {
  const code = localStorage.getItem('emysa_pending_referral');
  if (!code) return;
  const resp = await authedFetch('/api/referrals?action=redeem', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  if (resp.ok) localStorage.removeItem('emysa_pending_referral');
}

function renderAvatar(url) {
  userAvatarUrl = url || null;
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

  // Home always opens to a fresh conversation, never the last one you were
  // in — old chats live in Recent (openChatSession) instead of being
  // auto-resumed here every time the app opens.
  currentChatSessionId = null;
  homeMessageIds.clear();
  $('homeChat').innerHTML = '';
  setHomeChatActive(false);

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
    scrollHomeChatToBottom();
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
  const row = document.createElement('div');
  row.className = `chatMsgRow ${m.role === 'user' ? 'chatMsgRowUser' : 'chatMsgRowAssistant'}`;
  const avatar = document.createElement('div');
  avatar.className = 'chatAvatar';
  if (m.role === 'user') {
    if (userAvatarUrl) {
      avatar.innerHTML = `<img src="${userAvatarUrl}" alt="">`;
    } else {
      avatar.textContent = (currentUser?.email || '?')[0].toUpperCase();
    }
  } else {
    avatar.innerHTML = `<img src="icon-192.png" alt="">`;
  }
  const el = document.createElement('div');
  el.className = `chatMsg ${m.role === 'user' ? 'chatMsgUser' : 'chatMsgAssistant'}`;
  el.dataset.created = m.created_at;
  el.textContent = m.content;
  if (m.call_id) {
    el.classList.add('chatMsgTappable');
    el.addEventListener('click', () => openCallFromMessage(m.call_id));
  }
  row.appendChild(avatar);
  row.appendChild(el);
  $('homeChat').appendChild(row);
}

async function openCallFromMessage(callId) {
  const resp = await authedFetch('/api/calls?action=list');
  if (!resp.ok) return;
  const { calls } = await resp.json();
  const call = (calls || []).find((c) => c.id === callId);
  if (!call || !['queued', 'ringing', 'in_progress'].includes(call.status)) return; // call's over, nothing live to show
  openCallScreen(call.id, call.to_number, call.contact_name, call.call_mode);
}

// ---------- Header logo: shows a spinning ring while a call placed from
// this chat is actually happening, and opens the live call screen (with
// transcript) when tapped. ----------
let activeHeaderCall = null; // { id, toNumber, contactName } | null
let headerCallChannel = null;

function trackActiveCall(callId, toNumber, contactName, callMode) {
  activeHeaderCall = { id: callId, toNumber, contactName, callMode: callMode || 'ai' };
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
  if (live) trackActiveCall(live.id, live.to_number, live.contact_name, live.call_mode);
}

$('homeHeaderLogoWrap').addEventListener('click', () => {
  if (activeHeaderCall) openCallScreen(activeHeaderCall.id, activeHeaderCall.toNumber, activeHeaderCall.contactName, activeHeaderCall.callMode);
});

async function sendChatMessage(text, onReply, source = 'text', channel = null) {
  const isCall = source === 'call';
  if (!isCall) {
    appendChatBubble({ id: `local-${Date.now()}`, role: 'user', content: text, created_at: new Date().toISOString() });
    setHomeChatActive(true);
    scrollHomeChatToBottom();
  }

  const resp = await authedFetch('/api/assistant?action=send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, sessionId: currentChatSessionId, source, channel }),
  });
  const data = await resp.json();
  if (!resp.ok) {
    const errText = data.error || 'Something went wrong.';
    if (!isCall) {
      appendChatBubble({ id: `err-${Date.now()}`, role: 'assistant', content: errText, created_at: new Date().toISOString() });
      scrollHomeChatToBottom();
    }
    if (onReply) await onReply(errText);
    return;
  }
  if (data.sessionId) currentChatSessionId = data.sessionId;
  if (data.callId && data.toNumber) trackActiveCall(data.callId, data.toNumber, data.contactName);
  const replies = (data.messages || []).filter((m) => m.role !== 'user');
  if (!isCall) {
    // The optimistic user bubble above already shows this turn; mark the
    // server's saved copy of it as seen (without re-rendering) so the next
    // poll doesn't draw a second, duplicate copy of the same user message.
    const savedUserMsg = (data.messages || []).find((m) => m.role === 'user');
    if (savedUserMsg) homeMessageIds.add(savedUserMsg.id);
    renderHomeMessages(replies, false);
  }
  if (onReply) await onReply(replies.map((m) => m.content).join(' ') || '');
}

async function sendBrief() {
  const text = $('briefInput').value.trim();
  if (!text) return;
  $('sendBtn').disabled = true;
  $('briefInput').value = '';
  $('briefInput').style.height = 'auto';
  const channelForThisSend = selectedCallChannel;
  await sendChatMessage(text, null, 'text', channelForThisSend);
  // One-shot: the channel picker sets the line for the *next* thing you
  // send, then falls back to the default (phone) once that's been sent.
  if (channelForThisSend) setCallChannel('phone');
  $('sendBtn').disabled = false;
}

$('sendBtn').addEventListener('click', sendBrief);
$('briefInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); sendBrief(); }
  // Plain Enter now inserts a newline (default textarea behavior) instead of
  // sending — only the send button, or Cmd/Ctrl+Enter, submits the message.
});
$('briefInput').addEventListener('input', () => {
  const el = $('briefInput');
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 120) + 'px';
  syncHomeChatPadding();
});

// The chat's bottom padding has to actually match the input bar's real,
// current height (which grows as the message box grows) or new messages
// render hidden behind the bar instead of above it — a fixed guess was
// wrong as soon as someone typed more than one line.
function syncHomeChatPadding() {
  const bar = $('homeInputBar');
  if (!bar) return;
  // The input bar floats above the tab bar (bottom: tabbar-h + 14px), so its
  // own height alone isn't enough padding - that ignored the tab bar's
  // reserved space entirely and let messages render behind both bars.
  // Measuring the actual gap from the bar's top edge to the screen bottom
  // captures that reserved space regardless of how it's composed.
  const gap = window.innerHeight - bar.getBoundingClientRect().top + 16;
  document.documentElement.style.setProperty('--home-chat-pad', `${gap}px`);
}

// scrollTop was sometimes being set from a scrollHeight read before the
// browser had actually painted a just-updated --home-chat-pad value (a
// layout race, worst right on first load), leaving the last message resting
// behind the input bar until something else nudged a reflow. Re-syncing the
// padding and deferring the actual scroll to the next paint frame (twice,
// makes this deterministic instead of lucky. (Two rAFs since one can still
// land before layout settles on some mobile browsers.)
function scrollHomeChatToBottom() {
  syncHomeChatPadding();
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const el = $('homeChat');
      if (el) el.scrollTop = el.scrollHeight;
    });
  });
}
window.addEventListener('resize', syncHomeChatPadding);
syncHomeChatPadding();

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
    row.innerHTML = `
      <div class="savedChatTitle">${s.title}</div>
      <div class="chatRowActions">
        <div class="savedChatDate">${shortDateLabel(s.updated_at)}</div>
        <button class="chatRowIconBtn" data-action="archive" aria-label="Archive"><svg viewBox="0 0 24 24" fill="none"><rect x="3" y="4" width="18" height="5" rx="1.5" stroke="currentColor" stroke-width="1.6"/><path d="M5 9v8a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9M10 13h4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button>
        <button class="chatRowIconBtn danger" data-action="delete" aria-label="Delete"><svg viewBox="0 0 24 24" fill="none"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
      </div>`;
    row.addEventListener('click', () => { openChatSession(s.id); closeSheets(); });
    row.querySelector('[data-action="archive"]').addEventListener('click', async (e) => {
      e.stopPropagation();
      await authedFetch('/api/assistant?action=archiveSession', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: s.id, archived: true }) });
      loadSavedChats();
    });
    row.querySelector('[data-action="delete"]').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm(`Delete "${s.title}"? This can't be undone.`)) return;
      await authedFetch('/api/assistant?action=deleteSession', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: s.id }) });
      loadSavedChats();
    });
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
let callTranscriptForSummary = [];

// Turns the ephemeral call-screen transcript into the one line that
// actually belongs in the home chat log. Skipped entirely if nothing but
// the opening greeting happened — a call nobody spoke on isn't worth a
// line in the history.
async function postCallSummary() {
  if (callTranscriptForSummary.length === 0 || !currentChatSessionId) return;
  const transcriptText = callTranscriptForSummary.map((t) => `${t.role === 'user' ? 'You' : 'Emysa'}: ${t.content}`).join('\n');
  let summary = 'Had a quick call with Emysa.';
  try {
    const falResp = await authedFetch('/api/assistant?action=summarizeCall', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transcript: transcriptText }),
    });
    const falData = await falResp.json();
    if (falResp.ok && falData.summary) summary = falData.summary;
  } catch {}
  await authedFetch('/api/assistant?action=logCallSummary', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: currentChatSessionId, summary }),
  });
  const resp = await authedFetch(`/api/assistant?action=messages&sessionId=${encodeURIComponent(currentChatSessionId)}`);
  if (resp.ok) { const { messages } = await resp.json(); renderHomeMessages(messages || [], false); }
  callTranscriptForSummary = [];
}
let assistantListening = false;
let assistantMuted = false;
let assistantSpeaking = false;

function appendCallTranscriptLine(speaker, content) {
  const panel = $('transcriptPanel');
  const el = document.createElement('div');
  el.className = `transcriptLine ${speaker}`;
  let dotInner = '';
  if (speaker === 'ai') {
    dotInner = `<img src="icon-192.png" alt="">`;
  } else if (speaker === 'user' && userAvatarUrl) {
    dotInner = `<img src="${userAvatarUrl}" alt="">`;
  } else if (speaker === 'user') {
    dotInner = (currentUser?.email || '?')[0].toUpperCase();
  }
  el.innerHTML = `<div class="transcriptDot">${dotInner}</div><div class="transcriptBubble">${content}</div>`;
  panel.appendChild(el);
  panel.scrollTop = panel.scrollHeight;
}

// Actually speaks the assistant's line out loud on the call screen — text
// alone isn't a voice conversation. Resolves once playback ends (or on
// failure) so the mic doesn't start listening again over Emysa's own voice.
//
// Played through an AudioContext buffer, not an <audio> element. iOS Safari
// infers the audio session category from which media APIs are in play —
// getUserMedia flips it to "play-and-record", and in that mode Safari
// silently ducks/attenuates <audio>/SpeechSynthesis output (a long-standing,
// undocumented WebKit behavior). AudioContext.destination output stays at
// full volume in that same mode, so decoding and playing the reply through
// it is what keeps Emysa audible while the mic was just active.
let assistantAudioCtx = null;
function getAssistantAudioCtx() {
  if (!assistantAudioCtx) assistantAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return assistantAudioCtx;
}
function base64ToArrayBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}
const AUDIO_BTN_HTML = '<div class="callBtnCircle"><svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M16 9C16.5 9.5 17 10.5 17 12C17 13.5 16.5 14.5 16 15M19 6C20.5 7.5 21 10 21 12C21 14 20.5 16.5 19 18M13 3L7 8H5C3.89543 8 3 8.89543 3 10V14C3 15.1046 3.89543 16 5 16H7L13 21V3Z" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></div>\n          Speaker';
const MORE_BTN_HTML = '<div class="callBtnCircle"><svg viewBox="0 0 24 24" fill="none"><circle cx="5" cy="12" r="2" fill="currentColor"/><circle cx="12" cy="12" r="2" fill="currentColor"/><circle cx="19" cy="12" r="2" fill="currentColor"/></svg></div>\n          More';
async function speakReply(text) {
  if (!text || !text.trim() || !assistantCallOpen) return;
  // Guards startAssistantListening() (and the manual tap-to-talk path)
  // from ever opening the mic while Emysa's own voice is still coming out
  // of the speaker — without this, the mic picks up that audio as if the
  // user said it (there's no real echo cancellation on raw AudioContext
  // output — see the comment above getAssistantAudioCtx), which both
  // mis-transcribes Emysa's own words as user speech and, if a reply to
  // that gets spoken before this one finishes, plays two replies at once.
  assistantSpeaking = true;
  try {
    const resp = await authedFetch('/api/assistant?action=speak', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    const data = await resp.json();
    if (!resp.ok) {
      console.error('speakReply: /api/assistant?action=speak failed:', resp.status, data?.error, data?.detail);
      if (assistantCallOpen) appendCallTranscriptLine('ai', `[voice output failed: ${data?.error || resp.status}]`);
      return;
    }
    if (!assistantCallOpen) return;
    const ctx = getAssistantAudioCtx();
    if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
    const audioBuffer = await ctx.decodeAudioData(base64ToArrayBuffer(data.audioBase64));
    await new Promise((resolve) => {
      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(ctx.destination);
      source.onended = resolve;
      try { source.start(); } catch { resolve(); }
    });
  } catch (err) {
    // Voice output failing shouldn't block the text conversation from continuing,
    // but it should be visible instead of vanishing silently.
    console.error('speakReply: request threw:', err);
    if (assistantCallOpen) appendCallTranscriptLine('ai', '[voice output failed: network error]');
  } finally {
    assistantSpeaking = false;
  }
}

// "More" menu on the Emysa call screen - lets you send a photo (camera or
// library) for Emysa to actually look at, via the vision-capable model
// (openai/gpt-4o-mini through the same fal.ai proxy used for text turns).
let callMoreMenuEl = null;
function openCallMoreMenu() {
  if (callMoreMenuEl) return;
  const menu = document.createElement('div');
  menu.className = 'callMoreMenu';
  menu.innerHTML = `
    <button type="button" data-mode="camera">Camera</button>
    <button type="button" data-mode="library">Photos</button>
    <button type="button" data-mode="cancel">Cancel</button>
  `;
  document.body.appendChild(menu);
  callMoreMenuEl = menu;

  const close = () => { menu.remove(); callMoreMenuEl = null; };
  menu.querySelector('[data-mode="cancel"]').onclick = close;
  menu.querySelector('[data-mode="camera"]').onclick = () => { close(); pickCallPhoto(true); };
  menu.querySelector('[data-mode="library"]').onclick = () => { close(); pickCallPhoto(false); };
}

function pickCallPhoto(useCamera) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  if (useCamera) input.capture = 'environment';
  input.onchange = async () => {
    const file = input.files?.[0];
    if (file) await sendCallPhoto(file);
  };
  input.click();
}

// Phone-camera photos can be several MB - well over what's sensible to
// base64 and post from a serverless function - so this downsizes to a
// reasonable max dimension before sending, same as any normal image upload.
function resizeImageForUpload(file, maxDim = 1280) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL('image/jpeg', 0.82).split(',')[1]);
    };
    img.onerror = reject;
    img.src = url;
  });
}

async function sendCallPhoto(file) {
  if (!assistantCallOpen) return;
  appendCallTranscriptLine('user', '📷 Sent a photo');
  try {
    const imageBase64 = await resizeImageForUpload(file);
    const resp = await authedFetch('/api/assistant?action=sendImage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageBase64, mimeType: 'image/jpeg', sessionId: currentChatSessionId, source: 'call' }),
    });
    const data = await resp.json();
    if (!resp.ok) {
      appendCallTranscriptLine('ai', data.error || "Sorry, I couldn't look at that.");
      return;
    }
    if (data.sessionId) currentChatSessionId = data.sessionId;
    const reply = (data.messages || []).find((m) => m.role === 'assistant')?.content;
    if (reply && assistantCallOpen) {
      appendCallTranscriptLine('ai', reply);
      callTranscriptForSummary.push({ role: 'user', content: '[sent a photo]' }, { role: 'assistant', content: reply });
      await speakReply(reply);
    }
  } catch (err) {
    console.error('sendCallPhoto failed:', err);
    if (assistantCallOpen) appendCallTranscriptLine('ai', "Sorry, something went wrong sending that.");
  }
}

function openAssistantCallScreen() {
  assistantCallOpen = true;
  assistantMuted = false;
  callTranscriptForSummary = [];
  $('callScreen').classList.remove('hidden');
  $('callScreen').classList.add('assistantMode');
  // Belt and braces alongside the assistantMode CSS: this screen is the AI
  // conversation and has no phone call to hand over, so the Direct Voice
  // switch must never be reachable from it.
  $('voiceModeBar').classList.add('hidden');
  $('directPanel').classList.add('hidden');
  $('callAudioBtn').innerHTML = MORE_BTN_HTML;
  $('callAudioBtn').onclick = () => openCallMoreMenu();
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
    postCallSummary();
  };
  $('callMuteBtn').onclick = () => {
    assistantMuted = !assistantMuted;
    $('callMuteBtn').classList.toggle('active', assistantMuted);
    if (assistantMuted && waveRecorder?.state === 'recording') waveRecorder.stop();
    else if (!assistantMuted && assistantCallOpen) startAssistantListening();
  };
  $('callKeypadBtn').onclick = () => {};
  $('waveRow').onclick = () => {
    if (waveRecorder && waveRecorder.state === 'recording') waveRecorder.stop();
    else if (!assistantListening && !assistantSpeaking) startAssistantListening();
  };

  // Speak first, on connect — a real call has a greeting before it ever
  // waits on you, and it means you hear the voice working immediately
  // rather than only after your own input round-trips successfully.
  (async () => {
    const greeting = 'Hey! What can I help you with?';
    appendCallTranscriptLine('ai', greeting);
    await speakReply(greeting);
    if (assistantCallOpen && !assistantMuted) startAssistantListening();
  })();
}

async function startAssistantListening() {
  if (assistantListening || assistantMuted || assistantSpeaking || !assistantCallOpen) return;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
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
      if (waveChunks.length && assistantCallOpen && hasSpoken) {
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
          if (resp.ok && data.text?.trim()) {
            appendCallTranscriptLine('user', data.text.trim());
            callTranscriptForSummary.push({ role: 'user', content: data.text.trim() });
            await sendChatMessage(data.text.trim(), async (reply) => {
              if (assistantCallOpen && reply) {
                appendCallTranscriptLine('ai', reply);
                callTranscriptForSummary.push({ role: 'assistant', content: reply });
                await speakReply(reply);
              }
            }, 'call');
          } else if (!resp.ok) {
            const errText = data.detail ? `${data.error}: ${data.detail}`.slice(0, 300) : (data.error || "Sorry, I didn't catch that.");
            // Errors are shown in the transcript, never spoken — Emysa's voice
            // is reserved for actual replies, not failure messages.
            appendCallTranscriptLine('ai', errText);
          }
        } catch (err) {
          if (assistantCallOpen) {
            appendCallTranscriptLine('ai', "Sorry, something went wrong there — try again.");
          }
        }
      }
      // This used to be skipped whenever the block above was never entered
      // (silence, no speech detected) because that path used a bare
      // `return` before ever reaching this line - so the mic just went
      // dead and stayed dead until Mute was toggled twice. Now it always
      // runs, whichever path was taken above.
      if (assistantCallOpen && !assistantMuted) startAssistantListening();
    };
    waveRecorder.start();
  } catch (err) {
    assistantListening = false;
    alert('Microphone access is needed to talk to Emysa by voice.');
  }
}

// ---------- Call channel: Emysa (voice) / WhatsApp / Telegram / Phone ----------
let selectedCallChannel = null; // null = default (phone/Twilio)

const CHANNEL_META = {
  whatsapp: { label: 'WhatsApp', placeholder: 'Paste a number to call on WhatsApp…' },
  telegram: { label: 'Telegram', placeholder: 'Paste a number to call on Telegram…' },
  phone: { label: null, placeholder: 'Message' },
};

function setCallChannel(channel) {
  selectedCallChannel = channel === 'phone' ? null : channel;
  const meta = CHANNEL_META[channel] || CHANNEL_META.phone;
  $('briefInput').placeholder = meta.placeholder;
  $('channelBadge').classList.toggle('visible', !!meta.label);
  if (meta.label) $('channelBadgeText').textContent = `Calling on ${meta.label}`;
  $('briefInput').focus();
}

$('homeWaveBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  $('callChannelMenu').classList.toggle('hidden');
});
document.addEventListener('click', (e) => {
  if (!$('callChannelMenu').classList.contains('hidden') && !e.target.closest('.callChannelWrap')) {
    $('callChannelMenu').classList.add('hidden');
  }
});
document.querySelectorAll('.callChannelItem').forEach((btn) => {
  btn.addEventListener('click', () => {
    $('callChannelMenu').classList.add('hidden');
    const channel = btn.dataset.channel;
    if (channel === 'emysa') {
      // iOS Safari only allows audio playback that traces back to a direct,
      // synchronous tap — resuming/creating the AudioContext after any await
      // (like the network fetch to generate speech) gets silently blocked.
      // Doing it here, inside the real tap, unlocks every later programmatic
      // buffer playback on this same context for the rest of the call, even
      // from deep inside async code.
      const ctx = getAssistantAudioCtx();
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      // Explicit hint for iOS 17+: Safari otherwise infers the category from
      // whichever media API ran most recently, which is what causes the
      // ducking in the first place. Feature-detected — older iOS ignores it.
      if ('audioSession' in navigator) { try { navigator.audioSession.type = 'play-and-record'; } catch {} }
      openAssistantCallScreen();
      return;
    }
    setCallChannel(channel);
  });
});

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
let activeCallId = null; // the phone call currently on screen, for the mode switch

// ---------- Direct Caller Mode ----------
// Loaded lazily: the module pulls in two AudioWorklet files and only matters
// once someone actually picks Direct Voice, so there's no reason to parse it
// on every app start. Cached so repeated switches don't re-fetch.
let DirectCallAudioCtor = null;
async function getDirectCallAudio() {
  if (!DirectCallAudioCtor) {
    const mod = await import('./client/directCallAudio.js');
    DirectCallAudioCtor = mod.DirectCallAudio;
  }
  return DirectCallAudioCtor;
}

let directAudio = null;
let directCallId = null;
let directStarting = false;
let directMonitorOn = true;
let vcModelsCache = null;
let vcActiveSlot = null; // slot the w-okada server currently has loaded

function setDirectStatus(text) {
  const el = $('directStatus');
  if (el) el.textContent = text || '';
}

function setDirectDot(state) {
  const dot = $('directDot');
  if (!dot) return;
  dot.classList.toggle('live', state === 'live');
  dot.classList.toggle('warn', state === 'warn');
}

/**
 * Turn this call over to the user's own microphone.
 *
 * The relay does the switching: telling it mode:'direct' stops it buffering
 * caller audio for Whisper and stops it speaking, and starts accepting mic
 * frames on the /direct socket. Nothing here touches the AI pipeline in
 * app.js — the assistant call screen (openAssistantCallScreen) is a
 * completely separate code path and is unaffected either way.
 */
async function enterDirectMode(callId) {
  if (directStarting || (directAudio && directCallId === callId)) return;
  directStarting = true;
  $('callScreen').classList.add('directMode');
  $('directPanel').classList.remove('hidden');
  $('directPanelTitle').textContent = 'Connecting your microphone…';
  setDirectDot('warn');
  setDirectStatus('');

  try {
    const resp = await authedFetch(`/api/calls?action=directBridge&callId=${encodeURIComponent(callId)}`);
    const data = await resp.json();
    if (!resp.ok) {
      setDirectStatus(data.error || 'Could not start the direct call.');
      setDirectDot('warn');
      return;
    }

    const Ctor = await getDirectCallAudio();
    directCallId = callId;
    directAudio = new Ctor({
      wsUrl: data.wsUrl,
      streamRate: data.streamRate,
      playRate: data.playRate,
      onStatus: (s) => {
        if (!directAudio) return;
        const vcOn = s.vc.enabled && s.vc.configured;
        $('directPanelTitle').textContent = !s.connected
          ? 'Reconnecting…'
          : vcOn
            ? 'Your converted voice is going to the caller'
            : 'Your own voice is going to the caller';
        setDirectDot(s.connected ? 'live' : 'warn');
        $('vcToggle').classList.toggle('on', s.vc.enabled);
        if (!s.vc.configured) {
          $('vcHint').textContent = 'No voice changer is configured on this account';
        } else if (s.vc.failedOver) {
          $('vcHint').textContent = 'Voice changer unreachable — sending your own voice';
        } else {
          $('vcHint').textContent = s.vc.enabled
            ? 'Convert your voice before the caller hears it'
            : 'Off — the caller hears your normal microphone';
        }
        // Keep the mute button in step with the mic when the socket reconnects.
        $('callMuteBtn').classList.toggle('active', s.muted);
      },
      onStats: (s) => {
        if (!directAudio) return;
        if (typeof s.level === 'number') {
          // Mic RMS is small; scale it so ordinary speech fills the bar.
          const pct = Math.max(0, Math.min(100, Math.round(s.level * 320)));
          $('directMeterFill').style.width = `${pct}%`;
        }
        if (typeof s.rttMs === 'number') {
          const extra = s.dropped ? ` · ${s.dropped} chunk${s.dropped === 1 ? '' : 's'} dropped` : '';
          setDirectStatus(`Conversion latency ${s.rttMs} ms${extra}`);
        }
      },
      onError: (message, meta) => {
        if (meta?.fatal) {
          setDirectStatus(message);
          setDirectDot('warn');
        } else {
          setDirectStatus(message);
        }
      },
    });

    await directAudio.start();
    directAudio.setVoiceChanger(data.vcEnabled !== false, data.vcModelSlot ?? undefined);
    if (data.vcModelSlot != null) $('vcModelSelect').value = String(data.vcModelSlot);
    loadVoiceModels(data.vcModelSlot);
  } catch (err) {
    // getUserMedia rejection lands here — the single most likely failure, and
    // it needs to say "microphone" rather than a stack trace.
    setDirectStatus(err?.name === 'NotAllowedError'
      ? 'Microphone access is needed for Direct Voice.'
      : `Could not start Direct Voice: ${err?.message || err}`);
    setDirectDot('warn');
  } finally {
    directStarting = false;
  }
}

async function exitDirectMode() {
  const callId = directCallId || activeCallId;
  const audio = directAudio;
  directAudio = null;
  directCallId = null;
  if (audio) {
    // Tell the relay first so it resumes the AI loop before the socket goes
    // away — otherwise the relay treats the close as a dropped call and
    // falls back to AI on its own with a note in the transcript.
    audio.setMode('ai');
    await audio.stop().catch(() => {});
  }
  if (callId) {
    authedFetch('/api/calls?action=mode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callId, mode: 'ai' }),
    }).catch(() => {});
  }
  $('callScreen').classList.remove('directMode');
  $('directPanel').classList.add('hidden');
  $('directMeterFill').style.width = '0%';
  setDirectStatus('');
}

async function loadVoiceModels(selectedSlot) {
  const select = $('vcModelSelect');
  let activeSlot = null;
  if (!vcModelsCache) {
    const resp = await authedFetch('/api/calls?action=vcState');
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || !data.configured) {
      select.innerHTML = `<option value="">${data.error ? 'Voice changer unavailable' : 'Not configured'}</option>`;
      select.disabled = true;
      $('vcToggle').classList.remove('on');
      return;
    }
    if (!data.models?.length) {
      select.innerHTML = '<option value="">No voices installed</option>';
      select.disabled = true;
      return;
    }
    vcModelsCache = data.models;
    vcActiveSlot = data.activeSlot;
  }
  select.disabled = false;
  select.innerHTML = vcModelsCache
    .map((m) => `<option value="${m.slot}">${escapeHtml(m.name)}${m.type ? ` (${escapeHtml(m.type)})` : ''}</option>`)
    .join('');

  // Preference order: this call's slot, then the account default, then the
  // slot the VC server already has loaded, then the first installed voice.
  // Never leave the selector on a value that would load nothing.
  activeSlot = selectedSlot ?? vcActiveSlot ?? vcModelsCache[0].slot;
  if (vcModelsCache.some((m) => m.slot === activeSlot)) select.value = String(activeSlot);
}

function openCallScreen(callId, toNumber, contactName, callMode) {
  $('callScreen').classList.remove('hidden');
  $('callScreen').classList.remove('assistantMode');
  $('callAudioBtn').innerHTML = AUDIO_BTN_HTML;
  $('callFaceTimeBtn').onclick = () => {
    alert('FaceTime video calls are a Pro feature — upgrade to unlock video.');
  };
  $('callAddBtn').onclick = () => {
    alert("Adding another person to the call isn't available yet.");
  };
  $('callContactAvatar').style.display = '';
  const displayName = contactName || toNumber;
  $('callContactAvatar').textContent = (contactName ? contactName[0] : toNumber.replace(/[^0-9]/g, '').slice(-2)) || '?';
  $('callTitleText').textContent = `Emysa & ${displayName}`;
  $('transcriptPanel').innerHTML = '';
  $('waveRow').classList.remove('speaking');
  callAiMuted = false;
  $('callMuteBtn').classList.remove('active');

  // Voice mode selector: shown on real phone calls only. The Emysa
  // assistant call has no human on the line, so handing over the microphone
  // there would be meaningless — openAssistantCallScreen() leaves this bar
  // hidden and never touches any of the direct-call state below.
  const initialMode = callMode === 'direct' ? 'direct' : 'ai';
  activeCallId = callId;
  $('voiceModeBar').classList.remove('hidden');
  setVoiceModeUi(initialMode);
  if (initialMode === 'direct') enterDirectMode(callId);

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
      // The relay writes call_mode when it takes the call back from Direct
      // Voice (mic socket dropped, phone lost signal). Follow it, or the
      // screen keeps showing a direct call that is actually the AI now.
      if (payload.new.call_mode === 'ai' && $('callScreen').classList.contains('directMode')) {
        setVoiceModeUi('ai');
        teardownDirectMode();
        $('directPanel').classList.add('hidden');
        setDirectStatus('');
      }
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
    // Two different mutes on the same button, because two different things
    // are being silenced. In Direct Voice it's your microphone; in AI Voice
    // it's Emysa's voice, and the AI keeps listening either way (that's the
    // existing behaviour, unchanged).
    if ($('callScreen').classList.contains('directMode')) {
      const muted = !$('callMuteBtn').classList.contains('active');
      $('callMuteBtn').classList.toggle('active', muted);
      directAudio?.setMuted(muted);
      setDirectStatus(muted ? 'Microphone muted — the caller can\'t hear you' : '');
      return;
    }
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
  // Release the microphone before hiding anything. Leaving the capture track
  // running behind a hidden screen would keep the browser's recording
  // indicator lit for the rest of the session.
  teardownDirectMode();
  $('callScreen').classList.add('hidden');
  $('voiceModeBar').classList.add('hidden');
  $('directPanel').classList.add('hidden');
  $('directMeterFill').style.width = '0%';
  setDirectStatus('');
  loadCalls();
}

/** Stops direct-call audio without telling the relay anything. */
function teardownDirectMode() {
  const audio = directAudio;
  directAudio = null;
  directCallId = null;
  $('callScreen').classList.remove('directMode');
  if (audio) audio.stop().catch(() => {});
}

function setVoiceModeUi(mode) {
  $('voiceModeAi').classList.toggle('active', mode === 'ai');
  $('voiceModeDirect').classList.toggle('active', mode === 'direct');
}

/**
 * Wires the mode switch and the voice-changer controls once, at load. The
 * buttons live in the call screen's static markup, so this doesn't need to
 * run per call — only the state they act on changes.
 */
function initDirectVoiceControls() {
  $('voiceModeAi').addEventListener('click', () => {
    if (!$('callScreen').classList.contains('directMode')) return;
    setVoiceModeUi('ai');
    exitDirectMode();
  });

  $('voiceModeDirect').addEventListener('click', () => {
    if ($('callScreen').classList.contains('directMode')) return;
    setVoiceModeUi('direct');
    // Same iOS rule the assistant call follows: unlocking audio has to happen
    // synchronously inside the tap, before the network round trip.
    const ctx = getAssistantAudioCtx();
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    if ('audioSession' in navigator) { try { navigator.audioSession.type = 'play-and-record'; } catch {} }
    enterDirectMode(activeCallId);
  });

  $('vcToggle').addEventListener('click', () => {
    if (!directAudio) return;
    const next = !$('vcToggle').classList.contains('on');
    $('vcToggle').classList.toggle('on', next);
    directAudio.setVoiceChanger(next);
  });

  $('vcModelSelect').addEventListener('change', (e) => {
    const slot = Number(e.target.value);
    if (!Number.isFinite(slot) || !directAudio) return;
    directAudio.setModel(slot);
    setDirectStatus('Loading that voice…');
    // Remember it as the account default, so the next call starts here.
    authedFetch('/api/calls?action=vcSet', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slot }),
    }).then((resp) => resp.json().catch(() => ({})).then((d) => {
      if (!resp.ok || d.error) setDirectStatus(d.error || 'Voice saved, but it could not be loaded yet.');
    }));
  });

  $('directMonitorToggle').addEventListener('click', () => {
    directMonitorOn = !$('directMonitorToggle').classList.contains('on');
    $('directMonitorToggle').classList.toggle('on', directMonitorOn);
    directAudio?.setMonitor(directMonitorOn);
  });
}

initDirectVoiceControls();

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

let recentSubTab = 'chats';
let recentChatSessions = [];
let recentChatMenuTargetId = null;

document.querySelectorAll('.recentSubTabBtn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.recentSubTabBtn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    recentSubTab = btn.dataset.subtab;
    $('recentChatsList').classList.toggle('hidden', recentSubTab !== 'chats');
    $('callsList').classList.toggle('hidden', recentSubTab !== 'calls');
    $('recentSearch').value = '';
    $('recentSearch').placeholder = recentSubTab === 'chats' ? 'Search chats' : 'Search conversations';
  });
});

async function loadRecentChats() {
  const resp = await authedFetch('/api/assistant?action=sessions');
  if (!resp.ok) return;
  const { sessions } = await resp.json();
  recentChatSessions = sessions || [];
  renderRecentChatsList(recentChatSessions);
}

function renderRecentChatsList(sessions) {
  const list = $('recentChatsList');
  list.innerHTML = '';
  if (!sessions?.length) {
    list.innerHTML = `<div class="authHint" style="text-align:left;">No chats yet — start one from Home.</div>`;
    return;
  }
  for (const s of sessions) {
    const row = document.createElement('div');
    row.className = 'savedChatRow';
    row.innerHTML = `
      <div class="savedChatTitle">${s.title}</div>
      <div class="chatRowActions">
        <div class="savedChatDate">${shortDateLabel(s.updated_at)}</div>
        <button class="recentChatKebabBtn" aria-label="More"><svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="12" cy="19" r="1.8"/></svg></button>
      </div>`;
    row.addEventListener('click', () => {
      openChatSession(s.id);
      document.querySelector('#tabBar .tabBtn[data-tab="home"]').click();
    });
    row.querySelector('.recentChatKebabBtn').addEventListener('click', (e) => {
      e.stopPropagation();
      openRecentChatMenu(e.currentTarget, s.id);
    });
    list.appendChild(row);
  }
}

function openRecentChatMenu(anchorBtn, sessionId) {
  recentChatMenuTargetId = sessionId;
  const menu = $('recentChatMenu');
  const rect = anchorBtn.getBoundingClientRect();
  menu.style.top = `${rect.bottom + 6}px`;
  menu.style.right = `${window.innerWidth - rect.right}px`;
  menu.style.left = 'auto';
  menu.classList.remove('hidden');
}
function closeRecentChatMenu() {
  $('recentChatMenu').classList.add('hidden');
  recentChatMenuTargetId = null;
}
document.addEventListener('click', (e) => {
  if (!$('recentChatMenu').classList.contains('hidden') && !e.target.closest('#recentChatMenu')) closeRecentChatMenu();
});
$('recentChatMenu').querySelector('[data-action="archive"]').addEventListener('click', async () => {
  if (!recentChatMenuTargetId) return;
  const id = recentChatMenuTargetId;
  closeRecentChatMenu();
  await authedFetch('/api/assistant?action=archiveSession', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: id, archived: true }) });
  loadRecentChats();
});
$('recentChatMenu').querySelector('[data-action="delete"]').addEventListener('click', async () => {
  if (!recentChatMenuTargetId) return;
  const id = recentChatMenuTargetId;
  closeRecentChatMenu();
  if (!confirm('Delete this chat? This can\'t be undone.')) return;
  await authedFetch('/api/assistant?action=deleteSession', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: id }) });
  loadRecentChats();
});

$('recentSearch').addEventListener('input', () => {
  const q = $('recentSearch').value.trim().toLowerCase();
  if (recentSubTab === 'chats') {
    renderRecentChatsList(!q ? recentChatSessions : recentChatSessions.filter((s) => (s.title || '').toLowerCase().includes(q)));
  } else {
    renderCallsList(!q ? lastLoadedCalls : lastLoadedCalls.filter((c) => (c.contact_name || c.to_number || '').toLowerCase().includes(q)));
  }
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

function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s || '';
  return d.innerHTML;
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
  if (typeof whatsappPollTimer !== 'undefined') clearInterval(whatsappPollTimer);
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
$('referralsBtn').addEventListener('click', () => { loadReferrals(); openSheet('sheet-referrals'); });
$('callAnsweringBtn').addEventListener('click', () => { loadCallAnswering(); openSheet('sheet-call-answering'); });
$('memoriesBtn').addEventListener('click', () => { loadMemories(); openSheet('sheet-memories'); });
$('callSettingsBtn').addEventListener('click', () => { loadCallSettings(); openSheet('sheet-call-settings'); });
$('contactsBtn').addEventListener('click', () => openSheet('sheet-contacts'));
$('archiveBtn').addEventListener('click', () => { loadArchivedChats(); openSheet('sheet-archive'); });
$('getStartedBtn').addEventListener('click', () => openSheet('sheet-get-started'));

// ---------- Referrals ----------
async function loadReferrals() {
  const resp = await authedFetch('/api/referrals');
  if (!resp.ok) return;
  const data = await resp.json();
  $('referralCodeValue').textContent = data.code || '——————';
  $('referralCount').textContent = data.referralCount ?? 0;
  $('referralMinutes').textContent = (data.referralCount ?? 0) * (data.bonusPerReferral ?? 30);
}
$('referralCopyBtn').addEventListener('click', async () => {
  const code = $('referralCodeValue').textContent;
  try { await navigator.clipboard.writeText(code); $('referralCopyBtn').textContent = 'Copied!'; setTimeout(() => { $('referralCopyBtn').textContent = 'Copy'; }, 1500); } catch {}
});
$('referralShareBtn').addEventListener('click', async () => {
  const code = $('referralCodeValue').textContent;
  const url = `${window.location.origin}/?ref=${code}`;
  if (navigator.share) { try { await navigator.share({ title: 'Emysa', text: `Use my code ${code} on Emysa and we both get bonus calling minutes.`, url }); } catch {} }
  else { try { await navigator.clipboard.writeText(url); $('referralShareBtn').textContent = 'Link copied!'; setTimeout(() => { $('referralShareBtn').textContent = 'Share'; }, 1500); } catch {} }
});

// ---------- Call Answering ----------
async function loadCallAnswering() {
  const resp = await authedFetch('/api/call-answering');
  if (!resp.ok) return;
  const data = await resp.json();
  setToggle($('callAnsweringToggle'), data.enabled);
  $('callAnsweringDetails').classList.toggle('hidden', !data.enabled);
  $('callAnsweringNumber').textContent = data.twilioNumber || 'Not assigned yet';
  $('callAnsweringGreeting').value = data.greeting || '';
  $('callAnsweringInstructions').value = data.instructions || '';
  $('callAnsweringStatus').textContent = '';
}
$('callAnsweringToggle').addEventListener('click', async () => {
  const turningOn = !$('callAnsweringToggle').classList.contains('on');
  $('callAnsweringStatus').textContent = turningOn ? 'Setting up your number…' : 'Turning off…';
  const resp = await authedFetch(`/api/call-answering?action=${turningOn ? 'enable' : 'disable'}`, { method: 'POST' });
  const data = await resp.json();
  if (!resp.ok) { $('callAnsweringStatus').textContent = data.error || 'Something went wrong.'; return; }
  await loadCallAnswering();
});
$('callAnsweringSaveBtn').addEventListener('click', async () => {
  $('callAnsweringSaveStatus').textContent = 'Saving…';
  const resp = await authedFetch('/api/call-answering?action=update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ greeting: $('callAnsweringGreeting').value, instructions: $('callAnsweringInstructions').value }),
  });
  const data = await resp.json();
  $('callAnsweringSaveStatus').textContent = resp.ok ? 'Saved.' : (data.error || 'Could not save.');
});

// ---------- Memories ----------
async function loadMemories() {
  const resp = await authedFetch('/api/memories');
  const list = $('memoriesList');
  list.innerHTML = '';
  if (!resp.ok) return;
  const { memories } = await resp.json();
  if (!memories?.length) {
    list.innerHTML = `<div class="emptyState"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 21s-7-4.35-9.5-8.5C.7 9 2 5.5 5.5 4.7 8 4.1 10 5.3 12 7.5c2-2.2 4-3.4 6.5-2.8C22 5.5 23.3 9 21.5 12.5 19 16.65 12 21 12 21z"/></svg><div>Nothing yet — after a few calls, useful details Emysa picks up on will show up here.</div></div>`;
    return;
  }
  for (const m of memories) {
    const el = document.createElement('div');
    el.className = 'memoryCard';
    const date = new Date(m.created_at).toLocaleDateString([], { month: 'short', day: 'numeric' });
    el.innerHTML = `
      ${m.contactName ? `<div class="memoryContact">${escapeHtml(m.contactName)}</div>` : ''}
      <div class="memoryContent">${escapeHtml(m.content)}</div>
      <div class="memoryDate">${date}</div>
      <button class="memoryDelete" aria-label="Delete"><svg viewBox="0 0 24 24" fill="none"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></button>`;
    el.querySelector('.memoryDelete').addEventListener('click', async () => {
      await authedFetch('/api/memories', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: m.id }) });
      loadMemories();
    });
    list.appendChild(el);
  }
}

// ---------- Call Settings ----------
async function loadCallSettings() {
  const resp = await authedFetch('/api/call-answering?action=settings');
  if (!resp.ok) return;
  const data = await resp.json();
  setToggle($('autoRetryToggle'), data.auto_retry);
  setToggle($('recordCallsToggle'), data.record_calls);
  document.querySelectorAll('#ringSecondsGroup .segmentedBtn').forEach((btn) => {
    btn.classList.toggle('active', Number(btn.dataset.value) === data.ring_seconds);
  });
  document.querySelectorAll('#callModeGroup .segmentedBtn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.value === data.default_call_mode);
  });
  setToggle($('vcDefaultToggle'), data.vc_enabled);
  loadDefaultVoiceSelect(data.vc_model_slot);
}

// Same voice list as the in-call selector, but populated from the profile's
// stored default rather than from a live call. Fails soft: the voice changer
// is an optional extra, and Call Settings has to keep working when the GPU
// box behind it is asleep or not set up at all.
async function loadDefaultVoiceSelect(storedSlot) {
  const select = $('vcDefaultSelect');
  const status = $('vcSettingsStatus');
  let models = vcModelsCache;
  if (!models) {
    const resp = await authedFetch('/api/calls?action=vcState');
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || !data.configured || !data.models?.length) {
      select.innerHTML = '<option value="">Not configured</option>';
      select.disabled = true;
      status.textContent = data.error || 'No voice changer is connected, so Direct Voice will send your own microphone audio.';
      return;
    }
    models = data.models;
    vcModelsCache = models;
    vcActiveSlot = data.activeSlot;
  }
  status.textContent = '';
  select.disabled = false;
  select.innerHTML = models
    .map((m) => `<option value="${m.slot}">${escapeHtml(m.name)}${m.type ? ` (${escapeHtml(m.type)})` : ''}</option>`)
    .join('');
  const want = storedSlot ?? vcActiveSlot ?? models[0].slot;
  if (models.some((m) => m.slot === want)) select.value = String(want);
}

document.querySelectorAll('#callModeGroup .segmentedBtn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#callModeGroup .segmentedBtn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    authedFetch('/api/call-answering?action=settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ default_call_mode: btn.dataset.value }),
    });
  });
});
$('vcDefaultToggle').addEventListener('click', () => {
  const on = !$('vcDefaultToggle').classList.contains('on');
  setToggle($('vcDefaultToggle'), on);
  authedFetch('/api/call-answering?action=settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ vc_enabled: on }),
  });
});
$('vcDefaultSelect').addEventListener('change', (e) => {
  const slot = Number(e.target.value);
  if (!Number.isFinite(slot)) return;
  // Goes through vcSet rather than the settings endpoint: that one also asks
  // the relay to load the model now, so the first direct call doesn't wait on
  // a cold model load.
  authedFetch('/api/calls?action=vcSet', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slot }),
  }).then((resp) => resp.json().catch(() => ({})).then((d) => {
    $('vcSettingsStatus').textContent = resp.ok && !d.error
      ? 'Saved.'
      : `Saved as your default, but it isn't loaded yet: ${d.error || 'voice changer unreachable'}`;
  }));
});
$('autoRetryToggle').addEventListener('click', () => {
  const on = !$('autoRetryToggle').classList.contains('on');
  setToggle($('autoRetryToggle'), on);
  authedFetch('/api/call-answering?action=settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ auto_retry: on }) });
});
$('recordCallsToggle').addEventListener('click', () => {
  const on = !$('recordCallsToggle').classList.contains('on');
  setToggle($('recordCallsToggle'), on);
  authedFetch('/api/call-answering?action=settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ record_calls: on }) });
});
document.querySelectorAll('#ringSecondsGroup .segmentedBtn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#ringSecondsGroup .segmentedBtn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    authedFetch('/api/call-answering?action=settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ring_seconds: Number(btn.dataset.value) }) });
  });
});

// ---------- Archive ----------
async function loadArchivedChats() {
  const resp = await authedFetch('/api/assistant?action=sessions&archived=true');
  const list = $('archivedChatsList');
  list.innerHTML = '';
  if (!resp.ok) return;
  const { sessions } = await resp.json();
  if (!sessions?.length) {
    list.innerHTML = `<div class="emptyState"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="4" width="18" height="5" rx="1.5"/><path d="M5 9v8a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9M10 13h4"/></svg><div>No archived chats.</div></div>`;
    return;
  }
  for (const s of sessions) {
    const row = document.createElement('div');
    row.className = 'profileCard';
    row.innerHTML = `<div class="cBody"><div class="cValue">${escapeHtml(s.title)}</div></div>`;
    const restore = document.createElement('button');
    restore.className = 'secondaryBtn';
    restore.style.cssText = 'width:auto; padding:8px 14px;';
    restore.textContent = 'Restore';
    restore.addEventListener('click', async () => {
      await authedFetch('/api/assistant?action=archiveSession', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: s.id, archived: false }) });
      loadArchivedChats();
    });
    row.appendChild(restore);
    list.appendChild(row);
  }
}

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
  if (!resp.ok) { $('voiceRecordStatus').textContent = data.detail ? `${data.error}: ${data.detail}`.slice(0, 300) : (data.error || 'Could not generate a preview.'); return; }
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
$('socialCallingBtn').addEventListener('click', () => { openSheet('sheet-social-calling'); loadSocialAccounts(); });

// ---------- Connected accounts (Telegram / WhatsApp) ----------
async function loadSocialAccounts() {
  $('telegramLoginForm').classList.add('hidden');
  $('telegramOtpForm').classList.add('hidden');
  $('whatsappQrWrap').classList.add('hidden');
  $('telegramLoginError').textContent = '';
  $('whatsappLoginError').textContent = '';
  try {
    const resp = await authedFetch('/api/social-calling');
    const data = await resp.json();
    renderTelegramStatus(data.telegram);
    renderWhatsappStatus(data.whatsapp);
  } catch { /* leave defaults showing */ }
}

function renderTelegramStatus(tg) {
  const statusEl = $('telegramAccountStatus');
  const subEl = $('telegramAccountSub');
  const btn = $('telegramConnectBtn');
  if (tg?.status === 'connected') {
    statusEl.textContent = `Connected as ${tg.displayName || 'Telegram user'}`;
    subEl.textContent = tg.phoneLast4 ? `Ending in ${tg.phoneLast4}` : '';
    btn.textContent = 'Disconnect';
    btn.onclick = async () => { await authedFetch('/api/social-calling?action=telegram-disconnect', { method: 'POST' }); loadSocialAccounts(); };
  } else {
    statusEl.textContent = 'Not connected';
    subEl.textContent = tg?.error || '';
    btn.textContent = 'Connect';
    btn.onclick = () => { $('telegramLoginForm').classList.remove('hidden'); $('telegramOtpForm').classList.add('hidden'); };
  }
}

function renderWhatsappStatus(wa) {
  const statusEl = $('whatsappAccountStatus');
  const subEl = $('whatsappAccountSub');
  const btn = $('whatsappConnectBtn');
  if (wa?.status === 'connected') {
    statusEl.textContent = `Connected as ${wa.displayName || 'WhatsApp user'}`;
    subEl.textContent = '';
    btn.textContent = 'Disconnect';
    btn.onclick = async () => { await authedFetch('/api/social-calling?action=whatsapp-disconnect', { method: 'POST' }); loadSocialAccounts(); };
  } else {
    statusEl.textContent = 'Not connected';
    subEl.textContent = wa?.error || '';
    btn.textContent = 'Connect';
    btn.onclick = startWhatsappLink;
  }
}

$('telegramSendCodeBtn').addEventListener('click', async () => {
  const phone = $('telegramPhoneInput').value.trim();
  $('telegramLoginError').textContent = '';
  if (!phone) { $('telegramLoginError').textContent = 'Enter your phone number.'; return; }
  $('telegramSendCodeBtn').disabled = true;
  try {
    const resp = await authedFetch('/api/social-calling?action=telegram-start', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Could not send code');
    $('telegramLoginForm').classList.add('hidden');
    $('telegramOtpForm').classList.remove('hidden');
  } catch (err) {
    $('telegramLoginError').textContent = err.message;
  } finally {
    $('telegramSendCodeBtn').disabled = false;
  }
});

$('telegramVerifyBtn').addEventListener('click', async () => {
  const code = $('telegramCodeInput').value.trim();
  const password = $('telegramPasswordInput').value;
  $('telegramLoginError').textContent = '';
  if (!code) { $('telegramLoginError').textContent = 'Enter the code Telegram sent you.'; return; }
  $('telegramVerifyBtn').disabled = true;
  try {
    const resp = await authedFetch('/api/social-calling?action=telegram-verify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, password }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Could not verify code');
    if (data.status === 'needs_password') {
      $('telegramPasswordField').classList.remove('hidden');
      $('telegramLoginError').textContent = 'This account has 2FA — enter your password too.';
      return;
    }
    $('telegramOtpForm').classList.add('hidden');
    loadSocialAccounts();
  } catch (err) {
    $('telegramLoginError').textContent = err.message;
  } finally {
    $('telegramVerifyBtn').disabled = false;
  }
});

let whatsappPollTimer = null;

function watchWhatsappStatus() {
  clearInterval(whatsappPollTimer);
  whatsappPollTimer = setInterval(async () => {
    const r = await authedFetch('/api/social-calling?action=whatsapp-status');
    const d = await r.json();
    if (d.qr) $('whatsappQrImg').src = d.qr;
    if (d.pairingCode) showWhatsappPairingCode(d.pairingCode);
    if (d.status === 'connected') {
      clearInterval(whatsappPollTimer);
      $('whatsappQrWrap').classList.add('hidden');
      loadSocialAccounts();
    }
  }, 3000);
}

function showWhatsappPairingCode(code) {
  $('whatsappPairingCodeWrap').classList.remove('hidden');
  $('whatsappPairingCodeValue').textContent = code.split('').join(' ');
}

async function startWhatsappLink() {
  $('whatsappLoginError').textContent = '';
  $('whatsappQrWrap').classList.remove('hidden');
  $('whatsappLinkModeGroup').querySelectorAll('.segmentedBtn').forEach((b) => b.classList.toggle('active', b.dataset.mode === 'qr'));
  $('whatsappQrPane').classList.remove('hidden');
  $('whatsappPhonePane').classList.add('hidden');
  $('whatsappPairingCodeWrap').classList.add('hidden');
  try {
    const resp = await authedFetch('/api/social-calling?action=whatsapp-start', { method: 'POST' });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Could not start WhatsApp link');
    if (data.qr) $('whatsappQrImg').src = data.qr;
    if (data.status === 'connected') { $('whatsappQrWrap').classList.add('hidden'); loadSocialAccounts(); return; }
    watchWhatsappStatus();
  } catch (err) {
    $('whatsappLoginError').textContent = err.message;
  }
}

$('whatsappLinkModeGroup').querySelectorAll('.segmentedBtn').forEach((btn) => {
  btn.addEventListener('click', () => {
    $('whatsappLinkModeGroup').querySelectorAll('.segmentedBtn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    $('whatsappQrPane').classList.toggle('hidden', btn.dataset.mode !== 'qr');
    $('whatsappPhonePane').classList.toggle('hidden', btn.dataset.mode !== 'phone');
  });
});

$('whatsappPhoneSubmitBtn').addEventListener('click', async () => {
  const phone = $('whatsappPhoneInput').value.trim();
  if (!phone) { $('whatsappLoginError').textContent = 'Enter a phone number first.'; return; }
  $('whatsappLoginError').textContent = '';
  $('whatsappPhoneSubmitBtn').disabled = true;
  $('whatsappPhoneSubmitBtn').textContent = 'Requesting code…';
  try {
    const resp = await authedFetch('/api/social-calling?action=whatsapp-start-phone', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Could not get a pairing code');
    if (data.status === 'connected') { $('whatsappQrWrap').classList.add('hidden'); loadSocialAccounts(); return; }
    if (data.pairingCode) showWhatsappPairingCode(data.pairingCode);
    watchWhatsappStatus();
  } catch (err) {
    $('whatsappLoginError').textContent = err.message;
  } finally {
    $('whatsappPhoneSubmitBtn').disabled = false;
    $('whatsappPhoneSubmitBtn').textContent = 'Get code';
  }
});

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
const authBgVideoEl = $('authBgVideo');
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

let authBgVideoUrls = [];
let authBgVideoIndex = 0;
function playNextAuthBgVideo() {
  authBgVideoEl.src = authBgVideoUrls[authBgVideoIndex];
  authBgVideoEl.loop = authBgVideoUrls.length === 1;
  authBgVideoEl.play().catch(() => {});
}
authBgVideoEl.addEventListener('ended', () => {
  authBgVideoIndex = (authBgVideoIndex + 1) % authBgVideoUrls.length;
  playNextAuthBgVideo();
});

// Public read (no sign-in needed) so the welcome/login screens can be
// themed before anyone has authenticated. A video, if one's been uploaded,
// takes over as the background entirely; otherwise falls back to the
// crossfading image gallery.
(async () => {
  const { data } = await supabase.from('auth_backgrounds').select('url,media_type').order('created_at', { ascending: true });
  const rows = data || [];
  authBgVideoUrls = rows.filter((r) => r.media_type === 'video').map((r) => r.url);
  authBgUrls = rows.filter((r) => r.media_type !== 'video').map((r) => r.url);

  if (authBgVideoUrls.length) {
    authBgVideoEl.classList.remove('hidden');
    playNextAuthBgVideo();
    return;
  }

  if (!authBgUrls.length) return;
  showAuthBg(authBgUrls[0]);
  if (authBgUrls.length > 1) {
    setInterval(() => {
      authBgIndex = (authBgIndex + 1) % authBgUrls.length;
      showAuthBg(authBgUrls[authBgIndex]);
    }, 6000);
  }
})();
