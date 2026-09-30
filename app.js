import { normalizePhone } from './lib/phoneNumbers.js';
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
document.querySelectorAll('.tabBtn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tabBtn').forEach((b) => { b.classList.remove('active'); b.removeAttribute('aria-current'); });
    btn.setAttribute('aria-current', 'page');
    btn.classList.add('active');
    document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active', 'fadeIn'));
    const target = $(`screen-${btn.dataset.tab}`);
    target.classList.add('active', 'fadeIn');
    if (btn.dataset.tab === 'contacts') { loadContacts(); renderMyCard(); }
    $('homeInputBar').classList.toggle('visible', btn.dataset.tab === 'home');
    if (btn.dataset.tab === 'recent') { loadRecentChats(); loadCalls(); }
    if (btn.dataset.tab === 'profile') renderProfileHeader();
    if (btn.dataset.tab === 'home') startMessagePolling(); else stopMessagePolling();
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

function createSafeAvatarImg(url) {
  const img = document.createElement('img');
  img.alt = '';
  const trimmed = typeof url === 'string' ? url.trim() : '';
  img.src = /^(https?:\/\/|\/|data:image\/|icon-192\.png)/i.test(trimmed) ? trimmed : 'icon-192.png';
  return img;
}

function renderAvatar(url) {
  userAvatarUrl = url || null;
  const el = $('profileAvatarCircle');
  const initial = ($('profileEmailDisplay').textContent || currentUser?.email || '?')[0].toUpperCase();
  el.textContent = '';
  if (url) {
    el.appendChild(createSafeAvatarImg(url));
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
let chatRevision = 0;
let preCallTarget = null;
let chatSending = false;

function greetingForNow(name) {
  const h = new Date().getHours();
  const time = h < 5 ? 'night' : h < 12 ? 'morning' : h < 17 ? 'afternoon' : h < 21 ? 'evening' : 'night';
  const who = name ? `, ${name}` : '';
  return `Good ${time}${who}, what can I help you with today?`;
}

async function initHomeChat() {
  if (!currentUser) return;
  chatRevision++;
  clearPreCallContext();
  savedContacts = [];
  contactsLoaded = false;
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
  const revision = ++chatRevision;
  clearPreCallContext();
  stopMessagePolling();
  currentChatSessionId = sessionId;
  homeMessageIds.clear();
  $('homeChat').innerHTML = '';
  setHomeChatActive(false);
  const resp = await authedFetch(`/api/assistant?action=messages&sessionId=${encodeURIComponent(sessionId)}`).catch(() => null);
  if (revision !== chatRevision) return;
  if (resp?.ok) {
    const { messages } = await resp.json();
    if (revision !== chatRevision) return;
    renderHomeMessages(messages || [], true);
    const plan = [...(messages || [])].reverse().find((m) => m.call_plan?.status === 'pending' && new Date(m.call_plan.expires_at) > new Date())?.call_plan;
    if (plan) showPreCallContext({ contactId: plan.contact_id, toNumber: plan.to_number, name: plan.label, kind: plan.kind }, 'phone');
  } else {
    appendChatBubble({ role: 'assistant', content: 'Could not load this conversation. Open it again from Recent to retry.', created_at: new Date().toISOString() });
    setHomeChatActive(true);
  }
  startMessagePolling();
}

function startNewChat() {
  chatRevision++;
  clearPreCallContext();
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
    if (homeMessageIds.has(m.id)) {
      if (m.call_plan) updateCallPlanAction(m.call_plan);
      continue;
    }
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
      avatar.appendChild(createSafeAvatarImg(userAvatarUrl));
    } else {
      avatar.textContent = (currentUser?.email || '?')[0].toUpperCase();
    }
  } else {
    avatar.appendChild(createSafeAvatarImg('icon-192.png'));
  }
  const el = document.createElement('div');
  el.className = `chatMsg ${m.role === 'user' ? 'chatMsgUser' : 'chatMsgAssistant'}`;
  el.dataset.created = m.created_at;
  el.textContent = m.content;
  if (m.call_id) {
    el.classList.add('chatMsgTappable');
    el.addEventListener('click', () => openCallFromMessage(m.call_id));
  }
  if (m.call_plan) renderCallPlanAction(el, m.call_plan);
  row.appendChild(avatar);
  row.appendChild(el);
  $('homeChat').appendChild(row);
}

async function openCallFromMessage(callId) {
  const resp = await authedFetch('/api/calls?action=list');
  if (!resp.ok) return;
  const { calls } = await resp.json();
  const call = (calls || []).find((c) => c.id === callId);
  if (!call) return;
  if (['queued', 'ringing', 'in_progress', 'in-progress'].includes(call.status)) {
    openCallScreen(call.id, call.to_number, call.contact_name);
  } else {
    openCallDetail(call, call.contact_name || call.to_number, !!call.contact_name);
  }
}

// ---------- Header logo: shows a spinning ring while a call placed from
// this chat is actually happening, and opens the live call screen (with
// transcript) when tapped. ----------
let activeHeaderCall = null; // { id, toNumber, contactName } | null
let headerCallChannel = null;
let userCallsRealtimeChannel = null;

function trackActiveCall(callId, toNumber, contactName) {
  activeHeaderCall = { id: callId, toNumber, contactName };
  $('homeHeaderLogoWrap').classList.remove('hidden');
  $('homeHeaderLogoWrap').classList.add('calling');
  if (headerCallChannel) supabase.removeChannel(headerCallChannel);
  headerCallChannel = supabase
    .channel(`header-call-${callId}`)
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'calls', filter: `id=eq.${callId}` }, (payload) => {
      if (['completed', 'failed', 'no_answer', 'busy', 'canceled'].includes(payload.new.status)) clearActiveCall();
    })
    .subscribe();
}

function clearActiveCall() {
  activeHeaderCall = null;
  $('homeHeaderLogoWrap').classList.remove('calling');
  if (headerCallChannel) { supabase.removeChannel(headerCallChannel); headerCallChannel = null; }
}

// If a call placed earlier is still going (app was backgrounded, tab
// switched away, page reloaded), pick the ring back up and surface the
// live call screen automatically. Also supports ?callId= deep-links.
async function resumeActiveCallIfAny() {
  const resp = await authedFetch('/api/calls?action=list').catch(() => null);
  if (!resp?.ok) return;
  const { calls } = await resp.json();
  const urlCallId = new URLSearchParams(window.location.search).get('callId');
  if (urlCallId) {
    const deepLinked = (calls || []).find((c) => c.id === urlCallId);
    if (deepLinked) {
      if (['queued', 'ringing', 'in_progress', 'in-progress'].includes(deepLinked.status)) {
        trackActiveCall(deepLinked.id, deepLinked.to_number, deepLinked.contact_name);
        openCallScreen(deepLinked.id, deepLinked.to_number, deepLinked.contact_name);
        return;
      }
      openCallDetail(deepLinked, deepLinked.contact_name || deepLinked.to_number, !!deepLinked.contact_name);
    }
  }
  const live = (calls || []).find((c) => ['queued', 'ringing', 'in_progress', 'in-progress'].includes(c.status));
  if (live) {
    trackActiveCall(live.id, live.to_number, live.contact_name);
    openCallScreen(live.id, live.to_number, live.contact_name);
  }
  if (currentUser && !userCallsRealtimeChannel) {
    userCallsRealtimeChannel = supabase
      .channel(`user-calls-${currentUser.id}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'calls', filter: `user_id=eq.${currentUser.id}` }, (payload) => {
        const c = payload?.new;
        if (c && ['queued', 'ringing', 'in_progress', 'in-progress'].includes(c.status)) {
          trackActiveCall(c.id, c.to_number, c.contact_name);
          if ($('callScreen').classList.contains('hidden') && !assistantCallOpen) {
            openCallScreen(c.id, c.to_number, c.contact_name);
          }
        }
      })
      .subscribe();
  }
}

$('homeHeaderLogoWrap').addEventListener('click', () => {
  if (assistantCallOpen) {
    $('callScreen').classList.remove('hidden');
    return;
  }
  if (activeHeaderCall) openCallScreen(activeHeaderCall.id, activeHeaderCall.toNumber, activeHeaderCall.contactName);
});

async function sendChatMessage(text, onReply, source = 'text', channel = null) {
  const isCall = source === 'call';
  const revision = chatRevision;
  const target = !isCall && preCallTarget ? { ...preCallTarget } : null;
  if (!isCall) {
    appendChatBubble({ id: `local-${Date.now()}`, role: 'user', content: text, created_at: new Date().toISOString() });
    setHomeChatActive(true);
    scrollHomeChatToBottom();
  }

  const resp = await authedFetch(target?.channel === 'phone' ? '/api/assistant?action=prepareCall' : '/api/assistant?action=send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, sessionId: currentChatSessionId, source, channel: target?.channel || channel || currentCallChannel(), target }),
  });
  const data = await resp.json();
  if (revision !== chatRevision) return;
  if (!resp.ok) {
    const errText = data.error || 'Something went wrong.';
    if (onReply) { await onReply(errText, null); return; }
    throw new Error(errText);
  }
  if (data.sessionId) currentChatSessionId = data.sessionId;
  if (data.callId && data.toNumber) {
    trackActiveCall(data.callId, data.toNumber, data.contactName);
    clearPreCallContext();
    openCallScreen(data.callId, data.toNumber, data.contactName);
  }
  // The server can pick a different line than the UI's sticky selection -
  // e.g. the user typed "call him on WhatsApp" while the badge still said
  // Telegram from an earlier message. When that happens, pull the picker
  // and badge into line with what was actually used, so they're not stuck
  // showing a line that isn't the one in effect.
  if (data.channelUsed && data.channelUsed !== currentCallChannel()) {
    setCallChannel(data.channelUsed, { focus: false });
  }
  const replies = (data.messages || []).filter((m) => m.role !== 'user');
  if (!isCall) {
    // The optimistic user bubble above already shows this turn; mark the
    // server's saved copy of it as seen (without re-rendering) so the next
    // poll doesn't draw a second, duplicate copy of the same user message.
    const savedUserMsg = (data.messages || []).find((m) => m.role === 'user');
    if (savedUserMsg) homeMessageIds.add(savedUserMsg.id);
    renderHomeMessages(replies, false);
    if (replies.some((m) => m.call_plan)) $('preCallContext').classList.add('ready');
  }
  if (onReply) await onReply(replies.map((m) => m.content).join(' ') || '', data);
}

async function sendBrief() {
  const text = $('briefInput').value.trim();
  if (!text || chatSending) return;
  chatSending = true;
  $('cancelPreCallBtn').disabled = true;
  const revision = chatRevision;
  $('sendBtn').disabled = true;
  $('briefInput').value = '';
  $('briefInput').style.height = 'auto';
  try {
    await sendChatMessage(text, null, 'text', currentCallChannel());
  } catch (err) {
    if (revision === chatRevision) {
      $('briefInput').value = text;
      resizeBriefInput();
      appendChatBubble({ role: 'assistant', content: err.message || 'Connection lost. Please try again.', created_at: new Date().toISOString() });
      setHomeChatActive(true);
    }
  } finally {
    chatSending = false;
    $('cancelPreCallBtn').disabled = false;
    $('sendBtn').disabled = false;
    syncHomeChatPadding();
  }
}

$('sendBtn').addEventListener('click', sendBrief);
$('briefInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); sendBrief(); }
  // Plain Enter now inserts a newline (default textarea behavior) instead of
  // sending — only the send button, or Cmd/Ctrl+Enter, submits the message.
});
$('briefInput').addEventListener('input', () => {
  resizeBriefInput();
  syncHomeChatPadding();
});
function resizeBriefInput() {
  const el = $('briefInput');
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 120) + 'px';
}

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
    if (!currentChatSessionId || chatSending) return;
    const revision = chatRevision;
    const resp = await authedFetch(`/api/assistant?action=messages&sessionId=${encodeURIComponent(currentChatSessionId)}`).catch(() => null);
    if (!resp || revision !== chatRevision) return;
    if (!resp.ok) return;
    const { messages } = await resp.json();
    if (revision !== chatRevision || chatSending) return;
    renderHomeMessages(messages || [], false);
  }, 5000);
}
function stopMessagePolling() {
  clearInterval(pollTimer);
  pollTimer = null;
}

// ---------- Home header: new-chat button; chat history lives under Recent > Chat ----------
function shortDateLabel(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

$('homeMenuBtn').addEventListener('click', () => startNewChat());

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

function setCallStatePill(phase, label) {
  const pill = $('callStatePill');
  if (!pill) return;
  pill.dataset.phase = phase || 'connecting';
  pill.textContent = label || 'Connecting…';
}

function appendCallTranscriptLine(speaker, content) {
  const panel = $('transcriptPanel');
  if (!panel) return;
  panel.querySelector('.transcriptEmptyHint')?.remove();
  const normalizedSpeaker = (speaker === 'ai' || speaker === 'assistant') ? 'ai' : 'user';
  const el = document.createElement('div');
  el.className = `transcriptLine ${normalizedSpeaker}`;
  const dot = document.createElement('div');
  dot.className = 'transcriptDot';
  if (normalizedSpeaker === 'ai') {
    dot.appendChild(createSafeAvatarImg('icon-192.png'));
  } else if (userAvatarUrl) {
    dot.appendChild(createSafeAvatarImg(userAvatarUrl));
  } else {
    dot.textContent = (currentUser?.email || '?')[0].toUpperCase();
  }
  const bubble = document.createElement('div');
  bubble.className = 'transcriptBubble';
  bubble.textContent = content || '';
  el.append(dot, bubble);
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
  setCallStatePill('speaking', 'Emysa speaking…');
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
    if (assistantCallOpen) {
      setCallStatePill(assistantMuted ? 'muted' : 'listening', assistantMuted ? 'Microphone muted' : 'Connected · Listening');
    }
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

function minimizeCallScreenToChat() {
  $('callScreen').classList.add('hidden');
  if (assistantCallOpen || activeCallScreenId) {
    $('homeHeaderLogoWrap').classList.remove('hidden');
    $('homeHeaderLogoWrap').classList.add('calling');
  }
}

function endAssistantCall() {
  if (waveRecorder && waveRecorder.state === 'recording') waveRecorder.stop();
  assistantCallOpen = false;
  clearInterval(callTimerInterval);
  $('callScreen').classList.add('hidden');
  $('callScreen').classList.remove('assistantMode');
  $('callContactAvatar').style.display = '';
  if (!activeHeaderCall) $('homeHeaderLogoWrap').classList.remove('calling');
  postCallSummary();
}

function openAssistantCallScreen() {
  if (assistantCallOpen) {
    $('callScreen').classList.remove('hidden');
    return;
  }
  assistantCallOpen = true;
  assistantMuted = false;
  callTranscriptForSummary = [];
  $('callScreen').classList.remove('hidden', 'captionsHidden');
  $('callScreen').classList.add('assistantMode');
  $('callFaceTimeBtn')?.classList.add('active');
  $('callAudioBtn').innerHTML = MORE_BTN_HTML;
  $('callAudioBtn').onclick = () => openCallMoreMenu();
  $('callContactAvatar').style.display = 'none';
  $('callTitleText').textContent = 'Emysa';
  $('transcriptPanel').textContent = '';
  $('waveRow').classList.remove('speaking');
  $('callMuteBtn').classList.remove('active');
  setCallStatePill('connecting', 'Connecting to Emysa…');
  $('homeHeaderLogoWrap').classList.remove('hidden');
  $('homeHeaderLogoWrap').classList.add('calling');

  const startedAt = Date.now();
  clearInterval(callTimerInterval);
  callTimerInterval = setInterval(() => {
    const secs = Math.floor((Date.now() - startedAt) / 1000);
    const m = String(Math.floor(secs / 60)).padStart(2, '0');
    const s = String(secs % 60).padStart(2, '0');
    $('callTimer').textContent = `${m}:${s}`;
  }, 1000);

  $('callEndBtn').onclick = () => endAssistantCall();
  $('callMinimizeBtn').onclick = () => minimizeCallScreenToChat();
  $('callAddBtn').onclick = () => minimizeCallScreenToChat();
  $('callFaceTimeBtn').onclick = () => {
    const hidden = $('callScreen').classList.toggle('captionsHidden');
    $('callFaceTimeBtn').classList.toggle('active', !hidden);
  };
  $('callMuteBtn').onclick = () => {
    assistantMuted = !assistantMuted;
    $('callMuteBtn').classList.toggle('active', assistantMuted);
    setCallStatePill(assistantMuted ? 'muted' : 'listening', assistantMuted ? 'Microphone muted' : 'Connected · Listening');
    if (assistantMuted && waveRecorder?.state === 'recording') waveRecorder.stop();
    else if (!assistantMuted && assistantCallOpen) startAssistantListening();
  };
  $('callKeypadBtn').onclick = () => {
    $('dialStatus').textContent = '';
    updateDialMatch();
    $('keypadDialog').showModal();
  };
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
            setCallStatePill('connecting', 'Emysa thinking…');
            let shouldTerminateAfterReply = false;
            await sendChatMessage(data.text.trim(), async (reply, resData) => {
              if (resData?.endCall) shouldTerminateAfterReply = true;
              if (assistantCallOpen && reply) {
                appendCallTranscriptLine('ai', reply);
                callTranscriptForSummary.push({ role: 'assistant', content: reply });
                await speakReply(reply);
              }
            }, 'call', currentCallChannel());
            if (shouldTerminateAfterReply && assistantCallOpen) {
              setCallStatePill('ended', 'Call ended');
              endAssistantCall();
              return;
            }
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
const CALL_CHANNEL_KEY = 'emysa.callChannel';
let selectedCallChannel = null; // null = Phone (Twilio); otherwise 'whatsapp' | 'telegram'
try {
  const saved = localStorage.getItem(CALL_CHANNEL_KEY);
  if (saved === 'whatsapp' || saved === 'telegram') selectedCallChannel = saved;
} catch {}
// Always an explicit value — the server refuses to guess a line.
function currentCallChannel() { return selectedCallChannel || 'phone'; }

const CHANNEL_META = {
  whatsapp: { label: 'WhatsApp', placeholder: 'Paste a number to call on WhatsApp…' },
  telegram: { label: 'Telegram', placeholder: 'Paste a number to call on Telegram…' },
  phone: { label: null, placeholder: 'Message' },
};

function setCallChannel(channel, { focus = true } = {}) {
  selectedCallChannel = channel === 'phone' ? null : channel;
  try { localStorage.setItem(CALL_CHANNEL_KEY, currentCallChannel()); } catch {}
  const meta = CHANNEL_META[channel] || CHANNEL_META.phone;
  $('briefInput').placeholder = meta.placeholder;
  $('channelBadge').classList.toggle('visible', !!meta.label);
  if (meta.label) $('channelBadgeText').textContent = `Calling on ${meta.label}`;
  if (focus) $('briefInput').focus();
}
// Restore the persisted line's badge/placeholder on load (without opening the keyboard).
if (selectedCallChannel) setCallChannel(selectedCallChannel, { focus: false });

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
    if (channel === 'emysa-live') {
      openAssistantCallScreen();
      return;
    }
    if (channel === 'emysa') {
      // Direct in-app voice chat with Emysa — no phone number, no Twilio
      // call, no inbound/outbound direction. iOS Safari only allows audio
      // playback that traces back to a direct, synchronous tap — resuming
      // the AudioContext here, inside the real tap, unlocks every later
      // programmatic buffer playback on this context for the rest of the call.
      const ctx = getAssistantAudioCtx();
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
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
let savedContacts = [];
let contactsLoaded = false;
const PHONE_ICON = '<svg viewBox="0 0 24 24" fill="none"><path d="M6.6 10.8c1.2 2.4 3.2 4.4 5.6 5.6l1.9-1.9c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.5.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1C10.6 21 3 13.4 3 4c0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.2.2 2.4.6 3.5.1.4 0 .8-.2 1l-1.9 1.9z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>';
async function loadContacts() {
  const list = $('contactsList');
  list.textContent = 'Loading contacts…';
  try {
    const resp = await authedFetch('/api/contacts');
    if (!resp.ok) throw new Error('Could not load contacts. Tap Contacts to retry.');
    const { contacts } = await resp.json();
    savedContacts = contacts || [];
    contactsLoaded = true;
    $('contactsSearch').value = '';
    renderContactsList(savedContacts);
    updateDialMatch();
  } catch (err) {
    contactsLoaded = false;
    savedContacts = [];
    updateDialMatch();
    list.textContent = err.message || 'Could not load contacts. Tap Contacts to retry.';
  }
}

function renderContactRow(c) {
  const el = document.createElement('div');
  el.className = 'contactRow';
  const name = document.createElement('div');
  name.className = 'cValue';
  name.textContent = c.name;
  const call = document.createElement('button');
  call.className = 'contactCallBtn';
  call.setAttribute('aria-label', `Call ${c.name}`);
  call.setAttribute('aria-haspopup', 'dialog');
  call.innerHTML = PHONE_ICON;
  call.onclick = (e) => { e.stopPropagation(); openContactMethods(c, e.currentTarget); };
  const del = document.createElement('button');
  del.className = 'contactRemoveBtn';
  del.textContent = '×';
  del.setAttribute('aria-label', `Remove ${c.name}`);
  del.onclick = async (e) => {
    e.stopPropagation();
    if (!confirm(`Remove ${c.name} from contacts?`)) return;
    del.disabled = true;
    try {
      await callApi('/api/contacts', { id: c.id }, 'DELETE');
      await loadContacts();
    } catch (err) { $('contactStatus').textContent = err.message; }
    finally { del.disabled = false; }
  };
  el.append(name, call, del);
  return el;
}

// Groups contacts by first letter (A-Z), everything else under "#", so the
// list can render iOS-style section headers plus a jump-to-letter index.
function renderContactsList(contacts) {
  const list = $('contactsList');
  const azIndex = $('azIndex');
  list.innerHTML = '';
  azIndex.innerHTML = '';
  if (!contacts.length) {
    list.textContent = savedContacts.length ? 'No matches.' : 'No contacts yet. Add someone or open the keypad below.';
    return;
  }
  const sorted = [...contacts].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  const groups = new Map();
  for (const c of sorted) {
    const first = (c.name || '#').trim()[0]?.toUpperCase() || '#';
    const key = /[A-Z]/.test(first) ? first : '#';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  const ordered = [...groups.entries()].sort(([a], [b]) => (a === '#' ? 1 : b === '#' ? -1 : a.localeCompare(b)));
  for (const [letter, items] of ordered) {
    const label = document.createElement('div');
    label.className = 'contactsSectionLabel';
    label.id = `contactsSection-${letter}`;
    label.textContent = letter;
    list.appendChild(label);
    for (const c of items) list.appendChild(renderContactRow(c));
  }
  const present = new Set(groups.keys());
  for (const letter of '#ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = letter;
    btn.className = 'azIndexBtn';
    if (!present.has(letter)) btn.disabled = true;
    btn.onclick = () => $(`contactsSection-${letter}`)?.scrollIntoView({ block: 'start' });
    azIndex.appendChild(btn);
  }
}

$('contactsSearch').addEventListener('input', () => {
  const q = $('contactsSearch').value.trim().toLowerCase();
  renderContactsList(!q ? savedContacts : savedContacts.filter((c) => (c.name || '').toLowerCase().includes(q) || (c.phone_number || '').includes(q)));
});

function renderMyCard() {
  const name = ($('profileEmailDisplay').textContent || 'You').trim() || 'You';
  $('myCardName').textContent = name;
  const avatarEl = $('myCardAvatar');
  avatarEl.textContent = '';
  if (userAvatarUrl) avatarEl.appendChild(createSafeAvatarImg(userAvatarUrl));
  else avatarEl.textContent = name[0].toUpperCase();
}
$('myCardRow').addEventListener('click', () => document.querySelector('[data-tab=profile]').click());
$('contactsAddBtn').addEventListener('click', () => {
  $('contactEditor').open = !$('contactEditor').open;
  if ($('contactEditor').open) $('newContactName').focus();
});

$('addContactBtn').addEventListener('click', async () => {
  const name = $('newContactName').value.trim();
  const phoneNumber = normalizePhone($('newContactPhone').value);
  if (!name || !phoneNumber) { $('contactStatus').textContent = 'Enter a name and a phone number with country code.'; return; }
  $('addContactBtn').disabled = true;
  $('contactStatus').textContent = 'Saving…';
  try {
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
    $('contactEditor').open = false;
    await loadContacts();
  } catch (err) {
    $('contactStatus').textContent = err.message || 'Could not save contact. Please try again.';
  } finally {
    $('addContactBtn').disabled = false;
  }
});

// ---------- contact actions, keypad and persisted call confirmations ----------
async function callApi(url, body, method = 'POST') {
  const response = await authedFetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Request failed. Please try again.');
  return data;
}

function clearPreCallContext() {
  preCallTarget = null;
  setCallChannel('phone', { focus: false });
  $('preCallContext').classList.add('hidden');
  $('briefInput').placeholder = 'Message';
  $('channelBadge').classList.remove('visible');
}
function showPreCallContext(target, channel) {
  preCallTarget = { ...target, channel };
  setCallChannel(channel, { focus: false });
  $('preCallLabel').textContent = `${target.name || target.toNumber} · ${channel === 'phone' ? 'Phone' : CHANNEL_META[channel].label}`;
  $('preCallHint').textContent = channel === 'phone'
    ? 'What should Emysa say? Send your instructions to get a summary before calling.'
    : 'What should Emysa say? Sending your instructions starts this contact’s call.';
  $('preCallContext').classList.remove('hidden', 'ready');
  $('briefInput').placeholder = 'Call instructions…';
}
function beginPreCall(target, channel) {
  startNewChat();
  showPreCallContext(target, channel);
  document.querySelector('[data-tab=home]').click();
  $('briefInput').focus();
}
$('cancelPreCallBtn').addEventListener('click', async () => {
  const sessionId = currentChatSessionId;
  $('cancelPreCallBtn').disabled = true;
  try {
    if (sessionId) await callApi('/api/assistant?action=cancelCall', { sessionId });
    if (sessionId === currentChatSessionId) {
      document.querySelectorAll('.callPlanActions[data-status="pending"]').forEach((el) => {
        el.dataset.status = 'cancelled';
        el.querySelector('.callNowBtn').disabled = true;
        el.querySelector('.callPlanStatus').textContent = 'Cancelled';
      });
      clearPreCallContext();
    }
  } catch (err) { $('preCallHint').textContent = err.message; }
  finally { $('cancelPreCallBtn').disabled = false; }
});

function renderCallPlanAction(bubble, plan) {
  if (plan.status === 'pending') {
    document.querySelectorAll('.callPlanActions[data-status="pending"]').forEach((el) => {
      if (el.dataset.planId === plan.id) return;
      el.dataset.status = 'cancelled';
      el.querySelector('.callNowBtn').disabled = true;
      el.querySelector('.callPlanStatus').textContent = 'Replaced by the new script below';
    });
  }
  const actions = document.createElement('div');
  actions.className = 'callPlanActions';
  actions.dataset.planId = plan.id;
  actions.dataset.status = plan.status;
  const script = document.createElement('details');
  const heading = document.createElement('summary');
  heading.textContent = 'Call instructions';
  const content = document.createElement('pre');
  content.textContent = plan.objective;
  script.append(heading, content);
  const button = document.createElement('button');
  button.className = 'primaryBtn callNowBtn';
  button.textContent = 'Call Now';
  const edit = document.createElement('button');
  edit.className = 'secondaryBtn';
  edit.textContent = 'Revise script';
  edit.onclick = () => {
    showPreCallContext({ contactId: plan.contact_id, toNumber: plan.to_number, name: plan.label, kind: plan.kind }, 'phone');
    $('briefInput').value = plan.script || plan.objective;
    resizeBriefInput();
    $('briefInput').focus();
    syncHomeChatPadding();
  };
  const status = document.createElement('p');
  status.className = 'callPlanStatus';
  status.setAttribute('role', 'status');
  button.onclick = async () => {
    if (button.disabled || chatSending) return;
    const revision = chatRevision;
    button.disabled = true;
    actions.dataset.status = 'placing';
    status.textContent = 'Placing call…';
    try {
      const data = await callApi('/api/assistant?action=confirmCall', { planId: plan.id });
      actions.dataset.status = 'placed';
      status.textContent = 'Call placed';
      trackActiveCall(data.callId, data.toNumber, data.contactName);
      if (revision === chatRevision) {
        clearPreCallContext();
        renderHomeMessages(data.messages || [], false);
        openCallScreen(data.callId, data.toNumber, data.contactName);
      }
    } catch (err) {
      // Keep disabled on ambiguous network failures; reload the persisted plan
      // rather than accidentally issuing another paid call.
      actions.dataset.status = 'failed';
      status.textContent = err.message || 'Connection lost. Check Recent before trying again.';
    }
  };
  actions.append(script, button, edit, status);
  bubble.appendChild(actions);
  updateCallPlanAction(plan, actions);
}
function updateCallPlanAction(plan, node) {
  const actions = node || Array.from(document.querySelectorAll('.callPlanActions')).find((el) => el.dataset.planId === plan.id);
  if (!actions) return;
  const expired = new Date(plan.expires_at) <= new Date();
  // Do not let a stale polling response re-enable a locally claimed button.
  if (plan.status === 'pending' && actions.dataset.status !== 'pending') return;
  actions.dataset.status = plan.status;
  actions.querySelector('.callNowBtn').disabled = plan.status !== 'pending' || expired;
  actions.querySelector('.callPlanStatus').textContent = expired && plan.status === 'pending'
    ? 'Plan expired. Revise the script to prepare a new call.'
    : ({ pending: 'Ready when you are. No call placed yet.', placing: 'Placing call…', placed: 'Call placed', cancelled: 'Replaced or cancelled', failed: 'Call failed. Check Recent before preparing another.', uncertain: 'Provider response lost. The call may still connect; check Recent.' })[plan.status];
}

let contactCallTarget = null;
function openContactMethods(contact, anchorEl) {
  contactCallTarget = contact;
  $('contactCallTitle').textContent = contact.name;
  $('contactCallNumber').textContent = contact.phone_number;
  const dialog = $('contactCallDialog');
  dialog.showModal();
  positionActionSheet(dialog, anchorEl);
}
function positionActionSheet(dialog, anchorEl) {
  if (!anchorEl) { dialog.style.top = ''; dialog.style.left = ''; dialog.style.transform = ''; return; }
  const anchor = anchorEl.getBoundingClientRect();
  dialog.style.transform = 'none';
  const sheet = dialog.getBoundingClientRect();
  const margin = 10;
  let top = anchor.bottom + margin;
  if (top + sheet.height > window.innerHeight - margin) top = anchor.top - sheet.height - margin;
  let left = anchor.right - sheet.width;
  left = Math.min(Math.max(left, margin), window.innerWidth - sheet.width - margin);
  top = Math.max(top, margin);
  dialog.style.top = `${top}px`;
  dialog.style.left = `${left}px`;
}
document.querySelectorAll('[data-method]').forEach((btn) => btn.addEventListener('click', () => {
  if (!contactCallTarget) return;
  const contact = contactCallTarget;
  $('contactCallDialog').close();
  beginPreCall({ contactId: contact.id, toNumber: contact.phone_number, name: contact.name, kind: 'contact' }, btn.dataset.method);
}));
document.querySelectorAll('[data-dismiss]').forEach((btn) => btn.addEventListener('click', () => $(btn.dataset.dismiss).close()));
document.querySelectorAll('.callDialog').forEach((dialog) => dialog.addEventListener('click', (event) => {
  const rect = dialog.getBoundingClientRect();
  if (event.target === dialog && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) dialog.close();
}));
$('openKeypadBtn').addEventListener('click', () => {
  $('dialStatus').textContent = '';
  updateDialMatch();
  $('keypadDialog').showModal();
  // Keep the native keyboard from obscuring the custom keypad on opening.
  $('keypadDialog').querySelector('[data-dismiss]').focus();
});
function matchedDialContact() {
  const number = normalizePhone($('dialNumber').value);
  return number ? savedContacts.find((c) => normalizePhone(c.phone_number) === number) : null;
}
function updateDialMatch() {
  const number = normalizePhone($('dialNumber').value);
  const match = matchedDialContact();
  $('dialMatch').textContent = match ? match.name : (number ? 'New number' : '');
  $('dialSaveBtn').classList.toggle('hidden', !number || !!match || !contactsLoaded);
  $('dialCallBtn').disabled = !number;
}
function addDialDigit(digit) {
  const input = $('dialNumber');
  if (input.value.length < 32) input.value += digit;
  updateDialMatch();
}
document.querySelectorAll('[data-digit]').forEach((btn) => btn.addEventListener('click', () => addDialDigit(btn.dataset.digit)));
$('dialPlusBtn').addEventListener('click', () => {
  if (!$('dialNumber').value.startsWith('+')) $('dialNumber').value = '+' + $('dialNumber').value;
  updateDialMatch();
});
$('dialDeleteBtn').addEventListener('click', () => { $('dialNumber').value = $('dialNumber').value.slice(0, -1); updateDialMatch(); });
$('dialNumber').addEventListener('input', updateDialMatch);
$('dialSaveBtn').addEventListener('click', () => {
  const number = normalizePhone($('dialNumber').value);
  if (!number || matchedDialContact()) return;
  $('keypadDialog').close();
  $('contactEditor').open = true;
  $('newContactPhone').value = number;
  $('contactStatus').textContent = 'Add a name to save this number.';
  $('newContactName').focus();
});
$('dialCallBtn').addEventListener('click', () => {
  const number = normalizePhone($('dialNumber').value);
  if (!number) { $('dialStatus').textContent = 'Enter a phone number with country code. * and # are not dialable phone numbers.'; return; }
  const contact = matchedDialContact();
  $('keypadDialog').close();
  if (contact) openContactMethods(contact);
  else beginPreCall({ toNumber: number, name: number, kind: 'contact' }, 'phone');
});

// ---------- active call screen ----------
let activeCallChannel = null;
let activeCallScreenId = null;
let activeCallPollInterval = null;
let callTimerInterval = null;
let callAiMuted = false;

function applyCallStatusUpdate(callRow) {
  if (!callRow) return;
  if (Array.isArray(callRow.transcript)) {
    renderTranscript(callRow.transcript);
  }
  const st = callRow.status;
  if (st === 'queued') {
    setCallStatePill('connecting', 'Starting call…');
  } else if (st === 'ringing') {
    setCallStatePill('connecting', 'Ringing…');
  } else if (st === 'in_progress' || st === 'in-progress') {
    if (callAiMuted) {
      setCallStatePill('muted', 'Emysa muted');
    } else {
      const last = Array.isArray(callRow.transcript) && callRow.transcript.length
        ? callRow.transcript[callRow.transcript.length - 1]
        : null;
      if (last && (last.speaker === 'ai' || last.speaker === 'assistant')) {
        setCallStatePill('speaking', 'Emysa speaking…');
      } else {
        setCallStatePill('connected', 'Connected · Live');
      }
    }
  } else if (['completed', 'failed', 'no_answer', 'busy', 'canceled'].includes(st)) {
    setCallStatePill('ended', st === 'completed' ? 'Call ended' : `Call ${st.replace('_', ' ')}`);
    clearActiveCall();
    closeCallScreen();
  }
}

function openCallScreen(callId, toNumber, contactName) {
  const isSameCall = activeCallScreenId === callId && !$('callScreen').classList.contains('hidden');
  activeCallScreenId = callId;
  $('callScreen').classList.remove('hidden', 'captionsHidden');
  $('callScreen').classList.remove('assistantMode');
  $('callFaceTimeBtn')?.classList.add('active');
  $('callAudioBtn').innerHTML = AUDIO_BTN_HTML;
  $('callFaceTimeBtn').onclick = () => {
    const hidden = $('callScreen').classList.toggle('captionsHidden');
    $('callFaceTimeBtn').classList.toggle('active', !hidden);
  };
  $('callAddBtn').onclick = () => minimizeCallScreenToChat();
  $('callMinimizeBtn').onclick = () => minimizeCallScreenToChat();
  $('callContactAvatar').style.display = '';
  const displayName = contactName || toNumber || 'Caller';
  $('callContactAvatar').textContent = (contactName ? contactName[0] : (toNumber || '').replace(/[^0-9]/g, '').slice(-2)) || '?';
  $('callTitleText').textContent = contactName === 'Emysa (callback to you)' ? 'Emysa · your phone' : `Emysa & ${displayName}`;

  if (!isSameCall) {
    renderTranscript([]);
    $('waveRow').classList.remove('speaking');
    callAiMuted = false;
    $('callMuteBtn').classList.remove('active');
    setCallStatePill('connecting', 'Connecting…');

    const startedAt = Date.now();
    clearInterval(callTimerInterval);
    callTimerInterval = setInterval(() => {
      const secs = Math.floor((Date.now() - startedAt) / 1000);
      const m = String(Math.floor(secs / 60)).padStart(2, '0');
      const s = String(secs % 60).padStart(2, '0');
      $('callTimer').textContent = `${m}:${s}`;
    }, 1000);
  }

  if (activeCallChannel) supabase.removeChannel(activeCallChannel);
  activeCallChannel = supabase
    .channel(`call-${callId}`)
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'calls', filter: `id=eq.${callId}` }, (payload) => {
      applyCallStatusUpdate(payload.new);
    })
    .subscribe();

  clearInterval(activeCallPollInterval);
  const pollCallState = async () => {
    if (activeCallScreenId !== callId) return;
    const resp = await authedFetch(`/api/calls?action=get&callId=${encodeURIComponent(callId)}`).catch(() => null);
    if (!resp?.ok || activeCallScreenId !== callId) return;
    const { call } = await resp.json().catch(() => ({}));
    if (call) applyCallStatusUpdate(call);
  };
  pollCallState();
  activeCallPollInterval = setInterval(pollCallState, 3000);

  $('callEndBtn').onclick = async () => {
    setCallStatePill('ended', 'Ending call…');
    await authedFetch('/api/calls?action=hangup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callId }),
    }).catch(() => {});
    clearActiveCall();
    closeCallScreen();
  };

  $('callMuteBtn').onclick = async () => {
    callAiMuted = !callAiMuted;
    $('callMuteBtn').classList.toggle('active', callAiMuted);
    setCallStatePill(callAiMuted ? 'muted' : 'connected', callAiMuted ? 'Emysa muted' : 'Connected · Live');
    await authedFetch('/api/calls?action=mute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callId, muted: callAiMuted }),
    }).catch(() => {});
  };

  $('callAudioBtn').onclick = () => $('callAudioBtn').classList.toggle('active');
  $('callKeypadBtn').onclick = () => {
    $('dialStatus').textContent = '';
    updateDialMatch();
    $('keypadDialog').showModal();
  };
}

function closeCallScreen() {
  activeCallScreenId = null;
  clearInterval(callTimerInterval);
  clearInterval(activeCallPollInterval);
  activeCallPollInterval = null;
  if (activeCallChannel) { supabase.removeChannel(activeCallChannel); activeCallChannel = null; }
  $('callScreen').classList.add('hidden');
  loadCalls();
}

function renderTranscript(history) {
  const panel = $('transcriptPanel');
  if (!panel) return;
  panel.textContent = '';
  const items = Array.isArray(history) ? history : [];
  if (items.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'transcriptEmptyHint';
    empty.textContent = 'Live transcript will appear here as the conversation unfolds…';
    panel.appendChild(empty);
    $('waveRow')?.classList.remove('speaking');
    return;
  }
  for (const line of items) {
    const isAi = line?.speaker === 'ai' || line?.speaker === 'assistant' || line?.role === 'assistant';
    const roleClass = isAi ? 'ai' : 'caller';
    const el = document.createElement('div');
    el.className = `transcriptLine ${roleClass}`;
    const dot = document.createElement('div');
    dot.className = 'transcriptDot';
    if (isAi) {
      dot.appendChild(createSafeAvatarImg('icon-192.png'));
    }
    const bubble = document.createElement('div');
    bubble.className = 'transcriptBubble';
    bubble.textContent = line?.content || line?.text || '';
    el.append(dot, bubble);
    panel.appendChild(el);
  }
  panel.scrollTop = panel.scrollHeight;
  const last = items[items.length - 1];
  const lastIsAi = last?.speaker === 'ai' || last?.speaker === 'assistant' || last?.role === 'assistant';
  $('waveRow')?.classList.toggle('speaking', !!lastIsAi);
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
  const PLATFORM_LABEL = { whatsapp: 'WhatsApp', telegram: 'Telegram' };
  for (const c of calls) {
    const isKnown = !!c.contact_name;
    const name = c.contact_name || c.to_number;
    const el = document.createElement('div');
    el.className = 'recentRow';

    const avatarHtml = isKnown
      ? `<div class="recentAvatar">${escapeHtml((name || '?')[0].toUpperCase())}</div>`
      : `<div class="recentAvatar"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10zm0 2c-4.42 0-8 2.24-8 5v1a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-1c0-2.76-3.58-5-8-5z"/></svg></div>`;

    const subtitle = isKnown
      ? (PLATFORM_LABEL[c.platform] ? `${PLATFORM_LABEL[c.platform]} Audio` : callSummaryLine(c))
      : 'unknown';

    el.innerHTML = `
      ${avatarHtml}
      <div class="recentBody">
        <div class="recentName${isKnown ? '' : ' recentName--unknown'}">${escapeHtml(name)}</div>
        <div class="recentPreview">${escapeHtml(subtitle)}</div>
      </div>
      <div class="recentMeta">
        <div class="recentDate">${relativeCallDate(c.created_at)}</div>
        <button type="button" class="recentInfoBtn" aria-label="Call details"><svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9.25" stroke="currentColor" stroke-width="1.5"/><path d="M12 11v5.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="12" cy="8" r="1.1" fill="currentColor"/></svg></button>
      </div>`;

    el.querySelector('.recentInfoBtn').addEventListener('click', (event) => { event.stopPropagation(); openCallDetail(c, name, isKnown); });
    if (c.session_id) {
      const resume = () => { openChatSession(c.session_id); document.querySelector('[data-tab=home]').click(); };
      el.tabIndex = 0;
      el.setAttribute('role', 'button');
      el.setAttribute('aria-label', `Resume call conversation with ${name}`);
      el.onclick = resume;
      el.onkeydown = (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); resume(); } };
    }
    list.appendChild(el);
  }
}

function formatCallDuration(seconds) {
  if (!seconds) return null;
  if (seconds < 60) return `${seconds} second${seconds === 1 ? '' : 's'}`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m} min${m === 1 ? '' : 's'}${s ? ` ${s} sec` : ''}`;
}
// Detail dialog state: the call currently on screen (drives "Call again")
// and an in-flight guard so a double tap can never place two calls.
let callDetailCurrent = null;
let callAgainInFlight = false;

const CALL_DETAIL_SUMMARY_SECTIONS = {
  topics: 'Topics discussed',
  learned: 'What Emysa learned',
  decisions: 'Decisions & agreements',
  commitments: 'Promises & commitments',
  details: 'Dates, amounts & specifics',
  followups: 'Follow-ups',
  unresolved: 'Still unresolved',
};

function renderCallDetailSections(summaryJson) {
  const card = $('callDetailSectionsCard');
  const box = $('callDetailSections');
  if (!card || !box) return;
  box.textContent = '';
  const sections = summaryJson && typeof summaryJson === 'object' && !Array.isArray(summaryJson) ? summaryJson : null;
  if (!sections) { card.classList.add('hidden'); return; }
  let shown = 0;
  for (const [key, label] of Object.entries(CALL_DETAIL_SUMMARY_SECTIONS)) {
    const values = (Array.isArray(sections[key]) ? sections[key] : [])
      .map((v) => String(v ?? '').trim())
      .filter(Boolean);
    if (!values.length) continue;
    shown += 1;
    const block = document.createElement('div');
    block.className = 'callDetailSection';
    const title = document.createElement('div');
    title.className = 'callDetailSectionTitle';
    title.textContent = label;
    const list = document.createElement('ul');
    for (const value of values) {
      const item = document.createElement('li');
      item.textContent = value;
      list.appendChild(item);
    }
    block.append(title, list);
    box.appendChild(block);
  }
  card.classList.toggle('hidden', shown === 0);
}

// Person-centred history: every other call with the same contact (falling
// back to the same number for rows saved before contacts were linked).
// Rows open in this same dialog, so the whole conversation history of a
// person is reachable from any one call.
async function loadCallDetailHistory(call) {
  const card = $('callDetailHistoryCard');
  const box = $('callDetailHistory');
  if (!card || !box) return;
  box.textContent = '';
  card.classList.add('hidden');
  if (!currentUser || !call?.id) return;
  let query = supabase
    .from('calls')
    .select('id, created_at, status, duration_seconds, outcome_summary, summary_json, platform, direction, contact_id, to_number, objective, instructions, session_id, transcript')
    .eq('user_id', currentUser.id)
    .order('created_at', { ascending: false })
    .limit(40);
  if (call.contact_id) query = query.eq('contact_id', call.contact_id);
  else if (call.to_number) query = query.eq('to_number', call.to_number);
  else return;
  const { data, error } = await query;
  if (error) return;
  const rows = (data || []).filter((row) => row.id !== call.id);
  if (!rows.length) {
    const empty = document.createElement('div');
    empty.className = 'callDetailHistoryEmpty';
    empty.textContent = 'This is the only call on record with this person.';
    box.appendChild(empty);
    card.classList.remove('hidden');
    return;
  }
  for (const row of rows) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'callDetailHistoryRow';
    const label = document.createElement('span');
    const created = row.created_at ? new Date(row.created_at) : null;
    const direction = row.direction === 'inbound' ? 'incoming' : 'outgoing';
    label.textContent = `${direction[0].toUpperCase()}${direction.slice(1)} call`;
    const meta = document.createElement('span');
    meta.className = 'callDetailHistoryMeta';
    const duration = formatCallDuration(row.duration_seconds);
    const statusText = CALL_TYPE_LABEL[row.direction === 'inbound' ? 'inbound' : 'outbound']?.[row.status]
      || (['queued', 'ringing', 'in_progress'].includes(row.status) ? 'Live' : '');
    meta.textContent = [created ? created.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '', duration || statusText].filter(Boolean).join(' · ');
    button.append(label, meta);
    button.onclick = async () => {
      button.disabled = true;
      try {
        const resp = await authedFetch(`/api/calls?action=get&callId=${encodeURIComponent(row.id)}`);
        const data = await resp.json();
        if (resp.ok && data.call) openCallDetail(data.call, nameFromCallRow(data.call), !!data.call.contact_id);
      } finally { button.disabled = false; }
    };
    box.appendChild(button);
  }
  card.classList.remove('hidden');
}

function nameFromCallRow(row) {
  return row?.contact_name || callDetailCurrent?.name || row?.to_number || 'Contact';
}

function setCallAgainStatus(text, isError) {
  const el = $('callDetailAgainStatus');
  if (!el) return;
  el.textContent = text || '';
  el.classList.toggle('error', !!isError);
}

// Re-place the same call: same destination, same objective, same channel.
// WhatsApp/Telegram dial straight through the platform relay; Phone runs the
// existing prepare -> confirm plan flow (the only path that can place a
// Twilio call). The server also has its own duplicate-call guard; a 409 here
// just opens the call that is already in progress.
async function callAgainFromDetail() {
  const current = callDetailCurrent;
  if (!current || callAgainInFlight) return; // double-tap guard: never dial twice
  const c = current.call;
  const name = current.name || c.to_number;
  const btn = $('callDetailAgainBtn');
  const live = ['queued', 'ringing', 'in_progress', 'in-progress'].includes(c.status);
  if (live) {
    $('callDetailDialog').close();
    trackActiveCall(c.id, c.to_number, name);
    openCallScreen(c.id, c.to_number, name);
    return;
  }
  callAgainInFlight = true;
  if (btn) btn.disabled = true;
  setCallAgainStatus('Placing call…', false);
  try {
    const platform = c.platform === 'whatsapp' || c.platform === 'telegram' ? c.platform : 'phone';
    if (platform === 'phone') {
      const text = c.objective || c.instructions || c.script || `Call ${name} again.`;
      const target = c.contact_id ? { contactId: c.contact_id } : { toNumber: c.to_number };
      const prep = await callApi('/api/assistant?action=prepareCall', {
        text, target, sessionId: c.session_id || undefined,
      });
      const plan = (prep.messages || []).map((m) => m.call_plan).find(Boolean);
      if (!plan) throw new Error('Could not prepare the call. No call was placed.');
      const data = await callApi('/api/assistant?action=confirmCall', { planId: plan.id });
      trackActiveCall(data.callId, data.toNumber, data.contactName);
      $('callDetailDialog').close();
      openCallScreen(data.callId, data.toNumber, data.contactName);
      return;
    }
    const resp = await authedFetch('/api/social-calling?action=call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        platform,
        to: c.to_number,
        contactId: c.contact_id || null,
        contactName: c.contact_name || name,
        objective: c.objective || `Call ${name} again.`,
        instructions: c.instructions || null,
        sessionId: c.session_id || null,
      }),
    });
    const data = await resp.json().catch(() => ({}));
    if (resp.status === 409) {
      const existingId = data.callId || data.dbCallId;
      setCallAgainStatus('A call to this number is already in progress.', false);
      if (existingId) {
        $('callDetailDialog').close();
        trackActiveCall(existingId, c.to_number, name);
        openCallScreen(existingId, c.to_number, name);
      }
      return;
    }
    if (!resp.ok) throw new Error(data.error || 'Could not place the call.');
    const dbCallId = data.dbCallId || data.callId;
    trackActiveCall(dbCallId, c.to_number, name);
    $('callDetailDialog').close();
    openCallScreen(dbCallId, c.to_number, name);
  } catch (err) {
    setCallAgainStatus(err.message || 'Could not place the call. Please try again.', true);
  } finally {
    callAgainInFlight = false;
    if (btn) btn.disabled = false;
  }
}

function openCallDetail(c, name, isKnown) {
  callDetailCurrent = { call: c, name, isKnown };
  $('callDetailAvatar').innerHTML = isKnown
    ? escapeHtml((name || '?')[0].toUpperCase())
    : `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10zm0 2c-4.42 0-8 2.24-8 5v1a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-1c0-2.76-3.58-5-8-5z"/></svg>`;
  $('callDetailName').textContent = name;
  const created = c.created_at ? new Date(c.created_at) : null;
  const today = new Date();
  const isToday = created && created.toDateString() === today.toDateString();
  $('callDetailDay').textContent = created
    ? (isToday ? 'Today' : created.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' }))
    : '';
  $('callDetailTime').textContent = created ? created.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : '';
  // Reuse the same status→sentence logic already trusted elsewhere in Recents,
  // rather than guessing an Incoming/Outgoing/Missed label from `direction` —
  // that doesn't cleanly apply to every kind of call this app places.
  $('callDetailType').textContent = callSummaryLine(c) || '';
  const duration = formatCallDuration(c.duration_seconds);
  $('callDetailDuration').textContent = duration ? `Duration: ${duration}` : '';
  $('callDetailDuration').classList.toggle('hidden', !duration);
  $('callDetailScriptCard').classList.toggle('hidden', !c.script);
  $('callDetailScript').textContent = c.script || '';
  const summaryText = c.summary || c.outcome_summary || c.summary_json?.summary || '';
  $('callDetailSummaryCard').classList.toggle('hidden', !summaryText);
  $('callDetailSummary').textContent = summaryText;
  renderCallDetailSections(c.summary_json);
  const transcriptCard = $('callDetailTranscriptCard');
  const transcriptEl = $('callDetailTranscript');
  if (transcriptCard && transcriptEl) {
    transcriptEl.textContent = '';
    const turns = Array.isArray(c.transcript) ? c.transcript : [];
    transcriptCard.classList.remove('hidden');
    if (turns.length > 0) {
      for (const turn of turns) {
        const row = document.createElement('div');
        row.className = 'callDetailTurn';
        const speakerLabel = document.createElement('strong');
        const isAi = turn?.speaker === 'ai' || turn?.speaker === 'assistant' || turn?.role === 'assistant';
        speakerLabel.textContent = isAi ? 'Emysa:' : `${name || 'Caller'}:`;
        const textNode = document.createTextNode(turn?.content || turn?.text || '');
        row.append(speakerLabel, textNode);
        transcriptEl.appendChild(row);
      }
    } else {
      const empty = document.createElement('div');
      empty.className = 'callDetailTurn';
      empty.textContent = 'Transcript unavailable for this call.';
      transcriptEl.appendChild(empty);
    }
  }
  const againBtn = $('callDetailAgainBtn');
  if (againBtn) {
    const isLive = ['queued', 'ringing', 'in_progress', 'in-progress'].includes(c.status);
    againBtn.textContent = isLive ? 'Open live call' : `Call ${name || ''} again`.trim();
    againBtn.disabled = false;
    againBtn.onclick = callAgainFromDetail;
  }
  setCallAgainStatus('', false);
  $('callDetailDialog').showModal();
  loadCallDetailHistory(c);
}

let recentSubTab = 'calls';
let recentChatSessions = [];
let recentChatMenuTargetId = null;

document.querySelectorAll('.recentSubTabBtn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.recentSubTabBtn').forEach((b) => { b.classList.remove('active'); b.setAttribute('aria-pressed', 'false'); });
    btn.setAttribute('aria-pressed', 'true');
    btn.classList.add('active');
    recentSubTab = btn.dataset.subtab;
    $('recentChatsList').classList.toggle('hidden', recentSubTab !== 'chats');
    $('callsList').classList.toggle('hidden', recentSubTab !== 'calls');
    $('recentSearch').value = '';
    renderRecentChatsList(recentChatSessions);
    renderCallsList(lastLoadedCalls);
    $('recentSearch').placeholder = recentSubTab === 'chats' ? 'Search chats' : 'Search conversations';
  });
});

async function loadRecentChats() {
  const resp = await authedFetch('/api/assistant?action=sessions&callRelated=true').catch(() => null);
  if (!resp?.ok) { $('recentChatsList').textContent = 'Could not load call chats. Tap Recent to retry.'; return; }
  const { sessions } = await resp.json();
  recentChatSessions = sessions || [];
  renderRecentChatsList(recentChatSessions);
}

function renderRecentChatsList(sessions) {
  const list = $('recentChatsList');
  list.innerHTML = '';
  if (!sessions?.length) {
    list.innerHTML = `<div class="authHint" style="text-align:left;">No call chats yet — prepare a call from Contacts or call Emysa.</div>`;
    return;
  }
  for (const s of sessions) {
    const row = document.createElement('div');
    row.className = 'savedChatRow';
    row.innerHTML = `
      <div class="recentBody"><div class="savedChatTitle">${escapeHtml(s.title)}</div>${s.call_label ? `<div class="recentPreview">${escapeHtml(s.call_label)} · ${s.call_id ? 'Call conversation' : 'Call setup'}</div>` : ''}</div>
      <div class="chatRowActions">
        <div class="savedChatDate">${shortDateLabel(s.updated_at)}</div>
        <button class="recentChatKebabBtn" aria-label="More"><svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="12" cy="19" r="1.8"/></svg></button>
      </div>`;
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    row.addEventListener('keydown', (e) => { if (e.target === row && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); row.click(); } });
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
  const resp = await authedFetch('/api/calls?action=list').catch(() => null);
  if (!resp?.ok) { $('callsList').textContent = 'Could not load calls. Tap Recent to retry.'; return; }
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
$('contactsBtn').addEventListener('click', () => { closeSheets(); document.querySelector('[data-tab=contacts]').click(); });
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
let selectedMemoryType = '';
const MEMORY_TYPE_LABEL = {
  semantic: 'Fact',
  episodic: 'Episode',
  emotional: 'Relationship',
  working: 'Working',
};

async function loadMemories() {
  const qs = selectedMemoryType ? `?type=${encodeURIComponent(selectedMemoryType)}` : '';
  const resp = await authedFetch(`/api/memories${qs}`);
  const list = $('memoriesList');
  list.textContent = '';
  if (!resp.ok) return;
  const { memories, emotionState } = await resp.json();

  const moodBanner = $('memoryMoodBanner');
  if (moodBanner) {
    if (emotionState?.mood?.label) {
      moodBanner.classList.remove('hidden');
      moodBanner.textContent = '';
      const labelSpan = document.createElement('span');
      labelSpan.textContent = "Emysa's current state:";
      const moodStrong = document.createElement('strong');
      moodStrong.textContent = emotionState.mood.label.replace(/-/g, ' ');
      moodBanner.append(labelSpan, moodStrong);
    } else {
      moodBanner.classList.add('hidden');
    }
  }

  $('memoriesClearAllBtn')?.classList.toggle('hidden', !memories?.length);

  if (!memories?.length) {
    list.innerHTML = `<div class="emptyState"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 21s-7-4.35-9.5-8.5C.7 9 2 5.5 5.5 4.7 8 4.1 10 5.3 12 7.5c2-2.2 4-3.4 6.5-2.8C22 5.5 23.3 9 21.5 12.5 19 16.65 12 21 12 21z"/></svg><div>Nothing in this view yet — add a fact above or talk with Emysa and useful details will show up here.</div></div>`;
    return;
  }
  for (const m of memories) {
    const el = document.createElement('div');
    el.className = 'memoryCard';
    const date = m.created_at ? new Date(m.created_at).toLocaleDateString([], { month: 'short', day: 'numeric' }) : '';
    const metaRow = document.createElement('div');
    metaRow.className = 'memoryMetaRow';
    const badge = document.createElement('span');
    const memType = m.memory_type || 'semantic';
    badge.className = 'memoryTypeBadge';
    badge.dataset.type = memType;
    badge.textContent = MEMORY_TYPE_LABEL[memType] || 'Fact';
    metaRow.appendChild(badge);
    if (m.contactName) {
      const contactEl = document.createElement('div');
      contactEl.className = 'memoryContact';
      contactEl.textContent = m.contactName;
      metaRow.appendChild(contactEl);
    }
    const contentEl = document.createElement('div');
    contentEl.className = 'memoryContent';
    contentEl.textContent = m.content || '';
    const dateEl = document.createElement('div');
    dateEl.className = 'memoryDate';
    dateEl.textContent = date;

    const actions = document.createElement('div');
    actions.className = 'memoryCardActions';
    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'memoryEditBtn';
    editBtn.setAttribute('aria-label', 'Edit memory');
    editBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" width="15" height="15"><path d="M4 20h4l10.5-10.5a2 2 0 0 0 0-2.83l-1.17-1.17a2 2 0 0 0-2.83 0L4 16v4z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>`;
    editBtn.addEventListener('click', async () => {
      const updated = prompt('Edit memory:', m.content || '');
      if (!updated || !updated.trim() || updated.trim() === m.content) return;
      const r = await authedFetch('/api/memories', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: m.id, content: updated.trim() }),
      });
      if (r.ok) loadMemories();
    });

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'memoryDelete';
    delBtn.setAttribute('aria-label', 'Delete');
    delBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    delBtn.addEventListener('click', async () => {
      await authedFetch('/api/memories', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: m.id }) });
      loadMemories();
    });
    actions.append(editBtn, delBtn);
    el.append(metaRow, contentEl, dateEl, actions);
    list.appendChild(el);
  }
}

document.querySelectorAll('#memoryFilterRow .memoryFilterBtn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#memoryFilterRow .memoryFilterBtn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    selectedMemoryType = btn.dataset.memoryType || '';
    loadMemories();
  });
});

$('memoryAddForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('memoryAddInput');
  const typeSel = $('memoryAddType');
  const statusEl = $('memoryAddStatus');
  const content = input?.value?.trim();
  if (!content) return;
  $('memoryAddBtn').disabled = true;
  if (statusEl) statusEl.textContent = 'Saving…';
  try {
    const resp = await authedFetch('/api/memories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, memoryType: typeSel?.value || 'semantic' }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      if (statusEl) statusEl.textContent = data.error || 'Could not save memory.';
      return;
    }
    input.value = '';
    if (statusEl) statusEl.textContent = '';
    await loadMemories();
  } finally {
    $('memoryAddBtn').disabled = false;
  }
});

$('memoriesClearAllBtn')?.addEventListener('click', async () => {
  if (!confirm('Clear all saved memories? This cannot be undone.')) return;
  await authedFetch('/api/memories?clearAll=true', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clearAll: true }),
  });
  loadMemories();
});

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
}
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
