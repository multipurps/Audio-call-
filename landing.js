/* Public story only. The signed-in app remains at /index.html. */
'use strict';

// Keep referral links usable now that / resolves to this page on Vercel.
const referral = new URLSearchParams(location.search).get('ref');
if (referral && /^[A-Za-z0-9_-]{1,64}$/.test(referral)) {
  document.querySelectorAll('a[href="/index.html"]').forEach((a) => { a.href = `/index.html?ref=${encodeURIComponent(referral)}`; });
}

// Config is served by an existing API function; the administrator edits it via
// signed Supabase Storage uploads. Nothing from the response becomes HTML.
const allowedMedia = (value) => {
  try {
    const url = new URL(value, location.origin);
    return url.protocol === 'https:' &&
      (url.origin === location.origin || url.hostname === 'gucblbvfzuraaozswfwd.supabase.co') ? url.href : null;
  } catch { return null; }
};
const mediaBySlot = new Map();
async function loadMedia() {
  try {
    const response = await fetch('/api/admin?action=landing-media');
    if (!response.ok) return;
    const { media } = await response.json();
    for (const row of media || []) {
      if (!allowedMedia(row.url)) continue;
      if (!mediaBySlot.has(row.slot)) mediaBySlot.set(row.slot, []);
      mediaBySlot.get(row.slot).push(row);
    }
    document.querySelectorAll('.scene[data-background]').forEach((scene) => {
      const bg = mediaBySlot.get(scene.dataset.background)?.[0];
      const overlay = mediaBySlot.get(scene.dataset.overlay)?.[0];
      if (bg) {
        const img = document.createElement('img');
        img.src = allowedMedia(bg.url);
        img.alt = '';
        img.className = 'scene-bg';
        img.decoding = 'async';
        img.loading = scene.classList.contains('hero-visual') ? 'eager' : 'lazy';
        if (scene.classList.contains('hero-visual')) img.fetchPriority = 'high';
        img.addEventListener('load', () => {
          const base = scene.querySelector('.scene-base');
          base.replaceChildren(img);
          base.classList.add('media-loaded');
        }, { once: true });
      }
      if (overlay) {
        const image = document.createElement('img');
        image.src = allowedMedia(overlay.url);
        image.alt = scene.getAttribute('aria-label') + ' screenshot';
        image.className = 'scene-overlay overlay-image';
        image.loading = scene.classList.contains('hero-visual') ? 'eager' : 'lazy';
        image.decoding = 'async';
        image.addEventListener('load', () => scene.querySelector('.scene-overlay')?.replaceWith(image), { once: true });
      }
    });
    const orb = mediaBySlot.get('voice_orb')?.[0];
    if (orb) {
      const image = document.createElement('img');
      image.src = allowedMedia(orb.url);
      image.alt = 'Animated Emysa voice introduction orb';
      image.loading = 'lazy';
      image.decoding = 'async';
      image.addEventListener('load', () => document.querySelector('.orb-fallback')?.replaceWith(image), { once: true });
    }
    for (const [slot, id] of [['call_screenshots', 'callGallery'], ['feature_media', 'featureGallery']]) {
      const rows = mediaBySlot.get(slot) || [];
      if (!rows.length) continue;
      const gallery = document.getElementById(id);
      gallery.replaceChildren();
      rows.forEach((row, index) => {
        const figure = document.createElement('figure');
        const img = document.createElement('img');
        img.src = allowedMedia(row.url);
        img.loading = 'lazy';
        img.decoding = 'async';
        img.alt = `${slot === 'call_screenshots' ? 'Emysa call interface' : 'Emysa feature'} visual ${index + 1}`;
        figure.append(img);
        gallery.append(figure);
      });
    }
    const video = mediaBySlot.get('demo_video')?.[0];
    if (video) {
      const el = document.createElement('video');
      el.src = allowedMedia(video.url);
      el.controls = true;
      el.muted = true;
      el.playsInline = true;
      el.preload = 'none';
      el.setAttribute('aria-label', 'Emysa demonstration video');
      document.getElementById('demoVideo').append(el);
    }
  } catch { /* Deliberate local fallbacks stay visible if content API is unavailable. */ }
}
loadMedia();

if ('IntersectionObserver' in window && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
  document.documentElement.classList.add('js-reveal');
  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) { entry.target.classList.add('in-view'); observer.unobserve(entry.target); }
    });
  }, { rootMargin: '0px 0px 20px 0px', threshold: .06 });
  document.querySelectorAll('.section-reveal').forEach((node) => observer.observe(node));
}

const audio = document.getElementById('introductionAudio');
const toggle = document.getElementById('audioToggle');
const status = document.getElementById('audioState');
const progress = document.getElementById('audioSeek');
const orbStage = document.getElementById('orbStage');
const time = (value) => Number.isFinite(value) ? `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, '0')}` : '0:00';
const updateAudio = () => {
  document.getElementById('audioCurrent').textContent = time(audio.currentTime);
  document.getElementById('audioDuration').textContent = time(audio.duration);
  if (Number.isFinite(audio.duration) && audio.duration > 0) progress.value = String(Math.round(audio.currentTime / audio.duration * 100));
  const playing = !audio.paused && !audio.ended;
  orbStage.classList.toggle('playing', playing);
  document.getElementById('orbIndicator').textContent = playing ? 'PLAYING' : 'READY';
  toggle.textContent = playing ? 'Ⅱ' : '▶';
  toggle.setAttribute('aria-label', playing ? "Pause Emysa's introduction" : "Play Emysa's introduction");
  if (playing) status.textContent = 'Now playing';
};
for (const event of ['play', 'pause', 'timeupdate', 'loadedmetadata', 'durationchange']) audio.addEventListener(event, updateAudio);
audio.addEventListener('ended', () => {
  try { localStorage.setItem('emysa_intro_seen', '1'); } catch {}
  status.textContent = 'Introduction finished. Play again any time.';
  updateAudio();
});
audio.addEventListener('error', () => { status.textContent = 'Audio could not load. Please try again later.'; });
const play = async () => {
  try { await audio.play(); }
  catch { status.textContent = 'Tap play to listen to Emysa.'; updateAudio(); }
};
toggle.addEventListener('click', () => { if (audio.paused) play(); else audio.pause(); });
progress.addEventListener('input', () => {
  if (Number.isFinite(audio.duration)) audio.currentTime = Number(progress.value) / 100 * audio.duration;
});
// Attempt once in this tab on the first visit. An autoplay rejection must never
// attach a global tap listener: the visitor chooses when to play next.
let shouldAttempt = false;
try {
  shouldAttempt = !localStorage.getItem('emysa_intro_seen') && !sessionStorage.getItem('emysa_landing_intro_attempted');
  if (shouldAttempt) sessionStorage.setItem('emysa_landing_intro_attempted', '1');
} catch { /* storage may be unavailable in private contexts */ }
if (shouldAttempt) play();
fetch('/assets/intro/intro.json').then((r) => { if (!r.ok) throw Error('Transcript unavailable'); return r.json(); })
  .then((data) => {
    const wrap = document.getElementById('transcriptText');
    wrap.replaceChildren();
    for (const line of data.lines || []) {
      const p = document.createElement('p');
      p.textContent = line.text;
      wrap.append(p);
    }
  }).catch(() => { document.getElementById('transcriptText').textContent = 'Transcript could not be loaded right now.'; });

// add-to-homescreen v4.6.0: create on page load; .show() only on intent.
// It handles iOS versions, iPad, social in-app browsers and desktop Safari.
let installGuide;
try {
  if (typeof window.AddToHomeScreen === 'function') installGuide = window.AddToHomeScreen({
    appName: 'Emysa', appIconUrl: '/apple-touch-icon.png',
    assetUrl: '/vendor/adhs/assets/img/', maxModalDisplayCount: -1,
    displayOptions: { showMobile: true, showDesktop: true }, allowClose: true,
    showArrow: false,
  });
} catch { /* platform fallback below */ }
let installPrompt = null;
window.addEventListener('beforeinstallprompt', (event) => { event.preventDefault(); installPrompt = event; });
window.addEventListener('appinstalled', () => { installPrompt = null; if (installGuide?.modalIsShowing()) installGuide.closeModal(); });
const installed = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true || matchMedia('(display-mode: fullscreen)').matches;
const dialog = document.getElementById('installDialog');
const showFallback = (message, title = 'Install Emysa') => {
  document.getElementById('installTitle').textContent = title;
  document.getElementById('installMessage').textContent = message;
  if (!dialog.open) dialog.showModal();
};
document.getElementById('closeInstall').addEventListener('click', () => dialog.close());
dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });
async function install() {
  if (installed()) return showFallback('Emysa is already open as an installed app. You can start using it now.', 'Emysa is installed');
  if (installPrompt) {
    const prompt = installPrompt;
    installPrompt = null;
    try { await prompt.prompt(); await prompt.userChoice; return; }
    catch { /* Use guide below if the native event is no longer valid. */ }
  }
  if (installGuide) {
    try {
      const info = installGuide.show('en');
      if (installGuide.modalIsShowing()) return;
      // The desktop guide may open asynchronously while waiting for the
      // browser's prompt; avoid an overlapping dialog in that case.
      if (/Chrome|Edg/i.test(navigator.userAgent) && !/Android|iPhone|iPad/i.test(navigator.userAgent)) {
        setTimeout(() => {
          if (!installed() && !installGuide.modalIsShowing() && !dialog.open) showFallback('Use your browser’s install icon or menu to install Emysa. If installation is unavailable, you can still open Emysa in your browser.');
        }, 2300);
        return;
      }
    } catch { /* Give actionable generic guidance below. */ }
  }
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/i.test(ua)) showFallback('Open this page in Safari. Tap Share, then Add to Home Screen. If you are in an in-app browser, use its menu to open in Safari first.');
  else if (/Android/i.test(ua)) showFallback('Open this page in your system browser, then choose Install app or Add to Home screen from the browser menu. If you are in another app, open its menu and choose Open in browser first.');
  else showFallback('Use your browser’s install icon or menu to install Emysa. On Safari for Mac, choose Add to Dock from the File menu. If installation is unavailable, you can still open Emysa in your browser.');
}
document.querySelectorAll('.install-action').forEach((button) => button.addEventListener('click', install));
if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
