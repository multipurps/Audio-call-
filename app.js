import { normalizePhone } from './lib/phoneNumbers.js';
import { decodeMonitorFrame } from './lib/monitorFrame.js';
import { floatToPcm16k, decodeAppCallFrame, describeAppCallMessage, describeAppCallClose, describeMicError } from './lib/appCallAudio.js';
import { primeAudioSession, createCallOutput, watchLifecycle, pickOutputMode, micNeedsRestart } from './lib/appCallOutput.js';
import { describeMonitorMessage, describeMonitorClose, noAudioMessage, MONITOR_NO_AUDIO_MS } from './lib/monitorStatus.js';
import { answeredCallPill, assistantCallPill, listenInPill, liveCallView, endedCallLabel, formatCallTimer, TERMINAL_STATUSES } from './lib/callStatus.js';
import { userError, friendlyAccountName } from './lib/userFacing.js';
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
// Home / Chat / Recent / Profile are the bottom tabs. Contacts is a screen
// reached from Home (People > See all, More, Call someone) and from Profile; it
// keeps Home highlighted in the nav since it is a child of Home.
function showTab(name) {
  const navTab = name === 'contacts' ? 'home' : name;
  document.querySelectorAll('.tabBtn').forEach((b) => {
    const on = b.dataset.tab === navTab;
    b.classList.toggle('active', on);
    if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active', 'fadeIn'));
  $(`screen-${name}`).classList.add('active', 'fadeIn');
  if (name === 'contacts') { loadContacts(); renderMyCard(); }
  $('homeInputBar').classList.toggle('visible', name === 'chat');
  if (name === 'recent') { loadRecentChats(); loadCalls(); }
  if (name === 'profile') renderProfileHeader();
  if (name === 'home') loadHome();
  if (name === 'chat') startMessagePolling(); else stopMessagePolling();
}
document.querySelectorAll('.tabBtn').forEach((btn) => btn.addEventListener('click', () => showTab(btn.dataset.tab)));


// ---------- auth ----------
const authScreen = $('authScreen');
// The one way to show the auth/setup screen: also ends the plain-splash "booting" state
// (see #authScreen.booting in styles.css) so the wallpaper only shows on real login screens.
function revealAuthScreen() {
  authScreen.classList.remove('booting');
  authScreen.classList.remove('hidden');
}
const ONBOARD_KEY = 'emysa_seen_onboarding';

function showAuthPanel(name) {
  document.querySelectorAll('.authPanel').forEach((p) => p.classList.remove('active'));
  $(`panel${name}`).classList.add('active');
}

function startAuthFlow() {
  const firstTime = !localStorage.getItem(ONBOARD_KEY);
  showAuthPanel(firstTime ? 'GetStarted' : 'Login');
  if (firstTime && !introStarted) {
    introStarted = true;
    import('./intro.js').then(({ introAlreadySeen, playIntro }) => {
      const panel = $('panelGetStarted');
      if (introAlreadySeen()) { panel.classList.add('introDone'); return; }
      panel.classList.add('introPlaying');
      playIntro({ panel, onDone: () => { panel.classList.remove('introPlaying'); panel.classList.add('introDone'); } });
    }).catch(() => $('panelGetStarted').classList.add('introDone'));
  }
}
let introStarted = false;

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

// The server tells the app which VAPID public key it signs with, so the
// subscription can never be made for a key the server does not have.
async function fetchServerPushKey() {
  try {
    const resp = await authedFetch('/api/assistant?action=pushKey');
    const data = await resp.json().catch(() => ({}));
    return resp.ok && data?.publicKey ? String(data.publicKey) : null;
  } catch {
    return null;
  }
}

function subscriptionUsesKey(sub, key) {
  try {
    const have = sub?.options?.applicationServerKey;
    if (!have) return true; // cannot tell; keep it
    const a = new Uint8Array(have);
    const b = urlBase64ToUint8Array(key);
    return a.length === b.length && a.every((v, i) => v === b[i]);
  } catch {
    return true;
  }
}

const NEEDS_TAP_FOR_PERMISSION = /iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

// Makes sure THIS device has a push subscription that matches the server's key
// and is saved under the signed-in account. Safe to call on every app open:
// once permission is granted it never prompts, it only repairs what is missing.
// iOS only allows the permission prompt from a tap, so pass fromTap from a
// button handler. Returns true when the device is registered.
async function ensureNotificationsEnabled({ fromTap = false } = {}) {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return false;
  try {
    if (Notification.permission === 'denied') return false;
    if (Notification.permission !== 'granted') {
      if (!fromTap && NEEDS_TAP_FOR_PERMISSION) return false;
      if ((await Notification.requestPermission()) !== 'granted') return false;
    }
    const reg = await navigator.serviceWorker.ready;
    const key = (await fetchServerPushKey()) || VAPID_PUBLIC_KEY;
    let sub = await reg.pushManager.getSubscription();
    if (sub && !subscriptionUsesKey(sub, key)) {
      await sub.unsubscribe().catch(() => {});
      sub = null;
    }
    if (!sub) {
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(key) });
    }
    // Always save: the row is keyed by endpoint, so this also moves a device that
    // was subscribed under another account over to the current one.
    const resp = await authedFetch('/api/assistant?action=savePushSubscription', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscription: sub.toJSON() }),
    });
    return resp.ok;
  } catch (err) {
    console.error('ensureNotificationsEnabled failed:', err);
    return false;
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
    revealAuthScreen();
    $('pendingBox').style.display = 'block';
    startPendingPoll();
    return;
  }
  stopPendingPoll();
  // First-run setup: a calling line (required), then name/language/country.
  const step = await onboardingStep();
  if (step) { showOnboardingStep(step); return; }
  $('pendingBox').style.display = 'none';
  authScreen.classList.add('hidden');
  ensureNotificationsEnabled();
  renderProfileHeader();
  initHomeChat();
  // Quiet preload so beginPreCall() can find an existing per-contact thread
  // to continue even if the person hasn't opened Recent yet this session.
  loadRecentChats();

  redeemPendingReferral();
  loadHome(true);
  loadNavAvatar();
  resumePaymentCheck();
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

// The Profile tab shows the profile picture inside a ring while it is active.
function setNavAvatar(url) {
  const ring = document.querySelector('.tabBtn[data-tab="profile"] .tabAvatarRing');
  if (!ring) return;
  ring.querySelector('img')?.remove();
  ring.classList.toggle('hasPhoto', Boolean(url));
  if (url) ring.appendChild(createSafeAvatarImg(url));
}

async function loadNavAvatar() {
  if (!currentUser) return;
  const { data } = await supabase.from('profiles').select('avatar_url').eq('user_id', currentUser.id).maybeSingle();
  renderAvatar(data?.avatar_url || null);
}

function renderAvatar(url) {
  userAvatarUrl = url || null;
  setNavAvatar(url);
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
    homeChatInitializedFor = null;
    stopMessagePolling();
    $('authBoot').style.display = 'none';
    $('pendingBox').style.display = 'none';
    revealAuthScreen();
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
      revealAuthScreen();
      startAuthFlow();
    }
  })
  .catch((err) => {
    console.error('getSession failed:', err);
    $('authBoot').style.display = 'none';
    revealAuthScreen();
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

// index.html already pinged the sleeping backends the moment the page opened.
// Ping again (throttled inside __warmBackends) when the app returns to the
// foreground after being backgrounded, since they may have gone back to sleep.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') window.__warmBackends?.();
});

let homeChatInitializedFor = null;
async function initHomeChat() {
  if (!currentUser) return;
  // Supabase re-fires sign-in on every token refresh and whenever the app comes
  // back to the foreground. Resetting here threw away the open chat and showed
  // a blank new one each time. Start fresh only once per sign-in; new chats are
  // opened manually with the pencil button.
  if (homeChatInitializedFor === currentUser.id) return;
  homeChatInitializedFor = currentUser.id;
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
  recoverCallSummaries();
}

// Finished calls that never got their summary are filled in on the server
// whenever the app opens or returns to the foreground (at most every 2 minutes).
let lastSummaryRecoveryAt = 0;
async function recoverCallSummaries() {
  if (!currentUser || Date.now() - lastSummaryRecoveryAt < 120_000) return;
  lastSummaryRecoveryAt = Date.now();
  try {
    const resp = await authedFetch('/api/calls?action=recover-summaries', { method: 'POST' });
    const out = await resp.json().catch(() => ({}));
    if (out?.recovered > 0 && currentChatSessionId) await openChatSession(currentChatSessionId);
  } catch {}
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') recoverCallSummaries(); });

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

// Long-press-to-copy, since the browser's own text-selection "Copy" works
// inconsistently across mobile browsers for short tap targets like a chat
// bubble. Mirrors makeSwipeDelete's pattern: a held pointerdown fires the
// action and swallows the click that would otherwise follow it.
function attachLongPressCopy(el, getText) {
  let timer = null;
  let longPressed = false;
  el.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    longPressed = false;
    clearTimeout(timer);
    timer = setTimeout(async () => {
      longPressed = true;
      try {
        await navigator.clipboard.writeText(getText());
        showToast('Copied');
      } catch {
        showToast('Could not copy');
      }
    }, 500);
  });
  const cancel = () => clearTimeout(timer);
  el.addEventListener('pointerup', cancel);
  el.addEventListener('pointermove', cancel);
  el.addEventListener('pointerleave', cancel);
  el.addEventListener('pointercancel', cancel);
  el.addEventListener('contextmenu', (e) => e.preventDefault());
  el.addEventListener('click', (e) => { if (longPressed) { e.stopImmediatePropagation(); e.preventDefault(); longPressed = false; } }, true);
}
function showToast(text) {
  let toast = $('miniToast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'miniToast';
    toast.className = 'miniToast';
    document.body.appendChild(toast);
  }
  toast.textContent = text;
  toast.classList.remove('show');
  void toast.offsetWidth;
  toast.classList.add('show');
  clearTimeout(toast._hideTimer);
  toast._hideTimer = setTimeout(() => toast.classList.remove('show'), 1400);
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
  attachLongPressCopy(el, () => m.content);
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
      if (TERMINAL_STATUSES.includes(payload.new.status)) clearActiveCall();
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
  // A crashed or timed-out function returns plain text/HTML, and Safari's
  // resp.json() then throws "The string did not match the expected pattern".
  // Say what actually happened instead.
  const data = await resp.json().catch(() => ({
    error: resp.status >= 500 ? `The server had a problem (error ${resp.status}). Please try again.` : 'Unexpected response from the server.',
  }));
  if (revision !== chatRevision) return;
  if (!resp.ok) {
    const errText = data.error || 'Something went wrong.';
    if (onReply) { await onReply(errText, null); return; }
    throw new Error(errText);
  }
  await handleChatResponse(data, isCall, onReply);
  // A call request is answered in two steps: first the natural reply (rendered just
  // above), and only then does the app ask the server to place the call. The call is
  // never placed before the user has been told what is about to happen.
  if (data.pendingCall?.token) await placePendingCall(data.pendingCall.token, revision, onReply);
}

// Shows what the server answered: switches chat if the person already has one, starts
// tracking a live call, keeps the line picker in step, and renders the replies.
async function handleChatResponse(data, isCall, onReply) {
  const switchedChat = data.sessionSwitched && data.sessionId && data.sessionId !== currentChatSessionId;
  if (data.sessionId) currentChatSessionId = data.sessionId;
  if (switchedChat && !isCall) {
    // This person already has a conversation: show it (with this turn folded in)
    // instead of leaving the user in a one-message chat.
    await openChatSession(data.sessionId);
    if (data.callId && data.toNumber) {
      trackActiveCall(data.callId, data.toNumber, data.contactName);
      clearPreCallContext();
      openCallScreen(data.callId, data.toNumber, data.contactName);
    }
    if (onReply) await onReply('', data);
    return;
  }
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

// Phase two of a call request. Waits a beat so the reply has visibly landed, then asks
// the server to place the call it resolved in phase one. Runs even if the user has
// navigated away (the request was theirs), but only draws into the chat they are in.
async function placePendingCall(token, revision, onReply) {
  await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 700)));
  let data;
  let ok = false;
  try {
    const resp = await authedFetch('/api/assistant?action=send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pendingCallToken: token, sessionId: currentChatSessionId }),
    });
    ok = resp.ok;
    data = await resp.json().catch(() => ({ error: resp.status >= 500 ? `The server had a problem (error ${resp.status}).` : 'Unexpected response from the server.' }));
  } catch {
    data = { error: 'Could not reach the server to place the call. Check your connection and ask me again.' };
  }
  if (!ok) {
    if (revision === chatRevision) {
      appendChatBubble({ id: `local-err-${Date.now()}`, role: 'assistant', content: data?.error || 'I could not place the call.', created_at: new Date().toISOString() });
      scrollHomeChatToBottom();
    }
    return;
  }
  if (revision !== chatRevision) {
    // Still start tracking the live call so the header ring and call screen work.
    if (data.callId && data.toNumber) trackActiveCall(data.callId, data.toNumber, data.contactName);
    return;
  }
  await handleChatResponse(data, false, onReply);
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

let assistantCallOpen = false;
let callTranscriptForSummary = [];

let assistantListening = false;
let assistantMuted = false;
let assistantSpeaking = false;

function setCallStatePill(phase, label) {
  const pill = $('callStatePill');
  if (!pill) return;
  pill.hidden = false;
  pill.dataset.phase = phase || 'connecting';
  pill.textContent = label || 'Connecting…';
}

// A healthy call shows no pill (the timer and waveform already say it is live).
// `view` comes from lib/callStatus.js: { phase, label } or null.
function applyCallPill(view) {
  if (view) { setCallStatePill(view.phase, view.label); return; }
  const pill = $('callStatePill');
  if (pill) { pill.hidden = true; pill.textContent = ''; }
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
// A standard US phone ring is two tones (440Hz + 480Hz) together. There's no
// bundled ringtone asset, so this synthesizes one short ring cycle directly
// on the call's own AudioContext rather than depending on an external file.
function playRingTone(ctx, durationMs = 1800) {
  return new Promise((resolve) => {
    const gain = ctx.createGain();
    gain.gain.value = 0.18;
    gain.connect(ctx.destination);
    const oscA = ctx.createOscillator();
    const oscB = ctx.createOscillator();
    oscA.frequency.value = 440;
    oscB.frequency.value = 480;
    oscA.connect(gain);
    oscB.connect(gain);
    oscA.start();
    oscB.start();
    setTimeout(() => {
      oscA.stop(); oscB.stop();
      resolve();
    }, durationMs);
  });
}
function base64ToArrayBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}
const AUDIO_BTN_HTML = '<div class="callBtnCircle"><svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M16 9C16.5 9.5 17 10.5 17 12C17 13.5 16.5 14.5 16 15M19 6C20.5 7.5 21 10 21 12C21 14 20.5 16.5 19 18M13 3L7 8H5C3.89543 8 3 8.89543 3 10V14C3 15.1046 3.89543 16 5 16H7L13 21V3Z" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></div>\n          Speaker';
const MORE_BTN_HTML = '<div class="callBtnCircle"><svg viewBox="0 0 24 24" fill="none"><circle cx="5" cy="12" r="2" fill="currentColor"/><circle cx="12" cy="12" r="2" fill="currentColor"/><circle cx="19" cy="12" r="2" fill="currentColor"/></svg></div>\n          More';
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
      // Shown as text only: the live GPT-Live session owns the voice for the whole call.
    }
  } catch (err) {
    console.error('sendCallPhoto failed:', err);
    if (assistantCallOpen) appendCallTranscriptLine('ai', "Sorry, something went wrong sending that.");
  }
}

function minimizeCallScreenToChat() {
  stopRingback();
  $('callScreen').classList.add('hidden');
  if (assistantCallOpen || activeCallScreenId) {
    $('homeHeaderLogoWrap').classList.remove('hidden');
    $('homeHeaderLogoWrap').classList.add('calling');
  }
}

function endAssistantCall() {
  stopAppCallSession({ hangUp: true });
  assistantCallOpen = false;
  clearInterval(callTimerInterval);
  $('callScreen').classList.add('hidden');
  $('callScreen').classList.remove('assistantMode');
  $('callContactAvatar').style.display = '';
  if (!activeHeaderCall) $('homeHeaderLogoWrap').classList.remove('calling');
  callTranscriptForSummary = [];
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
  setCallStatePill('connecting', 'Connecting…');
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
    applyCallPill(assistantCallPill({ muted: assistantMuted }));
    if (appCall) appCall.muted = assistantMuted;
  };
  $('callKeypadBtn').onclick = () => {
    $('dialStatus').textContent = '';
    updateDialMatch();
    $('keypadDialog').showModal();
  };
  $('waveRow').onclick = null; // the mic is always open during a live call

  // A real live session: the mic stays open and Emysa answers in her own voice
  // as the model generates it (GPT-Live, unless the cloned voice is chosen).
  startAppCallSession();
}

// ---- In-app Emysa live call ------------------------------------------------
// One continuous GPT-Live session over a websocket to the assistant service:
// the microphone streams up the whole call, Emysa's voice streams back as the
// model generates it, and either side can interrupt. Which engine and voice is
// used is decided by the service from the user's saved choice (GPT-Live always,
// except when the cloned voice is selected). The transcript is read from the
// call row as the service writes it, so it stays visible while you talk.
let appCall = null;

function stopAppCallSession({ hangUp = false } = {}) {
  const call = appCall;
  appCall = null;
  if (!call) return;
  clearInterval(call.transcriptTimer);
  // The call was a briefing: once the service has saved the transcript, turn it
  // into a call plan in chat (which the user still has to confirm).
  if (call.briefable && call.callId) setTimeout(() => submitAppCallBrief(call.callId), 1800);
  try { if (hangUp && call.ws?.readyState === WebSocket.OPEN) call.ws.send(JSON.stringify({ type: 'hangup' })); } catch {}
  const closeSoon = () => { try { call.ws?.close(); } catch {} };
  if (hangUp) setTimeout(closeSoon, 300); else closeSoon();
  try { call.stream?.getTracks().forEach((t) => t.stop()); } catch {}
  try { call.micNode?.disconnect(); call.source?.disconnect(); } catch {}
  for (const src of call.sources || []) { try { src.stop(); } catch {} }
  try { call.unwatch?.(); call.output?.dispose(); } catch {}
  $('waveRow')?.classList.remove('speaking');
}

function finishAppCallUi(text, { close = false } = {}) {
  stopAppCallSession();
  setCallStatePill('connecting', text);
  if (close) setTimeout(() => { if (assistantCallOpen) endAssistantCall(); }, 1200);
}

// After a briefing call: ask the server to turn what the user said into a
// pending call plan. Nothing is dialed; the plan waits in chat for Call Now.
async function submitAppCallBrief(callId, attempt = 0) {
  try {
    const resp = await authedFetch('/api/calls?action=app-call-brief', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callId }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) { showToast(userError(data?.error, 'Could not prepare the call from your briefing')); return; }
    if (data.status === 'nothing-to-do' && attempt < 2) { setTimeout(() => submitAppCallBrief(callId, attempt + 1), 2500); return; }
    if (data.status === 'prepared' && data.sessionId) {
      showToast(`Call to ${data.contactName || 'your contact'} is ready. Review it and tap Call Now`);
      await openChatSession(data.sessionId);
    } else if (data.status === 'needs-contact') {
      showToast(data.contactName ? `I could not tell which contact "${data.contactName}" is. Tell me who to call` : 'Tell me who to call');
    }
  } catch {
    showToast('Could not prepare the call from your briefing');
  }
}

async function startAppCallSession() {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx || !navigator.mediaDevices?.getUserMedia || !window.WebSocket) {
    setCallStatePill('connecting', 'This device cannot do live voice calls');
    return;
  }
  setCallStatePill('connecting', 'Connecting…');
  // Everything here runs inside the tap gesture: iOS refuses audio otherwise.
  // 1) Tell WebKit this page is a call BEFORE the mic opens.
  // 2) Reply audio is rendered as a MediaStream track (see lib/appCallOutput.js),
  //    never through ctx.destination, so iOS keeps it at call volume while the
  //    mic is live. The element is started now so the tap unlocks it.
  const audioDebug = (...a) => { try { if (localStorage.getItem('emysaAudioDebug')) console.log('[call-audio]', ...a); } catch {} };
  const session = primeAudioSession(navigator);
  const ctx = getAssistantAudioCtx();
  const output = createCallOutput({ ctx, doc: document, nav: navigator, mode: pickOutputMode(localStorage), log: audioDebug });
  void output.start('tap');
  audioDebug('start', { mode: output.mode, sessionType: session.type, ctx: ctx.state, rate: ctx.sampleRate });

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
  } catch (err) {
    output.dispose();
    finishAppCallUi(describeMicError(err));
    return;
  }
  if (!assistantCallOpen) { stream.getTracks().forEach((t) => t.stop()); output.dispose(); return; }

  let started;
  try {
    const resp = await authedFetch('/api/calls?action=app-call-start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: currentChatSessionId }),
    });
    started = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      stream.getTracks().forEach((t) => t.stop());
      output.dispose();
      finishAppCallUi(started?.error || 'Could not start the call');
      return;
    }
  } catch {
    stream.getTracks().forEach((t) => t.stop());
    output.dispose();
    finishAppCallUi('Could not reach the app server to start the call. Check your connection');
    return;
  }
  if (!assistantCallOpen) { stream.getTracks().forEach((t) => t.stop()); output.dispose(); return; }

  let ws;
  try {
    ws = new WebSocket(started.url);
  } catch {
    stream.getTracks().forEach((t) => t.stop());
    output.dispose();
    console.error('[call] PUBLIC_ASSISTANT_WS_URL is not a valid wss:// address');
    finishAppCallUi('The call couldn\u2019t start. Try again later');
    return;
  }
  ws.binaryType = 'arraybuffer';

  const out = output.input; // reply audio is mixed here; never connected to ctx.destination in stream mode
  const call = {
    ws, stream, ctx, out, output, callId: started.callId, opened: false, explained: false, ended: false,
    muted: assistantMuted, sources: new Set(), nextTime: 0, renderedLines: 0, transcriptTimer: null,
    source: null, micNode: null, pending: [], pendingSamples: 0,
  };
  appCall = call;
  const JITTER = 0.06;
  const MAX_LAG = 1.2;

  // -- microphone -> service ------------------------------------------------
  const sendPcm = (floats) => {
    if (call.muted || ws.readyState !== WebSocket.OPEN) return;
    const pcm = floatToPcm16k(floats, ctx.sampleRate);
    if (pcm.length) ws.send(pcm.buffer);
  };
  call.source = ctx.createMediaStreamSource(stream);
  const startMic = async () => {
    try {
      if (!ctx.audioWorklet) throw new Error('no worklet');
      const code = "class P extends AudioWorkletProcessor{process(i){const c=i[0]&&i[0][0];if(c)this.port.postMessage(c.slice(0));return true}}registerProcessor('mic-tap',P)";
      const url = URL.createObjectURL(new Blob([code], { type: 'application/javascript' }));
      await ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      const node = new AudioWorkletNode(ctx, 'mic-tap');
      let acc = [];
      let n = 0;
      const need = Math.round(ctx.sampleRate * 0.02);
      node.port.onmessage = (e) => {
        acc.push(e.data); n += e.data.length;
        if (n >= need) {
          const merged = new Float32Array(n);
          let o = 0; for (const c of acc) { merged.set(c, o); o += c.length; }
          acc = []; n = 0;
          sendPcm(merged);
        }
      };
      call.source.connect(node);
      // Keeps the tap pulled by the graph without any audible output (and
      // without opening the Web Audio output unit).
      output.silentSink(node);
      call.micNode = node;
    } catch {
      // Older Safari: ScriptProcessor still works.
      const node = ctx.createScriptProcessor(1024, 1, 1);
      node.onaudioprocess = (e) => sendPcm(new Float32Array(e.inputBuffer.getChannelData(0)));
      call.source.connect(node);
      output.silentSink(node);
      call.micNode = node;
    }
  };

  // -- screen lock / app switch -------------------------------------------------
  // iOS interrupts the audio session on lock. Bring the output back (and the mic,
  // if the OS ended it) when the page returns; the call itself is untouched.
  const reacquireMic = async () => {
    try {
      const fresh = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      });
      if (appCall !== call) { fresh.getTracks().forEach((t) => t.stop()); return; }
      try { call.source?.disconnect(); } catch {}
      call.stream = fresh;
      call.source = ctx.createMediaStreamSource(fresh);
      if (call.micNode) call.source.connect(call.micNode);
      audioDebug('mic reacquired');
    } catch (err) {
      audioDebug('mic reacquire failed', err?.name);
    }
  };
  call.unwatch = watchLifecycle({
    doc: document, win: window, ctx, output,
    onRecovered: (reason, r) => {
      audioDebug('recovered', reason, r);
      if (appCall === call && micNeedsRestart(call.stream)) void reacquireMic();
    },
  });

  // -- service -> speaker (gapless, interruptible) ----------------------------
  const play = (frame) => {
    const { rate, samples } = frame;
    const audio = ctx.createBuffer(1, samples.length, rate);
    const ch = audio.getChannelData(0);
    for (let i = 0; i < samples.length; i++) ch[i] = samples[i] / 32768;
    const src = ctx.createBufferSource();
    src.buffer = audio;
    src.connect(out);
    const now = ctx.currentTime;
    if (!call.nextTime || call.nextTime < now) call.nextTime = now + (call.nextTime ? 0.03 : JITTER);
    if (call.nextTime > now + MAX_LAG) return;
    src.start(call.nextTime);
    call.nextTime += audio.duration;
    call.sources.add(src);
    $('waveRow')?.classList.add('speaking');
    src.onended = () => {
      call.sources.delete(src);
      if (!call.sources.size && appCall === call) {
        $('waveRow')?.classList.remove('speaking');
      }
    };
  };
  const clearPlayback = () => {
    for (const src of call.sources) { try { src.stop(); } catch {} }
    call.sources.clear();
    call.nextTime = 0;
    $('waveRow')?.classList.remove('speaking');
  };

  // -- transcript from the call row -------------------------------------------
  const pollTranscript = async () => {
    if (appCall !== call || !call.callId) return;
    try {
      const { data } = await supabase.from('calls').select('transcript').eq('id', call.callId).maybeSingle();
      const lines = Array.isArray(data?.transcript) ? data.transcript : [];
      for (; call.renderedLines < lines.length; call.renderedLines++) {
        const line = lines[call.renderedLines];
        const text = line?.content || line?.text || '';
        if (text) appendCallTranscriptLine(line?.speaker || line?.role, text);
      }
    } catch {}
  };

  ws.onopen = () => { call.opened = true; };
  ws.onmessage = (event) => {
    if (appCall !== call) return;
    if (typeof event.data === 'string') {
      let msg = null;
      try { msg = JSON.parse(event.data); } catch {}
      if (msg?.type === 'interrupt') { clearPlayback(); return; }
      const info = describeAppCallMessage(msg);
      if (!info) return;
      if (info.kind === 'error') { console.warn('[call] service error', msg); call.explained = true; finishAppCallUi(info.text); return; }
      if (info.kind === 'ended') { call.ended = true; finishAppCallUi('Call ended', { close: true }); return; }
      if (msg.type === 'ready') {
        call.opened = true;
        call.briefable = true;
        startMic();
        applyCallPill(assistantCallPill({ muted: assistantMuted }));
        call.transcriptTimer = setInterval(pollTranscript, 1200);
      }
      return;
    }
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    const frame = decodeAppCallFrame(event.data);
    if (frame) play(frame);
  };
  const onGone = (event) => {
    if (appCall !== call) return;
    const text = describeAppCallClose({ opened: call.opened, code: event?.code, explained: call.explained, ended: call.ended });
    if (text) console.warn('[call] socket closed', { opened: call.opened, code: event?.code });
    if (text) finishAppCallUi(text);
    else stopAppCallSession();
  };
  ws.onclose = onGone;
  ws.onerror = onGone;
}


// ---------- Call channel: Emysa (voice) / WhatsApp / Telegram / Phone ----------
const CALL_CHANNEL_KEY = 'emysa.callChannel';
let selectedCallChannel = null; // null = not chosen: the server uses the only line the user has, or asks
// Telegram linking is back: login goes through mp-relay and the app now records the
// connection itself (api/social-calling.js saveTelegramAccount).
const TELEGRAM_ENABLED = true;
try {
  const saved = localStorage.getItem(CALL_CHANNEL_KEY);
  if (saved === 'phone' || saved === 'whatsapp' || (saved === 'telegram' && TELEGRAM_ENABLED)) selectedCallChannel = saved;
} catch {}
// null when the user has not picked a line. The server never guesses between
// two real lines and never uses one the user does not have.
function currentCallChannel() { return selectedCallChannel; }

const CHANNEL_META = {
  whatsapp: { label: 'WhatsApp', placeholder: 'Paste a number to call on WhatsApp…' },
  telegram: { label: 'Telegram', placeholder: 'Paste a number to call on Telegram…' },
  phone: { label: null, placeholder: 'Message' },
};

function setCallChannel(channel, { focus = true } = {}) {
  selectedCallChannel = channel || null;
  try { localStorage.setItem(CALL_CHANNEL_KEY, selectedCallChannel || ''); } catch {}
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
    if (channel === 'setup') { openLineSetup(); return; }
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
const PHONE_ICON = '<svg class="phoneIc" viewBox="0 0 24 24"><use href="#ic-phone"/></svg>';
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
  const history = document.createElement('button');
  history.className = 'contactHistoryBtn';
  history.setAttribute('aria-label', `WhatsApp history for ${c.name}`);
  history.innerHTML = '<svg class="ic"><use href="#ic-history"/></svg>';
  history.onclick = (e) => { e.stopPropagation(); openContactMemory(c); };
  el.append(name, history, call, del);
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
$('myCardRow').addEventListener('click', () => showTab('profile'));
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
  if (!response.ok) throw new Error(userError(data.error, 'Request failed. Please try again.'));
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
  // One conversation per person is enforced server-side now (peer_key,
  // resolvePersonSession) — it folds whatever chat this call started from
  // into that person's canonical session and tells the client to switch
  // (sendChatMessage's sessionSwitched handling), matched by phone number
  // rather than this client's guess at contact_id/label. No need to
  // pre-emptively switch chats here anymore.
  showPreCallContext(target, channel);
  showTab('chat');
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
// Ring vs talk time: the conversation timer runs from the ACTUAL answer
// (calls.answered_at, written when the provider reports the answer event).
// Until then the timer shows ring time — never a fabricated conversation.
let callPlacedAtMs = null;
let callAnsweredAtMs = null;

// The timer is only ever visible for an ANSWERED call. While dialing or ringing it
// is hidden (not "00:00"); the moment the provider reports the answer it appears
// and starts counting - ensureCallTimer() renders immediately, no 1s wait.
function renderCallTimer() {
  const el = $('callTimer');
  if (!el) return;
  const text = formatCallTimer(callAnsweredAtMs);
  el.classList.toggle('pending', text === null);
  el.setAttribute('aria-hidden', text === null ? 'true' : 'false');
  el.textContent = text ?? '\u00a0'; // keeps the header height steady while hidden
}

function ensureCallTimer() {
  clearInterval(callTimerInterval);
  callTimerInterval = setInterval(renderCallTimer, 1000);
  renderCallTimer();
}

// -- Local call tones ------------------------------------------------------
// WhatsApp's own ringing plays on the recipient's phone and is not sent to
// us, so the caller side would otherwise be silent. This is a locally
// synthesised ringback (clearly a UI cue, not provider audio) that plays only
// while the real status is 'ringing', plus a short chime on the real answer.
let callToneCtx = null;
let ringbackTimer = null;
let ringbackActive = false;

function getCallToneCtx() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    if (!callToneCtx || callToneCtx.state === 'closed') callToneCtx = new Ctx();
    if (callToneCtx.state === 'suspended') callToneCtx.resume().catch(() => {});
    return callToneCtx;
  } catch {
    return null;
  }
}

function playToneBurst(freqs, durMs, gain = 0.06) {
  const ctx = getCallToneCtx();
  if (!ctx || ctx.state !== 'running') return;
  const t0 = ctx.currentTime;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(gain, t0 + 0.03);
  g.gain.setValueAtTime(gain, t0 + durMs / 1000 - 0.05);
  g.gain.linearRampToValueAtTime(0, t0 + durMs / 1000);
  g.connect(ctx.destination);
  for (const f of freqs) {
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.value = f;
    o.connect(g);
    o.start(t0);
    o.stop(t0 + durMs / 1000 + 0.02);
  }
}

function startRingback() {
  if (ringbackActive || callAnsweredAtMs) return;
  ringbackActive = true;
  const ring = () => {
    if (!ringbackActive) return;
    playToneBurst([440, 480], 2000); // standard 2s ring, 4s cadence
  };
  ring();
  ringbackTimer = setInterval(ring, 6000);
}

function stopRingback() {
  ringbackActive = false;
  clearInterval(ringbackTimer);
  ringbackTimer = null;
}

function playConnectedChime() {
  playToneBurst([660], 140, 0.07);
  setTimeout(() => playToneBurst([880], 200, 0.07), 170);
}


function applyCallStatusUpdate(callRow) {
  if (!callRow) return;
  if (Array.isArray(callRow.transcript)) {
    callDbTranscript = callRow.transcript;
    renderBestTranscript();
  }
  if (callRow.created_at && !callPlacedAtMs) {
    callPlacedAtMs = new Date(callRow.created_at).getTime();
    ensureCallTimer();
  }
  const st = callRow.status;
  // Updates can arrive out of order (poll vs realtime). Once the call is
  // answered or finished, an older "queued"/"ringing" row must not restart the
  // ring.
  if ((st === 'queued' || st === 'ringing') && (callAnsweredAtMs || callRow.answered_at || callEndShownFor === callRow.id)) {
    stopRingback();
    return;
  }
  if (st === 'queued' || st === 'ringing') {
    // 'queued' = we dialed and the provider has not reported ringing yet, so we
    // say "Calling". Only a provider-reported 'ringing' says "Ringing" - and
    // only then does the local ringback tone play.
    applyCallPill(liveCallView({ status: st }).pill);
    if (st === 'ringing') startRingback(); else stopRingback();
  } else if (st === 'in_progress' || st === 'in-progress') {
    // The provider's answer event: talk time starts at answered_at. Rows
    // written before this field existed fall back to the transition moment
    // for display only - the recorded duration still comes from the server.
    stopRingback();
    if (!callAnsweredAtMs) {
      callAnsweredAtMs = callRow.answered_at ? new Date(callRow.answered_at).getTime() : Date.now();
      ensureCallTimer(); // shows the timer immediately
      playConnectedChime();
    }
    applyCallPill(liveCallView({ status: st, aiMuted: callAiMuted }).pill);
  } else if (TERMINAL_STATUSES.includes(st)) {
    stopRingback();
    // Real label per outcome - a rejection says "Call rejected", never a generic failure.
    setCallStatePill('ended', endedCallLabel(st));
    clearActiveCall();
    // A call that never connected: say the real reason and what happened,
    // and leave it on screen long enough to read, instead of vanishing.
    const never = !callAnsweredAtMs && st !== 'completed';
    if (never && callEndShownFor !== callRow.id) {
      callEndShownFor = callRow.id;
      const reason = callRow.outcome_summary || callSummaryLine(callRow);
      const panel = $('transcriptPanel');
      if (panel && reason) {
        panel.querySelector('.transcriptEmptyHint')?.remove();
        const note = document.createElement('div');
        note.className = 'transcriptEndReason';
        note.textContent = reason;
        panel.appendChild(note);
        panel.scrollTop = panel.scrollHeight;
        setTimeout(() => closeCallScreen(), 6000);
        return;
      }
    }
    closeCallScreen();
  }
}
let callEndShownFor = null;

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
    resetLiveTranscript();
    renderTranscript([]);
    $('waveRow').classList.remove('speaking');
    callAiMuted = false;
    $('callMuteBtn').classList.remove('active');
    applyCallPill(liveCallView({ status: 'queued' }).pill);

    // Ring time until the provider's answer event lands (answered_at), then
    // the conversation timer restarts from the real answer — see
    // applyCallStatusUpdate. Never count talk time from the dial moment.
    callPlacedAtMs = Date.now();
    callAnsweredAtMs = null;
    stopRingback();
    getCallToneCtx(); // unlock WebAudio while we're still inside the tap that placed the call
    stopCallMonitor();
    resetCallAudioBtn();
    ensureCallTimer();
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
  startLiveCaptions(callId);

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
    applyCallPill(answeredCallPill({ aiMuted: callAiMuted }));
    await authedFetch('/api/calls?action=mute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callId, muted: callAiMuted }),
    }).catch(() => {});
  };

  $('callAudioBtn').onclick = () => toggleCallMonitor();
  $('callKeypadBtn').onclick = () => {
    $('dialStatus').textContent = '';
    updateDialMatch();
    $('keypadDialog').showModal();
  };
}

// ---------- live call monitoring ----------
// Hear BOTH sides of the real call: the person's speech (inbound) and Emysa's
// TTS (outbound) streamed from the assistant service's /monitor websocket,
// authenticated with a short-lived per-call token. Playback-only — this
// never feeds audio back into the call, so muting or stopping it cannot
// affect what the recipient hears, and there is no feedback loop into the
// line. One monitor at a time: starting a new one closes the old first.
let callMonitor = null;

function resetCallAudioBtn() {
  const btn = $('callAudioBtn');
  if (!btn) return;
  btn.classList.remove('active', 'monitorMuted');
  btn.setAttribute('aria-label', 'Listen in to the call (hear both sides)');
}

// Speaker tapped before the call has a live audio session: no error, the button just
// stays on and listen-in starts by itself the moment the session exists.
let callMonitorArmed = null;

function cancelArmedMonitor({ keepCtx = false } = {}) {
  const armed = callMonitorArmed;
  callMonitorArmed = null;
  if (!armed) return;
  clearTimeout(armed.timer);
  if (!keepCtx) { try { armed.ctx?.close(); } catch {} }
  resetCallAudioBtn();
}

function armCallMonitor(callId, ctx) {
  cancelArmedMonitor();
  const armed = { callId, ctx, timer: null, attempts: 0 };
  callMonitorArmed = armed;
  $('callAudioBtn').classList.add('active');
  $('callAudioBtn').setAttribute('aria-label', 'Speaker on - will start when the call connects (tap to turn off)');
  const poll = async () => {
    if (callMonitorArmed !== armed) return;
    if (activeCallScreenId !== callId || armed.attempts++ > 150) { cancelArmedMonitor(); return; }
    let payload = null;
    let ok = false;
    try {
      const resp = await authedFetch('/api/calls?action=monitor-token', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ callId }),
      });
      payload = await resp.json().catch(() => ({}));
      ok = resp.ok && Boolean(payload?.url);
    } catch {}
    if (callMonitorArmed !== armed) return;
    if (ok) {
      cancelArmedMonitor({ keepCtx: true });
      try { startCallMonitor(payload.url, callId, ctx); } catch { try { ctx.close(); } catch {} }
      return;
    }
    if (payload?.code === 'not-live') { cancelArmedMonitor(); return; } // call ended
    armed.timer = setTimeout(poll, 2000);
  };
  armed.timer = setTimeout(poll, 1500);
}

function stopCallMonitor() {
  cancelArmedMonitor();
  const mon = callMonitor;
  callMonitor = null;
  if (!mon) return;
  clearTimeout(mon.noAudioTimer);
  try { mon.ws?.close(); } catch {}
  for (const lane of Object.values(mon.lanes || {})) clearTimeout(lane.flushTimer);
  try { mon.ctx?.close(); } catch {}
  resetCallAudioBtn();
}

async function toggleCallMonitor() {
  if (callMonitorArmed) { cancelArmedMonitor(); return; }
  if (callMonitor) {
    if (callMonitor.state === 'live') {
      // Local monitor mute only — Emysa keeps speaking to the recipient.
      callMonitor.state = 'muted';
      callMonitor.gain.gain.value = 0;
      $('callAudioBtn').classList.remove('active');
      $('callAudioBtn').classList.add('monitorMuted');
      $('callAudioBtn').setAttribute('aria-label', 'Monitoring muted — tap to stop listening');
      applyCallPill(listenInPill({ muted: true }));
      return;
    }
    stopCallMonitor();
    applyCallPill(answeredCallPill({ aiMuted: callAiMuted }));
    return;
  }
  const callId = activeCallScreenId;
  if (!callId) return;
  // iOS Safari / the installed PWA only allow audio to start from inside the
  // tap gesture. Creating the AudioContext AFTER the token fetch below (an
  // await) is too late - it stays suspended and the monitor is silent even
  // though the socket is connected. So create and resume it right here,
  // synchronously, and hand it to startCallMonitor.
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) {
    setCallStatePill('connecting', 'Audio not supported on this device');
    return;
  }
  let ctx = null;
  try {
    ctx = new AudioCtx();
    const resume = ctx.resume?.();
    if (resume?.catch) resume.catch(() => {});
  } catch {
    setCallStatePill('connecting', 'Monitoring unavailable');
    return;
  }
  const abandonCtx = () => { try { ctx?.close(); } catch {} };
  let payload = null;
  try {
    const resp = await authedFetch('/api/calls?action=monitor-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callId }),
    });
    payload = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      if (payload?.code === 'no-session') { // not connected yet: arm silently, no error text
        if (activeCallScreenId === callId) armCallMonitor(callId, ctx); else abandonCtx();
        return;
      }
      abandonCtx();
      setCallStatePill('connecting', userError(payload?.error, 'Listen-in isn\u2019t available right now'));
      return;
    }
  } catch {
    abandonCtx();
    setCallStatePill('connecting', 'Couldn\u2019t start listen-in. Check your connection');
    return;
  }
  if (activeCallScreenId !== callId) { abandonCtx(); return; } // screen changed while fetching

  try {
    startCallMonitor(payload.url, callId, ctx);
  } catch (err) {
    abandonCtx();
    console.warn('[listen-in] start failed', err);
    setCallStatePill('connecting', 'Couldn\u2019t start listen-in. Try again');
  }
}

function startCallMonitor(url, callId, unlockedCtx) {
  stopCallMonitor(); // never two monitors / two AudioContexts for one screen
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx && !unlockedCtx) {
    setCallStatePill('connecting', 'Audio not supported on this device');
    return;
  }
  // The context normally arrives already created+resumed inside the button's
  // tap handler (see toggleCallMonitor) - the user gesture iOS Safari and the
  // installed iOS PWA require before any audio may play.
  const ctx = unlockedCtx || new AudioCtx();
  const resume = ctx.resume?.();
  if (resume?.catch) resume.catch(() => {});
  const gain = ctx.createGain();
  gain.gain.value = 1;
  gain.connect(ctx.destination);

  // Each direction is its own gapless timeline. They used to share ONE
  // timeline, so the caller's audio and Emysa's audio were queued one after
  // the other: two real-time streams demanded two seconds of playback per
  // second, the queue fell behind, and the resync then started new audio on
  // top of buffers that were still playing - the "voice on voice" overlay.
  // Mixed by the browser instead, each side plays at its own real-time pace.
  // `jitter` is each lane's own cushion (seconds) and adapts: Emysa's audio is
  // paced evenly by the server so a small cushion is enough, but the caller's
  // audio arrives off the phone network in uneven bursts and needs a deeper,
  // self-growing one - otherwise every late burst leaves a gap (the skipping).
  const lanes = {
    1: { nextTime: 0, jitter: 0.45, sources: new Set(), gain: ctx.createGain(), pending: [], pendingSamples: 0, pendingRate: 16000, flushTimer: null }, // caller
    2: { nextTime: 0, jitter: 0.3, sources: new Set(), gain: ctx.createGain(), pending: [], pendingSamples: 0, pendingRate: 16000, flushTimer: null }, // Emysa
  };
  for (const lane of Object.values(lanes)) { lane.gain.gain.value = 1; lane.gain.connect(gain); }

  // Jitter buffer. Phone networks deliver audio in uneven bursts. Playing from
  // a ~0.3 s cushion absorbs that; the old 0.12 s cushion with a "restart if
  // 50 ms late" rule cut queued audio every time a packet was late, which is
  // the skipping. A late packet now just continues the timeline; only a lag of
  // more than ~1.5 s is trimmed, by dropping the oldest-queued audio's worth
  // of new input rather than stopping what is already playing.
  const MAX_JITTER = 0.9;   // deepest cushion a lane may grow to
  const JITTER_STEP = 0.1;  // growth per mid-speech underrun
  const MAX_LAG = 2.2;
  function flushLane(lane) {
    clearTimeout(lane.flushTimer);
    if (!lane.pendingSamples) return;
    const rate = lane.pendingRate;
    const merged = new Int16Array(lane.pendingSamples);
    let offset = 0;
    for (const chunk of lane.pending) { merged.set(chunk, offset); offset += chunk.length; }
    lane.pending = [];
    lane.pendingSamples = 0;
    const audio = ctx.createBuffer(1, merged.length, rate);
    const channel = audio.getChannelData(0);
    for (let i = 0; i < merged.length; i++) channel[i] = merged[i] / 32768;
    const source = ctx.createBufferSource();
    source.buffer = audio;
    source.connect(lane.gain);
    const now = ctx.currentTime;
    if (!lane.nextTime) {
      lane.nextTime = now + lane.jitter;
    } else if (lane.nextTime < now) {
      // Underrun: the queued audio ran out before the next chunk arrived.
      // Restarting with a ~50 ms cushion (the old behaviour) guaranteed the
      // very next late chunk would underrun too - a chain of tiny gaps. Re-prime
      // with the full cushion, and if this happened mid-speech (short gap)
      // deepen the cushion so the next burst is absorbed. A long gap is just
      // the other person pausing, so it does not grow the cushion.
      if (now - lane.nextTime < 1.0) lane.jitter = Math.min(MAX_JITTER, lane.jitter + JITTER_STEP);
      lane.nextTime = now + lane.jitter;
    }
    if (lane.nextTime > now + MAX_LAG) return; // far behind: skip this slice to catch up
    source.start(lane.nextTime);
    lane.nextTime += audio.duration;
    lane.sources.add(source);
    source.onended = () => lane.sources.delete(source);
  }
  let lastEmysaAudioAt = 0;

  let ws;
  try {
    ws = new WebSocket(url);
  } catch (err) {
    try { ctx.close(); } catch {}
    console.error('[listen-in] PUBLIC_ASSISTANT_WS_URL is not a valid wss:// address', err);
    setCallStatePill('connecting', 'Listen-in isn\u2019t available right now');
    return;
  }
  ws.binaryType = 'arraybuffer';
  const mon = { ws, ctx, gain, state: 'live', callId, lanes, opened: false, gotAudio: false, callLive: null, explained: false, noAudioTimer: null };
  callMonitor = mon;

  // Honest status: the pill only says "Listening in" once real audio has
  // arrived. Until then it says what is actually happening.
  const fail = (text) => {
    if (callMonitor !== mon) return;
    clearTimeout(mon.noAudioTimer);
    stopCallMonitor();
    setCallStatePill('connecting', text);
  };
  $('callAudioBtn').classList.add('active');
  $('callAudioBtn').setAttribute('aria-label', 'Listening in - tap to mute listening');

  ws.onopen = () => { mon.opened = true; };

  ws.onmessage = (event) => {
    if (callMonitor !== mon) return;
    if (typeof event.data === 'string') {
      let msg = null;
      try { msg = JSON.parse(event.data); } catch {}
      if (handleLiveTranscriptMessage(msg, callId)) return;
      if (msg?.type === 'ended') { stopCallMonitor(); setCallStatePill('ended', 'Call ended'); return; }
      const info = describeMonitorMessage(msg);
      if (msg?.type === 'ready') {
        mon.opened = true;
        mon.callLive = msg.callLive;
        clearTimeout(mon.noAudioTimer);
        mon.noAudioTimer = setTimeout(() => {
          if (callMonitor === mon && !mon.gotAudio) setCallStatePill('connecting', noAudioMessage(mon.callLive));
        }, MONITOR_NO_AUDIO_MS);
      }
      if (info?.kind === 'error') { mon.explained = true; fail(info.text); return; }
      if (info && !mon.gotAudio) setCallStatePill(info.kind, info.text);
      return;
    }
    if (ctx.state === 'suspended') ctx.resume?.().catch?.(() => {});
    const frame = decodeMonitorFrame(event.data);
    if (!frame) return;
    const lane = lanes[frame.direction];
    if (!lane) return;
    if (!mon.gotAudio) {
      mon.gotAudio = true;
      clearTimeout(mon.noAudioTimer);
      if (mon.state === 'live') applyCallPill(answeredCallPill({ aiMuted: callAiMuted }));
    }
    const { rate, samples } = frame;
    // Collect ~80 ms before scheduling: 50 tiny nodes a second per side was
    // choppy on a phone connection. A short timer flushes the tail of a
    // sentence so it is never held back waiting for the next frame.
    lane.pending.push(samples);
    lane.pendingRate = rate;
    lane.pendingSamples += samples.length;
    clearTimeout(lane.flushTimer);
    if (lane.pendingSamples >= rate * 0.08) flushLane(lane);
    else lane.flushTimer = setTimeout(() => flushLane(lane), 70);

    // The far end often hears Emysa through a speaker, so their mic sends a
    // delayed copy of her voice back. Duck the caller lane while she is
    // talking so that echo does not sound like a second Emysa.
    if (frame.direction === 2) lastEmysaAudioAt = performance.now();
    const emysaTalking = performance.now() - lastEmysaAudioAt < 450;
    lanes[1].gain.gain.setTargetAtTime(emysaTalking ? 0.3 : 1, ctx.currentTime, 0.05);
  };
  const onGone = (event) => {
    if (callMonitor !== mon) return;
    const text = describeMonitorClose({ opened: mon.opened, code: event?.code, hadAudio: mon.gotAudio, alreadyExplained: mon.explained });
    if (text) console.warn('[listen-in] socket closed', { opened: mon.opened, code: event?.code });
    if (text) fail(text);
    else { clearTimeout(mon.noAudioTimer); stopCallMonitor(); }
  };
  ws.onclose = onGone;
  ws.onerror = onGone;
}

function closeCallScreen() {
  stopRingback();
  activeCallScreenId = null;
  stopCallMonitor();
  stopLiveCaptions();
  clearInterval(callTimerInterval);
  clearInterval(activeCallPollInterval);
  activeCallPollInterval = null;
  callPlacedAtMs = null;
  callAnsweredAtMs = null;
  if (activeCallChannel) { supabase.removeChannel(activeCallChannel); activeCallChannel = null; }
  $('callScreen').classList.add('hidden');
  loadCalls();
}

// ---------- live transcript ----------
// Turns arrive from the call service over a websocket the moment they are
// said (no database round trip), and the database copy keeps arriving over
// realtime + polling as the source of truth. Both feed one renderer, which
// shows whichever has more turns so the screen never goes backwards.
let callDbTranscript = [];
let liveTranscript = new Map(); // seq -> entry, from the websocket(s)
let liveCaptions = null;

function resetLiveTranscript() {
  callDbTranscript = [];
  liveTranscript = new Map();
}

function renderBestTranscript() {
  const live = [...liveTranscript.entries()].sort((a, b) => a[0] - b[0]).map(([, entry]) => entry);
  renderTranscript(live.length > callDbTranscript.length ? live : callDbTranscript);
}

// Returns true when the message was a transcript message (handled).
function handleLiveTranscriptMessage(msg, callId) {
  if (!msg || activeCallScreenId !== callId) return false;
  if (msg.type === 'transcript' && Number.isFinite(msg.seq)) {
    liveTranscript.set(msg.seq, {
      speaker: msg.speaker,
      content: msg.content,
      at: msg.at,
      interrupted: msg.interrupted,
    });
    renderBestTranscript();
    return true;
  }
  if (msg.type === 'transcript_snapshot' && Array.isArray(msg.entries)) {
    for (const e of msg.entries) {
      if (Number.isFinite(e?.seq)) liveTranscript.set(e.seq, { speaker: e.speaker, content: e.content, at: e.at, interrupted: e.interrupted });
    }
    renderBestTranscript();
    return true;
  }
  return false;
}

function stopLiveCaptions() {
  const lc = liveCaptions;
  liveCaptions = null;
  if (!lc) return;
  lc.stopped = true;
  clearTimeout(lc.timer);
  try { lc.ws?.close(); } catch {}
}

// A text-only listener on the call service: live captions without needing to
// tap "listen in", and without the audio stream. While the call is still
// ringing there is nothing to attach to yet, so it retries until it connects
// (or the screen closes).
function startLiveCaptions(callId) {
  stopLiveCaptions();
  const lc = { callId, stopped: false, ws: null, timer: null, attempts: 0 };
  liveCaptions = lc;
  const retry = (ms) => {
    if (lc.stopped || lc.attempts > 120) return;
    lc.timer = setTimeout(connect, ms);
  };
  const connect = async () => {
    if (lc.stopped || activeCallScreenId !== callId) return;
    lc.attempts += 1;
    let url = null;
    try {
      const resp = await authedFetch('/api/calls?action=monitor-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callId }),
      });
      const payload = await resp.json().catch(() => ({}));
      if (resp.ok && payload?.url) url = payload.url;
    } catch {}
    if (lc.stopped || activeCallScreenId !== callId) return;
    if (!url) { retry(3000); return; } // call not live yet (still ringing) or not available
    let ws;
    try {
      ws = new WebSocket(url + (url.includes('?') ? '&' : '?') + 'audio=0');
    } catch { retry(5000); return; }
    lc.ws = ws;
    let ended = false;
    ws.onmessage = (event) => {
      if (typeof event.data !== 'string') return;
      let msg = null;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (msg?.type === 'ended') { ended = true; return; }
      if (msg?.type === 'error') { ended = true; return; } // auth/too-many-listeners: do not hammer it
      handleLiveTranscriptMessage(msg, callId);
    };
    ws.onclose = () => { if (!ended) retry(2000); };
    ws.onerror = () => { try { ws.close(); } catch {} };
  };
  connect();
}

function renderTranscript(history) {
  const panel = $('transcriptPanel');
  if (!panel) return;
  panel.textContent = '';
  const items = Array.isArray(history) ? history : [];
  if (items.length === 0) {
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
    case 'rejected': return `${name} rejected the call`;
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

// ---------- swipe / hold to delete ----------
// Wraps `row` so that dragging it left (or holding it) slides it off a red
// Delete pane; tapping the pane runs onDelete. Only one row is open at a time.
function makeSwipeDelete(row, onDelete, { remove = true } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'swipeWrap';
  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'swipeDelete';
  del.textContent = 'Delete';
  row.classList.add('swipeFront');
  row.parentNode?.replaceChild(wrap, row);
  wrap.append(del, row);

  const OPEN = 92;
  let startX = 0, startY = 0, dx = 0, tracking = false, moved = false, holdTimer = null, swallowClick = false;
  const closeOthers = () => document.querySelectorAll('.swipeWrap.open').forEach((w) => { if (w !== wrap) w.classList.remove('open'); });
  const setOpen = (open) => { wrap.classList.toggle('open', open); row.style.transform = ''; if (open) closeOthers(); };

  row.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    startX = e.clientX; startY = e.clientY; dx = 0; tracking = true; moved = false;
    clearTimeout(holdTimer);
    holdTimer = setTimeout(() => { if (tracking && !moved) { swallowClick = true; setOpen(true); } }, 550);
  });
  row.addEventListener('pointermove', (e) => {
    if (!tracking) return;
    const mx = e.clientX - startX, my = e.clientY - startY;
    if (!moved && Math.abs(my) > 10 && Math.abs(my) > Math.abs(mx)) { tracking = false; clearTimeout(holdTimer); return; }
    if (Math.abs(mx) > 8) { moved = true; clearTimeout(holdTimer); wrap.classList.add('dragging'); }
    if (!moved) return;
    const base = wrap.classList.contains('open') ? -OPEN : 0;
    dx = Math.max(-OPEN * 1.3, Math.min(0, base + mx));
    row.style.transform = `translateX(${dx}px)`;
  });
  const end = () => {
    clearTimeout(holdTimer);
    if (!tracking) return;
    tracking = false;
    wrap.classList.remove('dragging');
    if (moved) { swallowClick = true; setOpen(dx < -OPEN / 2); }
    else row.style.transform = '';
  };
  row.addEventListener('pointerup', end);
  row.addEventListener('pointercancel', end);
  row.addEventListener('pointerleave', () => { if (tracking && !moved) { clearTimeout(holdTimer); } });
  // A swipe or hold must not also count as a tap that opens the row.
  row.addEventListener('click', (e) => {
    if (swallowClick) { e.stopImmediatePropagation(); e.preventDefault(); swallowClick = false; return; }
    if (wrap.classList.contains('open')) { e.stopImmediatePropagation(); e.preventDefault(); setOpen(false); }
  }, true);
  row.addEventListener('contextmenu', (e) => e.preventDefault());

  del.addEventListener('click', async (e) => {
    e.stopPropagation();
    del.disabled = true;
    try {
      await onDelete();
      if (remove) {
        wrap.classList.add('removing');
        setTimeout(() => wrap.remove(), 200);
      } else {
        del.disabled = false;
        setOpen(false);
      }
    } catch {
      del.disabled = false;
      setOpen(false);
    }
  });
  return wrap;
}

document.addEventListener('pointerdown', (e) => {
  if (!e.target.closest('.swipeWrap')) document.querySelectorAll('.swipeWrap.open').forEach((w) => w.classList.remove('open'));
});

// Same person, any format of their number -> the same key.
function personKeyForCall(c) {
  const digits = String(c.to_number || '').replace(/\D/g, '');
  if (digits.length >= 7) return `p:${digits}`;
  if (c.contact_id) return `c:${c.contact_id}`;
  return `i:${c.id}`;
}

function renderCallsList(calls) {
  const list = $('callsList');
  list.innerHTML = '';
  if (!calls?.length) {
    list.innerHTML = `<div class="authHint" style="text-align:left;">No calls yet.</div>`;
    return;
  }
  // One row per person (newest call first within each), never one row per call.
  const groups = new Map();
  for (const c of calls) {
    const key = personKeyForCall(c);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  for (const group of groups.values()) {
    const c = group.find((x) => x.contact_name) || group[0];
    const latest = group[0];
    const isKnown = !!c.contact_name;
    const name = c.contact_name || latest.to_number;
    const el = document.createElement('div');
    el.className = 'recentRow';

    // A muted, per-person gradient (hashed from their name/number) rather
    // than the flat theme-accent color, which looked identical for every
    // row and didn't match the soft varied avatar look in the reference.
    const hue = hueForName(name);
    const avatarStyle = '';
    const avatarHtml = isKnown
      ? `<div class="recentAvatar" style="${avatarStyle}">${escapeHtml((name || '?')[0].toUpperCase())}</div>`
      : `<div class="recentAvatar" style="${avatarStyle}"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10zm0 2c-4.42 0-8 2.24-8 5v1a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-1c0-2.76-3.58-5-8-5z"/></svg></div>`;

    const subtitle = callSummaryLine(latest) || (isKnown ? '' : 'unknown');
    const countBadge = group.length > 1 ? `<span class="recentCount">${group.length}</span>` : '';

    el.innerHTML = `
      ${avatarHtml}
      <div class="recentBody">
        <div class="recentTop">
          <div class="recentName${isKnown ? '' : ' recentName--unknown'}">${escapeHtml(name)}${countBadge}</div>
          <div class="recentDate">${relativeCallDate(latest.created_at)}</div>
        </div>
        <div class="recentPreview">${escapeHtml(subtitle)}</div>
      </div>`;

    const details = () => openCallDetail(latest, name, isKnown);
    el.querySelector('.recentBody').insertAdjacentHTML('afterend', `<button type="button" class="recentInfoBtn" aria-label="Call details"><svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9.25" stroke="currentColor" stroke-width="1.5"/><path d="M12 11v5.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="12" cy="8" r="1.1" fill="currentColor"/></svg></button>`);
    el.querySelector('.recentInfoBtn').addEventListener('click', (event) => { event.stopPropagation(); details(); });
    // Tapping a person opens their single conversation (any of their calls'
    // chats works: placing a call folds them into one).
    const sessionId = group.map((x) => x.session_id).find(Boolean);
    const open = () => {
      if (sessionId) { openChatSession(sessionId); showTab('chat'); }
      else details();
    };
    el.tabIndex = 0;
    el.setAttribute('role', 'button');
    el.setAttribute('aria-label', `Open conversation with ${name}`);
    el.onclick = open;
    el.onkeydown = (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); } };
    list.appendChild(el);

    const live = group.some((x) => ['queued', 'ringing', 'in_progress', 'in-progress'].includes(x.status));
    if (!live) {
      const ids = group.map((x) => x.id);
      const sessions = [...new Set(group.map((x) => x.session_id).filter(Boolean))];
      makeSwipeDelete(el, async () => {
        const r = await authedFetch('/api/calls?action=delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ callIds: ids }) });
        if (!r.ok) throw new Error('delete failed');
        for (const sid of sessions) {
          await authedFetch('/api/assistant?action=deleteSession', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: sid }) }).catch(() => {});
          if (sid === currentChatSessionId) startNewChat();
        }
        const gone = new Set(ids);
        lastLoadedCalls = lastLoadedCalls.filter((x) => !gone.has(x.id));
        recentChatSessions = recentChatSessions.filter((x) => !sessions.includes(x.id));
      });
    }
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
  learned: 'What I learned',
  confirmed: 'Confirmed',
  unclear: 'Unclear, not treated as fact',
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
    if (!resp.ok) throw new Error(userError(data.error, 'Could not place the call.'));
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

// A finished call with a transcript but no summary (generation failed, or
// never ran) used to show only the transcript with no explanation. Try once
// automatically when the detail opens, and keep a button so it can be retried;
// show the real failure reason if it fails.
const summaryAutoTried = new Set();
function setupSummaryRecovery(c, summaryText) {
  const card = $('callDetailSummaryCard');
  const text = $('callDetailSummary');
  const btn = $('callDetailSummaryBtn');
  if (!btn) return;
  btn.classList.add('hidden');
  btn.onclick = null;
  const terminal = TERMINAL_STATUSES.includes(c.status);
  const hasTranscript = Array.isArray(c.transcript) && c.transcript.some((t) => String(t?.content || t?.text || '').trim());
  if (summaryText || !terminal || !hasTranscript) return;

  card.classList.remove('hidden');
  const priorError = c.summary_json?.error;
  text.textContent = priorError ? `No summary yet (${priorError}).` : 'No summary yet.';
  btn.classList.remove('hidden');

  const run = async () => {
    btn.disabled = true;
    btn.textContent = 'Generating…';
    text.textContent = 'Generating summary…';
    try {
      const resp = await authedFetch('/api/calls?action=summarize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callId: c.id }),
      });
      const out = await resp.json().catch(() => ({}));
      if (callDetailCurrent?.call?.id !== c.id) return; // dialog moved on
      if (resp.ok && out.summary && out.status !== 'skipped') {
        c.outcome_summary = out.summary;
        c.summary_json = out.summary_json;
        text.textContent = out.summary;
        renderCallDetailSections(out.summary_json);
        btn.classList.add('hidden');
        return;
      }
      text.textContent = `Couldn't generate a summary: ${out.error || out.status || 'server error'}.`;
    } catch (err) {
      if (callDetailCurrent?.call?.id === c.id) text.textContent = "Couldn't reach the server to generate a summary.";
    } finally {
      btn.disabled = false;
      btn.textContent = 'Try again';
    }
  };
  btn.onclick = run;
  if (!summaryAutoTried.has(c.id)) {
    summaryAutoTried.add(c.id);
    run();
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
  setupSummaryRecovery(c, summaryText);
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

let recentChatSessions = [];
let recentChatMenuTargetId = null;

async function loadRecentChats() {
  const resp = await authedFetch('/api/assistant?action=sessions&callRelated=true').catch(() => null);
  if (!resp?.ok) { $('recentChatsList').textContent = 'Couldn\'t load chats.'; return; }
  const { sessions } = await resp.json();
  recentChatSessions = sessions || [];
  renderRecentChatsList(recentChatSessions);
}

// One row per session is already one row per person now — chat_sessions
// has a unique (user_id, peer_key) index (sql/019), kept that way server-side
// by resolvePersonSession/lib/personSession.js, matched on phone number
// rather than contact_id or a free-text label. Nothing to re-group here.
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
    // Lead with who it is (a saved contact's name, or the number if that's
    // all we have) rather than the session's generic title — a contact's
    // name reads far better in a call list than "Smart conversation".
    const primary = s.call_label || s.title;
    const secondary = s.call_label ? s.title : null;
    row.innerHTML = `
      <div class="recentBody"><div class="savedChatTitle">${escapeHtml(primary)}</div>${secondary ? `<div class="recentPreview">${escapeHtml(secondary)}</div>` : ''}</div>
      <div class="chatRowActions">
        <div class="savedChatDate">${shortDateLabel(s.updated_at)}</div>
        <button class="recentChatKebabBtn" aria-label="More"><svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="12" cy="19" r="1.8"/></svg></button>
      </div>`;
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    row.addEventListener('keydown', (e) => { if (e.target === row && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); row.click(); } });
    row.addEventListener('click', () => {
      openChatSession(s.id);
      showTab('chat');
    });
    row.querySelector('.recentChatKebabBtn').addEventListener('click', (e) => {
      e.stopPropagation();
      openRecentChatMenu(e.currentTarget, s.id);
    });
    list.appendChild(row);
    makeSwipeDelete(row, async () => {
      const r = await authedFetch('/api/assistant?action=deleteSession', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: s.id }) });
      if (!r.ok) throw new Error('delete failed');
      recentChatSessions = recentChatSessions.filter((x) => x.id !== s.id);
      if (s.id === currentChatSessionId) startNewChat();
    });
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
  renderRecentChatsList(!q ? recentChatSessions : recentChatSessions.filter((s) => (s.call_label || s.title || '').toLowerCase().includes(q)));
});

async function loadCalls() {
  if (!currentSession) return;
  const resp = await authedFetch('/api/calls?action=list').catch(() => null);
  if (!resp?.ok) { $('callsList').textContent = 'Couldn\'t load calls.'; return; }
  const { calls } = await resp.json();
  lastLoadedCalls = calls || [];
  renderCallsList(lastLoadedCalls);
}


// ---------- Home: command center ----------
let homeBalance = null;
let homeLoadedAt = 0;

function formatMinutes(n) {
  const m = Math.max(0, Math.floor(Number(n) || 0));
  return `${m} minute${m === 1 ? '' : 's'}`;
}
function relTimeShort(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return '';
  const min = Math.floor(ms / 60000);
  if (min < 1) return 'now';
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return d < 30 ? `${d}d` : shortDateLabel(iso);
}

function renderBalance() {
  $('dashMinutes').textContent = homeBalance ? formatMinutes(homeBalance.remaining) : '–';
  $('dashBalanceSub').textContent = homeBalance?.pending ? 'confirming payment…' : 'remaining';
}

async function loadBalance() {
  const resp = await authedFetch('/api/referrals?action=billing').catch(() => null);
  if (!resp?.ok) return;
  homeBalance = await resp.json();
  renderBalance();
}

let homeContacts = [];
let homeHeroLoadedAt = 0;

// Hero GIF: one row in home_hero, uploaded from the admin panel. Nothing is
// shown (no placeholder) until a GIF exists.
async function loadHomeHero() {
  const img = $('dashHeroMedia');
  // Paint from the last known URL straight away (the browser/service-worker
  // already has the file), then confirm with the database.
  const cached = localStorage.getItem('emysa.heroUrl');
  if (cached && !img.getAttribute('src')) { img.src = cached; img.hidden = false; }
  if (Date.now() - homeHeroLoadedAt < 60000) return;
  homeHeroLoadedAt = Date.now();
  const { data } = await supabase.from('home_hero').select('url').order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (data?.url) {
    try { localStorage.setItem('emysa.heroUrl', data.url); } catch {}
    if (img.getAttribute('src') !== data.url) img.src = data.url;
    img.hidden = false;
  } else {
    try { localStorage.removeItem('emysa.heroUrl'); } catch {}
    img.removeAttribute('src');
    img.hidden = true;
  }
}

async function loadHomePeople() {
  const [contactsResp, callsResp] = await Promise.all([
    authedFetch('/api/contacts').catch(() => null),
    authedFetch('/api/calls?action=list').catch(() => null),
  ]);
  if (!contactsResp?.ok) return;
  const { contacts } = await contactsResp.json();
  const calls = callsResp?.ok ? ((await callsResp.json()).calls || []) : [];
  homeContacts = contacts || [];
  renderHomePeople(homeContacts, calls);
}

// Only people saved inside Emysa (never device contacts). Most recently called
// first, then the rest alphabetically; four fit the row.
function renderHomePeople(contacts, calls) {
  const lastCall = new Map();
  for (const call of calls) {
    if (!call.contact_id || call.call_kind === 'emysa') continue;
    const prev = lastCall.get(call.contact_id);
    if (!prev || call.created_at > prev) lastCall.set(call.contact_id, call.created_at);
  }
  const ordered = [...contacts].sort((a, b) => {
    const la = lastCall.get(a.id) || '';
    const lb = lastCall.get(b.id) || '';
    return la === lb ? (a.name || '').localeCompare(b.name || '') : (la < lb ? 1 : -1);
  }).slice(0, 4);
  const row = $('dashPeopleRow');
  row.textContent = '';
  if (!ordered.length) {
    const empty = document.createElement('div');
    empty.className = 'dashEmpty';
    empty.textContent = 'Add someone in Contacts to call them by name.';
    row.appendChild(empty);
    return;
  }
  for (const c of ordered) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'dashPerson';
    btn.setAttribute('aria-label', `Call ${c.name}`);
    const avatar = document.createElement('span');
    avatar.className = 'dashAvatar';
    avatar.textContent = ((c.name || '?').trim()[0] || '?').toUpperCase();
    const name = document.createElement('span');
    name.className = 'dashPersonName';
    name.textContent = c.name;
    const sub = document.createElement('span');
    sub.className = 'dashPersonSub';
    sub.textContent = lastCall.has(c.id) ? `Last call · ${relTimeShort(lastCall.get(c.id))}` : 'No calls yet';
    btn.append(avatar, name, sub);
    btn.addEventListener('click', () => openContactMethods(c, btn));
    row.appendChild(btn);
  }
}

function loadHome(force = false) {
  if (!currentSession) return;
  if (!force && Date.now() - homeLoadedAt < 15000) return;
  homeLoadedAt = Date.now();
  loadBalance();
  loadHomePeople();
  loadHomeHero();
}

// Quick actions. Each one opens something that already exists: no new backend.
// Scheduling, follow-ups and questions start a fresh chat with a starter line.
function openChatWith(starter) {
  startNewChat();
  showTab('chat');
  const input = $('briefInput');
  input.value = starter;
  input.dispatchEvent(new Event('input'));
  input.focus();
  input.setSelectionRange(starter.length, starter.length);
}
const HOME_ACTIONS = {
  call: () => showTab('contacts'),
  schedule: () => openChatWith('Schedule a call with '),
  followup: () => openChatWith('Follow up with '),
  ask: () => openChatWith('Find out '),
  import: openImportPicker,
};
document.querySelectorAll('#dashActions .dashAction').forEach((btn) => btn.addEventListener('click', () => HOME_ACTIONS[btn.dataset.action]?.()));
$('dashNotifBtn').addEventListener('click', () => openSheet('sheet-notifications'));
$('dashPeopleAll').addEventListener('click', () => showTab('contacts'));
// Chat history is imported per person, so Import Chat first asks who it is for,
// then opens that person's existing WhatsApp history sheet (which has the file picker).
function openImportPicker() {
  if (!homeContacts.length) { showTab('contacts'); return; }
  const list = $('importPickList');
  list.textContent = '';
  const head = document.createElement('div');
  head.className = 'iosMenuHeader';
  head.textContent = 'Import chat for…';
  list.appendChild(head);
  for (const c of [...homeContacts].sort((x, y) => (x.name || '').localeCompare(y.name || ''))) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'iosRow iosRowLink';
    const title = document.createElement('span');
    title.className = 'iosRowTitle';
    title.textContent = c.name;
    row.appendChild(title);
    row.addEventListener('click', () => { $('moreDialog').close(); openContactMemory(c); });
    list.appendChild(row);
  }
  $('moreDialog').showModal();
}

// ---------- Add time (paid through Bachs hosted checkout) ----------
// The payment page is opened as a separate window so the installed PWA is never
// navigated away. The minutes are credited server-side (signed webhook, or the
// verify call below when the app comes back to the foreground), so nothing here
// can add minutes by itself.
const PAY_FLAG = 'emysa_pay_started';
const PAY_FLAG_MAX_AGE_MS = 2 * 60 * 60 * 1000;
const payPending = () => {
  const at = Number(localStorage.getItem(PAY_FLAG) || 0);
  if (at && Date.now() - at > PAY_FLAG_MAX_AGE_MS) { localStorage.removeItem(PAY_FLAG); return false; }
  return Boolean(at);
};

let addTimeQty = 1;

// "5 hours" / "5 call hours"; odd lengths fall back to minutes.
function callTimeLabels(minutes) {
  if (minutes % 60 === 0) {
    const h = minutes / 60;
    return { big: `${h} ${h === 1 ? 'hour' : 'hours'}`, buy: `${h} call ${h === 1 ? 'hour' : 'hours'}` };
  }
  return { big: `${minutes} minutes`, buy: `${minutes} call minutes` };
}
function formatPlainPrice(amount, currency) {
  const whole = Number.isInteger(Number(amount));
  try { return new Intl.NumberFormat(undefined, { style: 'currency', currency, minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: whole ? 0 : 2 }).format(Number(amount)); }
  catch { return `${amount} ${currency}`; }
}

function renderAddTime() {
  const unit = homeBalance?.unit;
  const ready = Boolean(homeBalance?.payments && unit);
  const out = homeBalance && homeBalance.remaining < 1;
  $('addTimeLead').textContent = out ? "You're out of call time.\nTop up to keep Emysa making calls for you." : 'Top up to keep Emysa making calls for you.';
  $('addTimeQty').textContent = `${addTimeQty}×`;
  $('addTimeMinus').disabled = addTimeQty <= 1;
  $('addTimePlus').disabled = !ready || addTimeQty >= unit.maxQty;
  if (!ready) {
    $('addTimeBig').textContent = '–';
    $('addTimeBuy').textContent = 'Purchase';
    $('addTimeBuy').disabled = true;
    $('addTimeStatus').textContent = homeBalance ? 'Adding time is not available yet.' : 'Could not load. Check your connection and try again.';
    return;
  }
  const labels = callTimeLabels(unit.minutes * addTimeQty);
  const total = unit.prices ? Number(unit.prices[addTimeQty - 1]) : (Math.round(Number(unit.amount) * 100) * addTimeQty) / 100;
  $('addTimeBig').textContent = labels.big;
  $('addTimeBuy').textContent = `Purchase ${labels.buy} · ${formatPlainPrice(total, unit.currency)}`;
  $('addTimeBuy').disabled = false;
}

async function openAddTime() {
  addTimeQty = 1;
  $('addTimeStatus').textContent = '';
  $('addTimeOpen').classList.add('hidden');
  $('addTimeScreen').classList.remove('hidden');
  renderAddTime();
  if (!homeBalance?.unit) { await loadBalance(); renderAddTime(); }
}
function closeAddTime() { $('addTimeScreen').classList.add('hidden'); }

async function startCheckout() {
  const buy = $('addTimeBuy');
  buy.disabled = true;
  $('addTimeStatus').textContent = 'Opening secure payment…';
  try {
    const resp = await authedFetch('/api/referrals?action=checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ quantity: addTimeQty }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || !data.url) throw new Error(data.error || 'Could not open payment. Try again.');
    localStorage.setItem(PAY_FLAG, String(Date.now()));
    // No 'noopener' feature: it makes window.open return null, which would look
    // like a blocked window. The opener link is cut by hand instead.
    const opened = window.open(data.url, '_blank');
    if (opened) {
      try { opened.opener = null; } catch {}
      $('addTimeStatus').textContent = '';
    } else {
      // The browser blocked the window (the request finished after the tap).
      // A real tap on a link always works, including in an installed PWA.
      $('addTimeOpen').href = data.url;
      $('addTimeOpen').classList.remove('hidden');
      $('addTimeStatus').textContent = 'Tap to continue to payment.';
    }
    watchPayment();
  } catch (err) {
    $('addTimeStatus').textContent = err.message || 'Could not open payment. Try again.';
  } finally {
    buy.disabled = false;
  }
}

$('addTimeMinus').addEventListener('click', () => { if (addTimeQty > 1) { addTimeQty -= 1; renderAddTime(); } });
$('addTimePlus').addEventListener('click', () => { if (homeBalance?.unit && addTimeQty < homeBalance.unit.maxQty) { addTimeQty += 1; renderAddTime(); } });
$('addTimeBuy').addEventListener('click', startCheckout);
$('addTimeClose').addEventListener('click', closeAddTime);
$('addTimeTerms').addEventListener('click', () => openSheet('sheet-terms'));
$('addTimePrivacy').addEventListener('click', () => openSheet('sheet-privacy'));

let payWatching = false;
async function verifyPayment() {
  const resp = await authedFetch('/api/referrals?action=billing-verify', { method: 'POST' }).catch(() => null);
  if (!resp?.ok) return null;
  const data = await resp.json();
  const before = homeBalance?.remaining;
  homeBalance = { ...(homeBalance || {}), ...data, payments: true };
  renderBalance();
  if (before != null && data.remaining > before) {
    showToast(`${formatMinutes(data.remaining - before)} added`);
    closeAddTime();
  }
  if (!data.pending) localStorage.removeItem(PAY_FLAG);
  return data;
}

// After the payment window: check as soon as the app is foregrounded, then keep
// checking for up to two minutes in case the payment is still processing.
async function watchPayment() {
  if (payWatching || !currentSession) return;
  payWatching = true;
  try {
    for (let i = 0; i < 24 && payPending(); i++) {
      if (document.visibilityState === 'visible') {
        const data = await verifyPayment();
        if (data && !data.pending) break;
      }
      await new Promise((r) => setTimeout(r, 5000));
    }
  } finally { payWatching = false; }
}
function resumePaymentCheck() { if (payPending()) watchPayment(); }
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') resumePaymentCheck(); });
window.addEventListener('pageshow', resumePaymentCheck);

$('dashBalanceBtn').addEventListener('click', openAddTime);
$('dashAddTime').addEventListener('click', openAddTime);

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
  if (Notification.permission === 'denied') {
    $('notificationsStatus').textContent = 'Blocked at the browser/OS level — enable in system settings to turn this back on.';
    return;
  }
  const wasGranted = Notification.permission === 'granted';
  const ok = await ensureNotificationsEnabled({ fromTap: true });
  await refreshNotificationsToggle();
  if (ok) $('notificationsStatus').textContent = wasGranted
    ? 'Notifications are on for this device. To turn them off, disable them for this app in your phone settings.'
    : 'Notifications are on for this device.';
  else if (Notification.permission === 'granted') $('notificationsStatus').textContent = 'Allowed, but this device could not be registered for notifications. Try again in a moment.';
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
$('contactsBtn').addEventListener('click', () => { closeSheets(); showTab('contacts'); });
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


// ---------- WhatsApp history -> reviewed memories (per contact) ----------
// Import a WhatsApp export, pick who is who, consent, then review what was
// found. Only approved memories are used on calls. Chat text is only ever put
// on screen with textContent.
const CM_TYPE_LABEL = {
  identity: 'Identity', preferences: 'Preferences', communication_style: 'How they communicate', important_relationships: 'People in their life',
  recurring_facts: 'Recurring facts', previous_context: 'Earlier context', unresolved_issues: 'Open issues', commitments: 'Commitments',
  important_dates: 'Important dates', caller_preferences: 'On calls',
};
let cmContact = null;
let cmImport = null;
let cmFilter = 'candidate';
let cmMemories = [];
let cmBusy = false;

async function cmApi(action, { method = 'GET', query = {}, body } = {}) {
  const params = new URLSearchParams({ scope: 'contact', action, ...query });
  const resp = await authedFetch(`/api/memories?${params}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(userError(data.error, `Something went wrong (HTTP ${resp.status}). Try again.`));
  return data;
}
const cmSay = (text) => { $('cmStatus').textContent = text || ''; };

function openContactMemory(contact) {
  cmContact = contact;
  cmImport = null;
  cmFilter = 'candidate';
  $('cmTitle').textContent = `${contact.name}: WhatsApp history`;
  $('cmSetup').classList.add('hidden');
  $('cmFile').value = '';
  cmSay('');
  openSheet('sheet-contact-memory');
  cmRefresh();
}

async function cmRefresh() {
  if (!cmContact) return;
  const id = cmContact.id;
  // Load each part on its own so one failing call cannot blank the whole
  // screen, and never show an error just for opening it.
  const [mem, imp, ctx] = await Promise.allSettled([
    cmApi('cm-list', { query: { contactId: id } }),
    cmApi('import-list', { query: { contactId: id } }),
    cmApi('contact-context', { query: { contactId: id } }),
  ]);
  if (!cmContact || cmContact.id !== id) return;
  cmMemories = mem.status === 'fulfilled' ? (mem.value.memories || []) : [];
  cmRenderList();
  if (mem.status === 'rejected') {
    const note = document.createElement('div');
    note.className = 'cmEmpty';
    note.textContent = `Could not load saved memories (${mem.reason.message}) `;
    note.appendChild(cmButton('Retry', 'cmRetry', cmRefresh));
    $('cmList').textContent = '';
    $('cmList').appendChild(note);
  }
  if (imp.status === 'fulfilled') cmRenderImports(imp.value.imports || []);
  $('cmPreviewText').textContent = (ctx.status === 'fulfilled' && ctx.value.promptBlock) || 'Nothing approved yet.';
}

function cmRenderList() {
  const count = (status) => cmMemories.filter((m) => m.status === status || (status === 'approved' && m.status === 'edited')).length;
  $('cmCountCandidate').textContent = count('candidate') ? `(${count('candidate')})` : '';
  $('cmCountApproved').textContent = count('approved') ? `(${count('approved')})` : '';
  $('cmCountRejected').textContent = count('rejected') ? `(${count('rejected')})` : '';
  document.querySelectorAll('#cmFilters .memoryFilterBtn').forEach((b) => b.classList.toggle('active', b.dataset.cmStatus === cmFilter));
  const list = $('cmList');
  list.textContent = '';
  const shown = cmMemories.filter((m) => (cmFilter === 'approved' ? m.status === 'approved' || m.status === 'edited' : m.status === cmFilter));
  if (!shown.length) {
    const empty = document.createElement('div');
    empty.className = 'cmEmpty';
    empty.textContent = cmFilter === 'candidate' ? 'Nothing to review. Import a chat to get suggestions.' : cmFilter === 'approved' ? 'Nothing approved yet.' : 'Nothing rejected.';
    list.appendChild(empty);
    return;
  }
  for (const m of shown) list.appendChild(cmCard(m));
}

function cmButton(label, className, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  if (className) b.className = className;
  b.addEventListener('click', onClick);
  return b;
}

function cmCard(m) {
  const card = document.createElement('div');
  card.className = 'cmCard';
  const type = document.createElement('div');
  type.className = 'cmType';
  type.textContent = CM_TYPE_LABEL[m.memory_type] || m.memory_type;
  if (m.is_inferred || Number(m.confidence) < 0.7) {
    const badge = document.createElement('span');
    badge.className = 'cmBadge';
    badge.textContent = m.is_inferred ? 'Inferred: check it' : 'Unsure: check it';
    type.appendChild(badge);
  }
  const text = document.createElement('div');
  text.className = 'cmText';
  text.textContent = m.memory_text;
  card.append(type, text);
  if (m.source_message) {
    const src = document.createElement('details');
    src.className = 'cmSource';
    const sum = document.createElement('summary');
    sum.textContent = `From the chat${m.source_date ? `, ${m.source_date.slice(0, 10)}` : ''}`;
    const quote = document.createElement('div');
    quote.textContent = m.source_message;
    src.append(sum, quote);
    card.appendChild(src);
  }
  const actions = document.createElement('div');
  actions.className = 'cmActions';
  const act = (patch) => async () => { try { await cmApi('cm-update', { method: 'PATCH', body: { id: m.id, ...patch } }); await cmRefresh(); } catch (err) { cmSay(err.message); } };
  if (m.status === 'candidate') actions.append(cmButton('Approve', 'cmApprove', act({ status: 'approved' })), cmButton('Edit', '', () => cmEdit(card, m)), cmButton('Reject', '', act({ status: 'rejected' })));
  else if (m.status === 'rejected') actions.append(cmButton('Restore', '', act({ status: 'candidate' })), cmButton('Delete', 'cmDanger', () => cmDelete(m)));
  else actions.append(cmButton('Edit', '', () => cmEdit(card, m)), cmButton('Reject', '', act({ status: 'rejected' })), cmButton('Delete', 'cmDanger', () => cmDelete(m)));
  card.appendChild(actions);
  return card;
}

function cmEdit(card, m) {
  const area = document.createElement('textarea');
  area.className = 'cmEdit';
  area.maxLength = 300;
  area.value = m.memory_text;
  const actions = document.createElement('div');
  actions.className = 'cmActions';
  actions.append(
    cmButton('Save and approve', 'cmApprove', async () => {
      try { await cmApi('cm-update', { method: 'PATCH', body: { id: m.id, memoryText: area.value } }); await cmRefresh(); }
      catch (err) { cmSay(err.message); }
    }),
    cmButton('Cancel', '', () => cmRenderList()),
  );
  card.textContent = '';
  card.append(area, actions);
  area.focus();
}

async function cmDelete(m) {
  if (!confirm('Delete this memory?')) return;
  try { await cmApi('cm-delete', { method: 'DELETE', body: { id: m.id } }); await cmRefresh(); }
  catch (err) { cmSay(err.message); }
}

function cmRenderImports(imports) {
  const box = $('cmImports');
  box.textContent = '';
  for (const imp of imports) {
    const row = document.createElement('div');
    row.className = 'cmImportRow';
    const label = document.createElement('span');
    const state = imp.status === 'analyzed' ? 'analysed' : imp.status === 'analyzing' ? 'partly analysed' : imp.status;
    label.textContent = `${imp.original_filename} · ${imp.message_count || 0} messages · ${state}`;
    row.append(label, cmButton('Remove', 'cmLinkBtn', async () => {
      if (!confirm('Remove this import and its stored chat file?')) return;
      const withMemories = confirm('Also delete the memories found in it? OK deletes them, Cancel keeps them.');
      try { await cmApi('import-delete', { method: 'DELETE', body: { importId: imp.id, deleteMemories: withMemories } }); cmSetupHide(); await cmRefresh(); }
      catch (err) { cmSay(err.message); }
    }));
    box.appendChild(row);
  }
}

function cmSetupHide() { cmImport = null; $('cmSetup').classList.add('hidden'); }

function cmShowSetup(info) {
  cmImport = info;
  $('cmSetup').classList.remove('hidden');
  const span = info.firstMessageAt ? `${info.firstMessageAt.slice(0, 10)} to ${info.lastMessageAt.slice(0, 10)}` : '';
  $('cmSummary').textContent = `${info.messageCount} messages${span ? `, ${span}` : ''}${info.hasMedia ? '. Photos, voice notes and other media are not read.' : '.'}${info.isGroup ? ' This looks like a group chat: only the two people you pick are analysed.' : ''}`;
  for (const id of ['cmContactPicker', 'cmSelfPicker']) {
    const sel = $(id);
    sel.textContent = '';
    const first = document.createElement('option');
    first.value = '';
    first.textContent = 'Choose…';
    sel.appendChild(first);
    for (const p of info.participants) {
      const o = document.createElement('option');
      o.value = p.name;
      o.textContent = `${p.name} (${p.messages})`;
      sel.appendChild(o);
    }
  }
  $('cmContactPicker').value = info.identified?.contactParticipant || '';
  $('cmSelfPicker').value = info.identified?.selfParticipant || '';
  const p = info.preview?.[0];
  $('cmDateRow').classList.toggle('hidden', !info.dateOrderAmbiguous);
  $('cmDatePreview').textContent = p ? `The first message reads as ${p.sentAt.slice(0, 10)}. Is that right?` : '';
  $('cmConsent').checked = false;
  $('cmAnalyze').disabled = false;
}

async function cmUploadAndProcess(file) {
  const init = await cmApi('import-init', { method: 'POST', body: { contactId: cmContact.id, filename: file.name, size: file.size } });
  cmSay('Uploading…');
  const up = await supabase.storage.from(init.bucket).uploadToSignedUrl(init.path, init.token, file);
  if (up.error) throw new Error('The upload failed. Check your connection and try again.');
  cmSay('Reading the chat…');
  return cmApi('import-process', { method: 'POST', body: { importId: init.importId } });
}

$('cmFile').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file || cmBusy || !cmContact) return;
  cmBusy = true;
  try {
    const info = await cmUploadAndProcess(file);
    cmSay('');
    cmShowSetup(info);
    await cmRefresh();
  } catch (err) { cmSay(err.message); }
  finally { cmBusy = false; e.target.value = ''; }
});

$('cmFlipDates').addEventListener('click', async () => {
  if (!cmImport || cmBusy) return;
  cmBusy = true;
  try {
    const next = cmImport.dateOrder === 'dmy' ? 'mdy' : 'dmy';
    const info = await cmApi('import-process', { method: 'POST', body: { importId: cmImport.importId, dateOrder: next } });
    cmShowSetup(info);
    $('cmDateRow').classList.remove('hidden');
  } catch (err) { cmSay(err.message); }
  finally { cmBusy = false; }
});

async function cmAnalyze(restart = false) {
  if (!cmImport || cmBusy) return;
  const contactParticipant = $('cmContactPicker').value;
  const selfParticipant = $('cmSelfPicker').value;
  if (!contactParticipant) { cmSay('Choose which person in the chat is this contact.'); return; }
  if (selfParticipant && selfParticipant === contactParticipant) { cmSay('Pick two different people.'); return; }
  if (!$('cmConsent').checked && !restart) { cmSay('Tick the box to let the chat text be analysed.'); return; }
  cmBusy = true;
  $('cmAnalyze').disabled = true;
  try {
    cmSay('Finding memories…');
    await cmApi('import-set-participants', { method: 'POST', body: { importId: cmImport.importId, contactParticipant, selfParticipant: selfParticipant || null } });
    const r = await cmApi('import-analyze', { method: 'POST', body: { importId: cmImport.importId, consent: true, restart } });
    await cmApi('import-index', { method: 'POST', body: { importId: cmImport.importId, consent: true } }).catch(() => null);
    cmSay(`${r.inserted} new ${r.inserted === 1 ? 'memory' : 'memories'} to review${r.done ? '.' : `. ${r.remainingWindows} parts of the chat are left.`}${r.method === 'rules' ? ' (Basic matching only: no AI service is set up.)' : ''}`);
    $('cmMore').classList.toggle('hidden', r.done);
    cmFilter = 'candidate';
    await cmRefresh();
    if (r.done) cmSetupHide();
  } catch (err) { cmSay(err.message); }
  finally { cmBusy = false; $('cmAnalyze').disabled = false; }
}
$('cmAnalyze').addEventListener('click', () => cmAnalyze(false));
$('cmMore').addEventListener('click', () => cmAnalyze(false));
document.querySelectorAll('#cmFilters .memoryFilterBtn').forEach((b) => b.addEventListener('click', () => { cmFilter = b.dataset.cmStatus; cmRenderList(); }));

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
  await ensureNotificationsEnabled({ fromTap: true });
  refreshPermissionsSheet();
  refreshNotificationsToggle();
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
const THEMES = { dark: '#0b0b0b', brave: '#090c0c' };
function applyTheme(name) {
  if (!THEMES[name]) name = 'dark';
  document.documentElement.setAttribute('data-theme', name);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEMES[name]);
  document.querySelectorAll('.themeSwatch').forEach((s) => s.classList.toggle('active', s.dataset.theme === name));
  return name;
}
document.querySelectorAll('.themeSwatch').forEach((sw) => {
  sw.addEventListener('click', () => localStorage.setItem('theme', applyTheme(sw.dataset.theme)));
});
applyTheme(localStorage.getItem('theme'));

// ---------- voice cloning ----------
async function refreshVoiceStatus() {
  const resp = await authedFetch('/api/voice-clone');
  if (!resp.ok) return;
  const { status } = await resp.json();
  const ready = status === 'ready';
  $('voiceCloneSection').style.display = ready ? 'none' : 'flex';
  $('voiceAddHead').classList.toggle('hidden', ready);
  $('voicePreviewRow').classList.toggle('hidden', !ready);
  $('voiceRecordStatus').textContent = status === 'pending' ? 'Cloning your voice…' : status === 'failed' ? 'Cloning failed.' : 'A voice you create from a recording. Emysa speaks as you.';
  loadVoicePrefs();
}

// ---------- voice settings: Standard (GPT-Live voices) + Custom (cloned voice) ----------
// Two separate choices. Standard saves live_voice_id; Custom is the cloned (Fish) voice. The call
// engine is picked automatically from which one is selected - it is never shown or chosen here.
let voicePrefs = null;                       // last saved state from the server
let voicePending = { type: 'standard', liveVoiceId: null };
const livePreviewCache = new Map();          // voice id -> object URL

const genderLabel = (g) => (g === 'masculine' ? 'Masculine' : 'Feminine');
const PLAY_SVG = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
const PAUSE_SVG = '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>';

function voiceIsDirty() {
  if (!voicePrefs) return false;
  const savedType = voicePrefs.useCustomVoice ? 'custom' : 'standard';
  if (voicePending.type !== savedType) return true;
  return voicePending.type === 'standard' && voicePending.liveVoiceId !== voicePrefs.liveVoiceId;
}

function renderVoiceSettings() {
  if (!voicePrefs) return;
  const savedName = voicePrefs.useCustomVoice ? 'Your cloned voice' : (voicePrefs.liveVoiceName || 'Not chosen yet');
  $('currentVoiceName').textContent = savedName;
  const list = $('liveVoiceList');
  list.textContent = '';
  for (const v of voicePrefs.voices) {
    const card = document.createElement('div');
    card.className = 'voiceCard' + (voicePending.type === 'standard' && voicePending.liveVoiceId === v.id ? ' selected' : '');
    card.dataset.voice = v.id;
    card.innerHTML = `<button class="playCircleBtn" aria-label="Preview ${v.name}">${PLAY_SVG}</button>
      <div class="cBody"><div class="cValue"></div><div class="voiceMeta"></div></div>
      <svg class="voiceCheck" viewBox="0 0 24 24" fill="none"><path d="M5 12.5l4.5 4.5L19 7.5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    card.querySelector('.cValue').textContent = v.name;
    card.querySelector('.voiceMeta').textContent = `${genderLabel(v.gender)} · ${v.accent} · ${v.language}`;
    card.querySelector('.playCircleBtn').addEventListener('click', (e) => { e.stopPropagation(); previewLiveVoice(v.id, e.currentTarget); });
    card.addEventListener('click', () => { haptic(); voicePending = { type: 'standard', liveVoiceId: v.id }; renderVoiceSettings(); });
    list.appendChild(card);
  }
  $('voicePreviewRow').classList.toggle('selected', voicePending.type === 'custom');
  $('voiceApplyBtn').disabled = !voiceIsDirty() || (voicePending.type === 'standard' && !voicePending.liveVoiceId);
}

async function loadVoicePrefs() {
  const resp = await authedFetch('/api/voice-clone?action=prefs');
  if (!resp.ok) return;
  voicePrefs = await resp.json();
  const custom = voicePrefs.customVoice?.ready && voicePrefs.useCustomVoice;
  voicePending = { type: custom ? 'custom' : 'standard', liveVoiceId: voicePrefs.liveVoiceId };
  renderVoiceSettings();
  prefetchLivePreviews(voicePrefs.voices || []);
}

function showVoiceTab(which) {
  document.querySelectorAll('#voiceTypeGroup .segmentedBtn').forEach((b) => b.classList.toggle('active', b.dataset.vtype === which));
  $('voicePaneStandard').classList.toggle('hidden', which !== 'standard');
  $('voicePaneCustom').classList.toggle('hidden', which !== 'custom');
}
document.querySelectorAll('#voiceTypeGroup .segmentedBtn').forEach((b) => b.addEventListener('click', () => { haptic(); showVoiceTab(b.dataset.vtype); }));
$('voicePreviewRow').addEventListener('click', () => {
  if (!voicePrefs?.customVoice?.ready) return;
  haptic(); voicePending = { ...voicePending, type: 'custom' }; renderVoiceSettings();
});

// Preset voice previews are downloaded once, kept on this device (IndexedDB, falling back to
// localStorage) and replayed from there. Bump the version to force a fresh download.
const PREVIEW_STORE = 'emysa-voice-previews-v1';
function previewDb() {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) return reject(new Error('no indexedDB'));
    const req = indexedDB.open(PREVIEW_STORE, 1);
    req.onupgradeneeded = () => req.result.createObjectStore('clips');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function previewStoreGet(id) {
  try {
    const db = await previewDb();
    const blob = await new Promise((resolve, reject) => {
      const r = db.transaction('clips').objectStore('clips').get(id);
      r.onsuccess = () => resolve(r.result || null);
      r.onerror = () => reject(r.error);
    });
    if (blob) return blob;
  } catch { /* fall through to localStorage */ }
  try {
    const b64 = localStorage.getItem(`${PREVIEW_STORE}:${id}`);
    if (b64) return new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], { type: 'audio/wav' });
  } catch { /* ignore */ }
  return null;
}
async function previewStorePut(id, blob, b64) {
  try {
    const db = await previewDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction('clips', 'readwrite');
      tx.objectStore('clips').put(blob, id);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    return;
  } catch { /* fall back */ }
  try { localStorage.setItem(`${PREVIEW_STORE}:${id}`, b64); } catch { /* storage full: stays in memory only */ }
}
const previewInflight = new Map();
function livePreviewUrl(id) {
  if (livePreviewCache.has(id)) return Promise.resolve(livePreviewCache.get(id));
  if (previewInflight.has(id)) return previewInflight.get(id);
  const job = (async () => {
    let blob = await previewStoreGet(id);
    if (!blob) {
      const resp = await authedFetch(`/api/voice-clone?action=live-preview&voice=${encodeURIComponent(id)}`);
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data.error || 'Preview unavailable');
      blob = new Blob([Uint8Array.from(atob(data.audioBase64), (c) => c.charCodeAt(0))], { type: data.mimeType || 'audio/wav' });
      await previewStorePut(id, blob, data.audioBase64);
    }
    const url = URL.createObjectURL(blob);
    livePreviewCache.set(id, url);
    return url;
  })().finally(() => previewInflight.delete(id));
  previewInflight.set(id, job);
  return job;
}
// Quietly fetch every preset preview that is not on this device yet, one at a time.
let previewPrefetchRunning = false;
async function prefetchLivePreviews(voices) {
  if (previewPrefetchRunning) return;
  previewPrefetchRunning = true;
  try {
    for (const v of voices) {
      try { await livePreviewUrl(v.id); } catch { /* try the rest; a tap will retry this one */ }
    }
  } finally { previewPrefetchRunning = false; }
}

async function previewLiveVoice(id, btn) {
  const audio = $('liveVoiceAudio');
  const status = $('voiceApplyStatus');
  if (!audio.paused && audio.dataset.voice === id) { audio.pause(); return; }
  audio.pause();
  status.textContent = '';
  try {
    if (!livePreviewCache.has(id)) btn.classList.add('loading');
    const url = await livePreviewUrl(id);
    audio.dataset.voice = id;
    audio.src = url;
    audio.onplay = () => { btn.innerHTML = PAUSE_SVG; };
    audio.onpause = audio.onended = () => { btn.innerHTML = PLAY_SVG; };
    await audio.play();
  } catch (err) {
    status.textContent = `Could not play the preview: ${err.message}`;
  } finally {
    btn.classList.remove('loading');
  }
}

$('voiceApplyBtn').addEventListener('click', async () => {
  const btn = $('voiceApplyBtn'); const status = $('voiceApplyStatus');
  btn.disabled = true; status.textContent = 'Saving…';
  const body = voicePending.type === 'custom'
    ? { useCustomVoice: true }
    : { liveVoiceId: voicePending.liveVoiceId, useCustomVoice: false };
  const resp = await authedFetch('/api/voice-clone?action=prefs', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) { status.textContent = data.error || 'Could not save.'; renderVoiceSettings(); return; }
  voicePrefs = data;
  status.textContent = 'Saved. Emysa will use this voice on your next call.';
  renderVoiceSettings();
});

async function uploadVoiceClip(blob, mimeType, statusEl = $('voiceRecordStatus')) {
  statusEl.textContent = 'Uploading…';
  const audioBase64 = await blobToBase64(blob);
  const resp = await authedFetch('/api/voice-clone', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ audioBase64, mimeType }),
  });
  const data = await resp.json().catch(() => ({}));
  statusEl.textContent = resp.ok ? 'Voice cloned.' : (data.error || 'Could not clone voice — try a longer, quieter sample.');
  if (resp.ok) {
    await authedFetch('/api/voice-clone?action=prefs', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ useCustomVoice: true }) }).catch(() => {});
    refreshVoiceStatus();
  }
}

let mediaRecorder, recordedChunks = [];
async function toggleVoiceRecording(btn, statusEl) {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.stop();
    return;
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    statusEl.textContent = 'Microphone access is needed to record.';
    return;
  }
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
    await uploadVoiceClip(blob, actualMime, statusEl);
  };
  mediaRecorder.start();
  btn.classList.add('recording');
  btn.textContent = 'Stop';
}
$('recordVoiceBtn').addEventListener('click', () => toggleVoiceRecording($('recordVoiceBtn'), $('voiceRecordStatus')));

$('uploadVoiceBtn').addEventListener('click', () => $('voiceFileInput').click());
let voiceUploadStatusEl = null; // where the next file upload reports (onboarding vs profile sheet)
$('voiceFileInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const statusEl = voiceUploadStatusEl || $('voiceRecordStatus');
  voiceUploadStatusEl = null;
  await uploadVoiceClip(file, file.type || 'audio/mpeg', statusEl);
});

$('voicePreviewBtn').addEventListener('click', async (e) => {
  e.stopPropagation();
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

$('deleteVoiceBtn').addEventListener('click', async (e) => {
  e.stopPropagation();
  if (!confirm('Delete your cloned voice? You can record a new one after.')) return;
  const btn = e.currentTarget;
  btn.disabled = true;
  try {
    const r = await authedFetch('/api/voice-clone', { method: 'DELETE' });
    if (!r.ok) throw new Error('delete failed');
    $('voicePreviewAudio').removeAttribute('src');
    setTimeout(refreshVoiceStatus, 250);
  } catch {
    $('voiceRecordStatus').textContent = 'Could not delete your voice. Please try again.';
  } finally {
    btn.disabled = false;
  }
});

$('voiceBtn').addEventListener('click', () => { openSheet('sheet-voice'); refreshVoiceStatus(); });
$('socialCallingBtn').addEventListener('click', () => { openSheet('sheet-social-calling'); loadSocialAccounts(); });

// ---------- Connected accounts (Telegram / WhatsApp) ----------
let whatsappLinking = false;
let signalLinking = false;
async function loadSocialAccounts() {
  $('telegramLoginForm').classList.add('hidden');
  $('telegramOtpForm').classList.add('hidden');
  // A refresh of the account list must not close the pairing pane mid-link.
  if (!whatsappLinking) $('whatsappQrWrap').classList.add('hidden');
  if (!signalLinking) $('signalQrWrap').classList.add('hidden');
  $('signalLoginError').textContent = '';
  $('telegramLoginError').textContent = '';
  $('whatsappLoginError').textContent = '';
  try {
    const resp = await authedFetch('/api/social-calling');
    const data = await resp.json();
    renderTelegramStatus(data.telegram);
    renderWhatsappStatus(data.whatsapp);
    renderSignalStatus(data.signal);
  } catch { /* leave defaults showing */ }
}

function renderTelegramStatus(tg) {
  const statusEl = $('telegramAccountStatus');
  const subEl = $('telegramAccountSub');
  const btn = $('telegramConnectBtn');
  if (tg?.status === 'connected') {
    statusEl.textContent = `Connected as ${friendlyAccountName(tg.displayName, 'Telegram user')}`;
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
    statusEl.textContent = `Connected as ${friendlyAccountName(wa.displayName, 'WhatsApp user')}`;
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
    if (!resp.ok) throw new Error(userError(data.error, 'Could not send code'));
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
    if (!resp.ok) throw new Error(userError(data.error, 'Could not verify code'));
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
      whatsappLinking = false;
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
  whatsappLinking = true;
  $('whatsappLoginError').textContent = 'Getting your link ready…';
  $('whatsappQrWrap').classList.remove('hidden');
  $('whatsappLinkModeGroup').querySelectorAll('.segmentedBtn').forEach((b) => b.classList.toggle('active', b.dataset.mode === 'qr'));
  $('whatsappQrPane').classList.remove('hidden');
  $('whatsappPhonePane').classList.add('hidden');
  $('whatsappPairingCodeWrap').classList.add('hidden');
  try {
    const resp = await authedFetch('/api/social-calling?action=whatsapp-start', { method: 'POST' });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Could not start WhatsApp link');
    $('whatsappLoginError').textContent = '';
    if (data.qr) $('whatsappQrImg').src = data.qr;
    if (data.status === 'connected') { whatsappLinking = false; $('whatsappQrWrap').classList.add('hidden'); loadSocialAccounts(); return; }
    watchWhatsappStatus();
  } catch (err) {
    $('whatsappLoginError').textContent = err.message;
  }
}

// ---------- Signal (QR link through the signal-bridge) ----------
let signalPollTimer = null;

function renderSignalStatus(sg) {
  const statusEl = $('signalAccountStatus');
  const subEl = $('signalAccountSub');
  const btn = $('signalConnectBtn');
  if (sg?.status === 'connected') {
    statusEl.textContent = 'Connected';
    subEl.textContent = sg.phoneLast4 ? `Ending in ${sg.phoneLast4}` : '';
    btn.textContent = 'Disconnect';
    btn.onclick = async () => {
      await authedFetch('/api/social-calling?action=signal-disconnect', { method: 'POST' });
      subEl.textContent = '';
      loadSocialAccounts();
    };
  } else {
    statusEl.textContent = 'Not connected';
    subEl.textContent = sg?.error || '';
    btn.textContent = 'Connect';
    btn.onclick = startSignalLink;
  }
}

function stopSignalLinking() {
  clearInterval(signalPollTimer);
  signalLinking = false;
  $('signalQrWrap').classList.add('hidden');
}

function watchSignalStatus() {
  clearInterval(signalPollTimer);
  const startedAt = Date.now();
  signalPollTimer = setInterval(async () => {
    try {
      const r = await authedFetch('/api/social-calling?action=signal-status');
      const d = await r.json();
      if (d.status === 'connected') { stopSignalLinking(); loadSocialAccounts(); return; }
      if (d.status === 'expired' || d.status === 'failed' || d.status === 'error' || d.status === 'disconnected') {
        stopSignalLinking();
        $('signalLoginError').textContent = d.status === 'failed' ? 'Linking failed. Tap Connect to try again.' : 'The code expired. Tap Connect to get a new one.';
        return;
      }
    } catch { /* a network blip: keep waiting */ }
    // Safety stop in case the server never reports the expiry.
    if (Date.now() - startedAt > 150_000) {
      stopSignalLinking();
      $('signalLoginError').textContent = 'The code expired. Tap Connect to get a new one.';
    }
  }, 3000);
}

async function startSignalLink() {
  signalLinking = true;
  $('signalLoginError').textContent = 'Getting your code ready…';
  $('signalQrWrap').classList.remove('hidden');
  $('signalQrImg').removeAttribute('src');
  try {
    const resp = await authedFetch('/api/social-calling?action=signal-start', { method: 'POST' });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Could not start Signal link');
    if (data.status === 'connected') { stopSignalLinking(); loadSocialAccounts(); return; }
    $('signalLoginError').textContent = '';
    $('signalQrImg').src = data.qr;
    watchSignalStatus();
  } catch (err) {
    stopSignalLinking();
    $('signalLoginError').textContent = err.message;
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

// ---------- First-run setup + calling lines ----------
// Shown inside the login screen, same panels as sign-in. Twilio (phone) exists
// only for a user who verified or rented a number; the server enforces that.
// This just walks them through getting a line, then a short profile.
let lineState = { loaded: false, line: null, channels: { phone: false, whatsapp: false, telegram: false }, rent: { enabled: false, monthlyUsd: null, countries: [] } };
let lineVerifyTimer = null;
let lineWaTimer = null;
let lineSetupVoluntary = false; // opened from Profile/menu (can go back) vs required first run

const hint = (id, text) => { $(id).textContent = text || ''; };
function stopLinePolls() {
  clearInterval(lineVerifyTimer); clearInterval(lineWaTimer); lineVerifyTimer = lineWaTimer = null;
  if (waVisibilityHandler) { document.removeEventListener('visibilitychange', waVisibilityHandler); window.removeEventListener('focus', waVisibilityHandler); waVisibilityHandler = null; }
}
let waVisibilityHandler = null;

function showSetupPanel(id) {
  $('authBoot').style.display = 'none';
  $('pendingBox').style.display = 'none';
  document.querySelectorAll('.authPanel').forEach((p) => p.classList.toggle('active', p.id === id));
  revealAuthScreen();
}

async function loadLineState() {
  try {
    const resp = await authedFetch('/api/calls?action=line-get');
    if (resp.ok) lineState = { ...(await resp.json()), loaded: true };
    else lineState.loaded = false;
  } catch { lineState.loaded = false; }
  applyChannelAvailability();
  return lineState;
}

// Only offer lines the user actually has. Anything else is hidden here and
// refused on the server. If the state could not be loaded, leave the menu
// alone rather than hiding everything.
function applyChannelAvailability() {
  if (!lineState.loaded) return;
  const { phone, whatsapp } = lineState.channels;
  const show = (sel, on) => document.querySelector(sel)?.classList.toggle('hidden', !on);
  show('.callChannelItem[data-channel="phone"]', phone);
  show('.callChannelItem[data-channel="whatsapp"]', whatsapp);
  show('.callChannelItem[data-channel="telegram"]', TELEGRAM_ENABLED);
  show('#channelSetupItem', !(phone && whatsapp));
  show('#telegramAccountCard', TELEGRAM_ENABLED);
  const stale = (selectedCallChannel === 'phone' && !phone) || (selectedCallChannel === 'whatsapp' && !whatsapp)
    || (selectedCallChannel === 'telegram' && !TELEGRAM_ENABLED);
  if (stale) {
    selectedCallChannel = null;
    try { localStorage.setItem(CALL_CHANNEL_KEY, ''); } catch {}
    $('channelBadge').classList.remove('visible');
    $('briefInput').placeholder = CHANNEL_META.phone.placeholder;
  }
  const parts = [];
  if (phone) parts.push(lineState.line?.mode === 'rent' ? 'Rented number' : 'Your number');
  if (whatsapp) parts.push('WhatsApp');
  $('callingLinesSub').textContent = parts.length ? parts.join(' and ') : 'Not set up yet';
}

async function lineApi(action, { method = 'GET', body, query = '' } = {}) {
  const resp = await authedFetch(`/api/calls?action=${action}${query}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(userError(data.error, 'Something went wrong. Please try again.'));
  return data;
}

// Which setup page is needed, if any. A failed load never traps the user:
// unknown state means no gate (the server still refuses Twilio without a line).
async function onboardingStep() {
  await loadLineState();
  if (lineState.loaded && !lineState.channels.phone && !lineState.channels.whatsapp && !lineState.channels.telegram) return 'line';
  try {
    const { data, error } = await supabase.from('profiles').select('setup_completed').eq('user_id', currentUser.id).maybeSingle();
    if (!error && data && data.setup_completed === false) return 'profile';
  } catch { /* column missing until sql/022 is applied: do not block */ }
  return null;
}

function showOnboardingStep(step) {
  lineSetupVoluntary = false;
  if (step === 'profile') return showProfileSetup();
  return showLineSetup();
}

function showLineSetup() {
  stopLinePolls();
  $('lineSetupBack').classList.toggle('hidden', !lineSetupVoluntary);
  hint('lineNumHint', '');
  const rent = lineState.rent || {};
  $('lineRentBtn').disabled = !rent.enabled;
  $('lineRentTag').textContent = rent.enabled ? 'Highly recommended' : 'Coming soon';
  const usable = lineState.line && ['verified', 'rented'].includes(lineState.line.status);
  $('lineCurrentRow').classList.toggle('hidden', !(lineSetupVoluntary && usable));
  if (usable) $('lineCurrentNum').textContent = lineState.line.phoneNumber;
  showSetupPanel('panelLineSetup');
  // A verification call may still be waiting from before a reload.
  if (!lineSetupVoluntary && lineState.line?.status === 'pending' && lineState.line.mode === 'own') showLineCode(lineState.line);
}

// Required step finished: re-evaluate (may lead on to the profile step).
async function lineStepDone() {
  stopLinePolls();
  await loadLineState();
  if (lineSetupVoluntary) { authScreen.classList.add('hidden'); return; }
  enterApp(currentSession);
}

function openLineSetup() { lineSetupVoluntary = true; loadLineState().then(showLineSetup); }
$('callingLinesBtn').addEventListener('click', openLineSetup);
$('lineSetupBack').addEventListener('click', () => {
  stopLinePolls();
  authScreen.classList.add('hidden');
  // Opened voluntarily means it was opened from Connected accounts (Profile) —
  // return there instead of wherever hiding authScreen happens to reveal.
  if (lineSetupVoluntary) openSheet('sheet-social-calling');
});
$('lineRemoveLink').addEventListener('click', async () => {
  const rented = lineState.line?.mode === 'rent';
  if (!confirm(rented ? 'Release your rented number? You will lose it.' : 'Remove your verified number?')) return;
  try { await lineApi('line-remove', { method: 'POST', body: {} }); await loadLineState(); showLineSetup(); }
  catch (err) { hint('lineNumHint', err.message); }
});

// -- own number: submit, then a separate page shows the code
function showLineCode(line) {
  $('lineCodeSub').textContent = `You will get a call on ${line.phoneNumber}. Answer it and enter this code on your keypad.`;
  $('lineCodeValue').textContent = (line.validationCode || '').split('').join(' ') || '------';
  hint('lineCodeHint', 'Waiting for you to enter the code…');
  showSetupPanel('panelLineCode');
  clearInterval(lineVerifyTimer);
  let tries = 0;
  lineVerifyTimer = setInterval(async () => {
    tries += 1;
    try {
      const r = await lineApi('line-verify-status');
      if (r.line?.status === 'verified') { clearInterval(lineVerifyTimer); lineStepDone(); }
      else if (tries >= 45) { clearInterval(lineVerifyTimer); hint('lineCodeHint', 'No code received. Tap "Call me again".'); }
    } catch (err) { clearInterval(lineVerifyTimer); hint('lineCodeHint', err.message); }
  }, 4000);
}
async function startOwnVerification(phone) {
  const { line } = await lineApi('line-verify-start', { method: 'POST', body: { phone } });
  showLineCode(line);
}
$('lineNumSubmit').addEventListener('click', async () => {
  const phone = $('lineNumInput').value.trim();
  if (!phone) { hint('lineNumHint', 'Enter your number with country code, e.g. +2348012345678.'); return; }
  $('lineNumSubmit').disabled = true;
  hint('lineNumHint', '');
  try { await startOwnVerification(phone); } catch (err) { hint('lineNumHint', err.message); }
  finally { $('lineNumSubmit').disabled = false; }
});
$('lineCodeResend').addEventListener('click', async () => {
  const phone = lineState.line?.phoneNumber || $('lineNumInput').value.trim();
  $('lineCodeResend').disabled = true;
  try { await startOwnVerification(phone); } catch (err) { hint('lineCodeHint', err.message); }
  finally { $('lineCodeResend').disabled = false; }
});
$('lineCodeBack').addEventListener('click', () => { stopLinePolls(); showLineSetup(); });

// -- rent
$('lineRentBtn').addEventListener('click', () => {
  const rent = lineState.rent || {};
  if (!rent.enabled) return;
  $('rentSub').textContent = `$${Number(rent.monthlyUsd).toFixed(2)} / month`;
  const sel = $('rentCountry');
  sel.textContent = '';
  (rent.countries || []).forEach((c) => { const o = document.createElement('option'); o.value = c; o.textContent = countryName(c); sel.appendChild(o); });
  $('rentResults').textContent = '';
  hint('rentHint', '');
  showSetupPanel('panelRent');
});
$('rentBack').addEventListener('click', showLineSetup);
$('rentSearchBtn').addEventListener('click', async () => {
  $('rentSearchBtn').disabled = true;
  hint('rentHint', '');
  $('rentResults').textContent = '';
  try {
    const q = `&country=${encodeURIComponent($('rentCountry').value || 'US')}&areaCode=${encodeURIComponent($('rentAreaCode').value.trim())}`;
    const { numbers } = await lineApi('line-rent-search', { query: q });
    if (!numbers.length) { hint('rentHint', 'No numbers found. Try another area code.'); return; }
    const price = Number(lineState.rent.monthlyUsd).toFixed(2);
    numbers.forEach((n) => {
      const row = document.createElement('div');
      row.className = 'rentItem';
      const info = document.createElement('div');
      const num = document.createElement('div'); num.className = 'rentNum'; num.textContent = n.phoneNumber;
      const where = document.createElement('div'); where.className = 'rentWhere'; where.textContent = [n.locality, n.region].filter(Boolean).join(', ');
      info.append(num, where);
      const btn = document.createElement('button');
      btn.className = 'secondaryBtn'; btn.type = 'button'; btn.textContent = 'Rent';
      btn.addEventListener('click', async () => {
        if (!confirm(`Rent ${n.phoneNumber} for $${price} / month?`)) return;
        btn.disabled = true;
        try { await lineApi('line-rent-buy', { method: 'POST', body: { phoneNumber: n.phoneNumber } }); lineStepDone(); }
        catch (err) { hint('rentHint', err.message); btn.disabled = false; }
      });
      row.append(info, btn);
      $('rentResults').appendChild(row);
    });
  } catch (err) { hint('rentHint', err.message); }
  finally { $('rentSearchBtn').disabled = false; }
});

// -- pairing code display: one contained box (two groups of cells, never wraps) + copy
function renderPairCode(el, code) {
  const raw = String(code || '').trim();
  el.dataset.code = raw;
  el.textContent = '';
  if (!raw) {
    const w = document.createElement('span'); w.className = 'pw'; w.textContent = 'Getting your code…';
    el.appendChild(w);
    return;
  }
  const clean = raw.replace(/[\s-]/g, '');
  const half = Math.ceil(clean.length / 2);
  const groups = raw.includes('-') ? raw.split('-') : [clean.slice(0, half), clean.slice(half)];
  groups.forEach((g, i) => {
    if (i) { const d = document.createElement('span'); d.className = 'pd'; d.textContent = '–'; el.appendChild(d); }
    [...g].forEach((ch) => { const c = document.createElement('span'); c.className = 'pc'; c.textContent = ch; el.appendChild(c); });
  });
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* fall through (older iOS / PWA) */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;font-size:16px;';
    document.body.appendChild(ta); ta.focus(); ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch { return false; }
}

$('waCodeCopy').addEventListener('click', async () => {
  const code = $('waCodeValue').dataset.code;
  if (!code) return;
  const label = $('waCodeCopy').querySelector('span');
  const ok = await copyText(code);
  label.textContent = ok ? 'Copied' : 'Press and hold the code to copy';
  setTimeout(() => { label.textContent = 'Copy code'; }, 2000);
});

// -- WhatsApp: number page, then a separate page with the pairing code
$('lineWaBtn').addEventListener('click', () => { hint('waNumHint', ''); showSetupPanel('panelWaNumber'); });
$('waNumBack').addEventListener('click', showLineSetup);
$('waCodeBack').addEventListener('click', () => { stopLinePolls(); showSetupPanel('panelWaNumber'); });

function showWaCode(code) {
  renderPairCode($('waCodeValue'), code);
  $('waCodeCopy').disabled = !code;
}

// One status check. Used by the timer, by coming back to the app (iOS freezes a
// backgrounded page while you type the code into WhatsApp, so the timer alone is
// not enough) and by the "I've linked it" button. Failures are shown, not swallowed.
let waChecking = false;
let waFailStreak = 0;
async function checkWaLinked({ manual = false } = {}) {
  if (waChecking) return;
  waChecking = true;
  if (manual) { $('waCodeCheck').disabled = true; hint('waCodeHint', 'Checking…'); }
  try {
    const r = await authedFetch('/api/social-calling?action=whatsapp-status');
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `Status check failed (${r.status})`);
    waFailStreak = 0;
    if (d.pairingCode) showWaCode(d.pairingCode);
    if (d.status === 'connected') { stopLinePolls(); await lineStepDone(); return; }
    if (d.status === 'disconnected') {
      stopLinePolls();
      hint('waCodeHint', 'This link expired. Go back and get a new code.');
      return;
    }
    hint('waCodeHint', manual ? 'Not linked yet. Enter the code in WhatsApp, then tap again.' : 'Waiting for you to link…');
  } catch (err) {
    waFailStreak += 1;
    if (manual || waFailStreak >= 3) hint('waCodeHint', `Can't reach the server (${err.message}). Retrying…`);
  } finally {
    waChecking = false;
    $('waCodeCheck').disabled = false;
  }
}
$('waCodeCheck').addEventListener('click', () => checkWaLinked({ manual: true }));

$('waNumSubmit').addEventListener('click', async () => {
  const phone = $('waNumInput').value.trim();
  if (!phone) { hint('waNumHint', 'Enter your WhatsApp number first.'); return; }
  $('waNumSubmit').disabled = true;
  hint('waNumHint', '');
  try {
    const resp = await authedFetch('/api/social-calling?action=whatsapp-start-phone', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.error || 'Could not get a pairing code');
    if (data.status === 'connected') { lineStepDone(); return; }
    showWaCode(data.pairingCode || '');
    hint('waCodeHint', 'Waiting for you to link…');
    showSetupPanel('panelWaCode');
    stopLinePolls();
    waFailStreak = 0;
    lineWaTimer = setInterval(() => checkWaLinked(), 3000);
    waVisibilityHandler = () => { if (!document.hidden) checkWaLinked(); };
    document.addEventListener('visibilitychange', waVisibilityHandler);
    window.addEventListener('focus', waVisibilityHandler);
  } catch (err) { hint('waNumHint', err.message); }
  finally { $('waNumSubmit').disabled = false; }
});

// -- Telegram: number page, then a code page (plus 2FA password if the account has one)
$('lineTgBtn').addEventListener('click', () => { hint('tgNumHint', ''); showSetupPanel('panelTgNumber'); });
$('tgNumBack').addEventListener('click', showLineSetup);
$('tgCodeBack').addEventListener('click', () => showSetupPanel('panelTgNumber'));
$('tgNumSubmit').addEventListener('click', async () => {
  const phone = $('tgNumInput').value.trim();
  if (!phone) { hint('tgNumHint', 'Enter your Telegram number first.'); return; }
  $('tgNumSubmit').disabled = true;
  hint('tgNumHint', '');
  try {
    const resp = await authedFetch('/api/social-calling?action=telegram-start', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(userError(data.error, 'Could not send the code'));
    $('tgCodeInput').value = ''; $('tgPasswordInput').value = '';
    $('tgPasswordField').classList.add('hidden');
    hint('tgCodeHint', '');
    showSetupPanel('panelTgCode');
  } catch (err) { hint('tgNumHint', err.message); }
  finally { $('tgNumSubmit').disabled = false; }
});
$('tgCodeSubmit').addEventListener('click', async () => {
  const code = $('tgCodeInput').value.trim();
  const password = $('tgPasswordInput').value;
  const needPw = !$('tgPasswordField').classList.contains('hidden');
  if (!needPw && !code) { hint('tgCodeHint', 'Enter the code Telegram sent you.'); return; }
  if (needPw && !password.trim()) { hint('tgCodeHint', 'Enter your Telegram 2FA password.'); return; }
  $('tgCodeSubmit').disabled = true;
  hint('tgCodeHint', '');
  try {
    // Same two-step contract as the Connected accounts screen: code first, then password alone.
    const resp = await authedFetch('/api/social-calling?action=telegram-verify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(needPw ? { password } : { code }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(userError(data.error, 'Could not verify the code'));
    if (data.status === 'needs_password') {
      $('tgPasswordField').classList.remove('hidden');
      hint('tgCodeHint', 'This account has 2FA. Enter your Telegram password.');
      return;
    }
    await lineStepDone();
  } catch (err) { hint('tgCodeHint', err.message); }
  finally { $('tgCodeSubmit').disabled = false; }
});

// -- profile step: name, language, country (voice optional)
const COUNTRY_CODES = 'AD AE AF AG AI AL AM AO AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GT GU GW GY HK HN HR HT HU ID IE IL IM IN IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW'.split(' ');
let regionNames = null;
try { regionNames = new Intl.DisplayNames(['en'], { type: 'region' }); } catch { /* old browser: show codes */ }
function countryName(code) { try { return regionNames?.of(code) || code; } catch { return code; } }

function showProfileSetup() {
  const lang = $('psLanguage');
  if (!lang.options.length) lang.innerHTML = $('profileLanguage').innerHTML;
  const country = $('psCountry');
  if (!country.options.length) {
    const ph = document.createElement('option'); ph.value = ''; ph.textContent = 'Select country'; country.appendChild(ph);
    COUNTRY_CODES.map((c) => ({ c, n: countryName(c) })).sort((a, b) => a.n.localeCompare(b.n))
      .forEach(({ c, n }) => { const o = document.createElement('option'); o.value = c; o.textContent = n; country.appendChild(o); });
    const guess = (navigator.language || '').split('-')[1]?.toUpperCase();
    if (guess && COUNTRY_CODES.includes(guess)) country.value = guess;
  }
  if (!$('psName').value) $('psName').value = currentUser?.user_metadata?.full_name || currentUser?.user_metadata?.name || '';
  hint('psHint', '');
  showSetupPanel('panelProfileSetup');
}
$('psRecordBtn').addEventListener('click', () => toggleVoiceRecording($('psRecordBtn'), $('psHint')));
$('psUploadBtn').addEventListener('click', () => { voiceUploadStatusEl = $('psHint'); $('voiceFileInput').click(); });
$('psSubmit').addEventListener('click', async () => {
  const name = $('psName').value.trim();
  const country = $('psCountry').value;
  if (!name) { hint('psHint', 'Enter your name.'); return; }
  if (!country) { hint('psHint', 'Select your country.'); return; }
  $('psSubmit').disabled = true;
  const { error } = await supabase.from('profiles').upsert(
    { user_id: currentUser.id, name, language: $('psLanguage').value, country, setup_completed: true },
    { onConflict: 'user_id' },
  );
  $('psSubmit').disabled = false;
  if (error) { hint('psHint', 'Could not save. Please try again.'); return; }
  enterApp(currentSession);
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
  try { localStorage.setItem('emysa.authBgUrls', JSON.stringify(authBgUrls)); } catch {}

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


// ---------- Cookie consent + notification permission on install ----------
// iOS only shows the notification prompt from a tap, so in an installed app the
// consent button's tap is where we ask. If consent was already given (e.g. in the
// browser before installing) the first tap anywhere in the installed app asks instead.
const COOKIE_CONSENT_KEY = 'emysa.cookieConsent';

function notificationsAskable() {
  return isStandalonePWA() && 'Notification' in window && Notification.permission === 'default';
}

async function askNotificationsOnInstall() {
  if (!notificationsAskable()) return;
  try { await Notification.requestPermission(); } catch {}
  // Subscribes if granted and signed in; after sign-in the normal app-open
  // check does it, since permission is then already granted.
  ensureNotificationsEnabled();
}

(function initCookieConsent() {
  let consented = false;
  try { consented = !!localStorage.getItem(COOKIE_CONSENT_KEY); } catch {}
  const banner = $('cookieBanner');
  $('cookiePrivacyLink').addEventListener('click', () => openSheet('sheet-privacy'));
  $('cookieOk').addEventListener('click', () => {
    try { localStorage.setItem(COOKIE_CONSENT_KEY, new Date().toISOString()); } catch {}
    banner.classList.add('hidden');
    askNotificationsOnInstall();
  });
  if (!consented) banner.classList.remove('hidden');
  else if (notificationsAskable()) document.addEventListener('pointerup', askNotificationsOnInstall, { once: true });
})();
