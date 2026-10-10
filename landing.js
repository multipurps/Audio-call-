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
// Autoplay on load. Browsers block sound until the visitor interacts, so if the
// attempt is refused the introduction starts on the first touch, click, key or scroll.
audio.play().catch(() => {
  const go = () => { audio.play().catch(() => {}); ['pointerdown', 'keydown', 'touchstart', 'wheel'].forEach((t) => removeEventListener(t, go)); };
  ['pointerdown', 'keydown', 'touchstart', 'wheel'].forEach((t) => addEventListener(t, go, { passive: true }));
});
fetch('/assets/intro/intro.json').then((r) => { if (!r.ok) throw Error('Transcript unavailable'); return r.json(); })
  .then((data) => {
    const wrap = document.getElementById('transcriptText');
    wrap.replaceChildren();
    for (const line of data.lines || []) {
      const p = document.createElement('p');
      p.textContent = line.text;
      p.dataset.start = line.words?.[0]?.start ?? 0; p.dataset.end = line.words?.at(-1)?.end ?? 0;
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

audio.addEventListener('timeupdate', () => {
  document.querySelectorAll('#transcriptText p[data-start]').forEach((p) => p.classList.toggle('now', audio.currentTime >= p.dataset.start - .2 && audio.currentTime <= +p.dataset.end + .5));
});
// Menu, sticky header controls
const burger = document.getElementById('burger'), menu = document.getElementById('menu');
const setMenu = (o) => { menu.classList.toggle('open', o); burger.setAttribute('aria-expanded', o); document.body.style.overflow = o ? 'hidden' : ''; };
burger.addEventListener('click', () => setMenu(!menu.classList.contains('open')));
menu.addEventListener('click', (e) => { if (e.target.closest('a,button')) setMenu(false); });
addEventListener('keydown', (e) => { if (e.key === 'Escape') setMenu(false); });
// Fit the outlined footer wordmark to the full width
const fit = () => { const w = document.getElementById('footMark'), s = w.firstElementChild; s.style.fontSize = '100px'; s.style.fontSize = (100 * w.clientWidth / s.getBoundingClientRect().width) + 'px'; };
document.fonts.ready.then(fit); addEventListener('resize', fit);

// Hero background: the login-screen backgrounds (video first, then crossfading images), no overlay
(async () => {
  const KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imd1Y2JsYnZmenVyYWFvenN3ZndkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU0NzQ0ODQsImV4cCI6MjA5MTA1MDQ4NH0.OCsEC_FfOJmoL5sQWP8zYnw9SmWuy4xggfcpIIxQw-c';
  let rows = [];
  try {
    const r = await fetch('https://gucblbvfzuraaozswfwd.supabase.co/rest/v1/auth_backgrounds?select=url,media_type&order=created_at.asc', { headers: { apikey: KEY, Authorization: 'Bearer ' + KEY } });
    rows = r.ok ? await r.json() : [];
  } catch {}
  rows = rows.filter((x) => allowedMedia(x.url));
  const vids = rows.filter((x) => x.media_type === 'video').map((x) => allowedMedia(x.url));
  const imgs = rows.filter((x) => x.media_type !== 'video').map((x) => allowedMedia(x.url));
  if (vids.length) {
    const v = document.querySelector('.bg-v'); let i = 0;
    const next = () => { v.src = vids[i++ % vids.length]; v.loop = vids.length === 1; v.play().catch(() => {}); };
    v.addEventListener('ended', next); v.addEventListener('playing', () => v.classList.add('on'), { once: true }); next();
  } else if (imgs.length) {
    const layers = [document.querySelector('.bg-a'), document.querySelector('.bg-b')]; let i = 0, a = 0;
    const show = () => { const n = 1 - a; layers[n].style.backgroundImage = `url('${imgs[i % imgs.length]}')`; layers[n].classList.add('on'); layers[a].classList.remove('on'); a = n; i++; };
    show(); if (imgs.length > 1) setInterval(show, 6000);
  }
})();
