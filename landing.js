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
const mk = (tag, props) => Object.assign(document.createElement(tag), props);
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
    const isImg = (r) => !/\.(mp4|webm|mov)(\?|$)/i.test(r.url) && r.media_type !== 'video';
    const slotImg = (row, alt, i = 0) => mk('img', { src: allowedMedia(row.url), alt, loading: 'lazy', decoding: 'async' });
    // A feature uses its own slot first. Older uploads (made before the per-feature slots existed) are paired
    // by meaning so nothing sits in a separate row: hero screenshot -> how it works, objective -> calls,
    // conversation -> live call, first call screenshot -> call summary.
    const legacy = { how_it_works: ['hero_overlay', 0], calls_for_you: ['objective_overlay', 0], live_call_video: ['conversation_overlay', 0], call_summary: ['call_screenshots', 0] };
    const used = new Set();
    const pick = (slot) => {
      const own = (mediaBySlot.get(slot) || []).find(isImg); if (own) return own;
      const lg = legacy[slot]; const r = lg && (mediaBySlot.get(lg[0]) || []).filter(isImg)[lg[1]];
      if (r) used.add(r); return r;
    };
    const show = (ph, node, row) => {
      ph.replaceChildren(node); ph.classList.add('has-shot'); ph.parentElement.hidden = false; ph.closest('.feature').classList.remove('nophone');
      if (row) ph.parentElement.prepend(mk('img', { src: allowedMedia(row.url), alt: '', className: 'halo', decoding: 'async' }));
    };
    document.querySelectorAll('.phone[data-slot]').forEach((ph) => {
      const row = pick(ph.dataset.slot); if (!row) return;
      show(ph, slotImg(row, ph.getAttribute('aria-label')), row);
    });
    // Live call: a video (its own slot, or the demonstration video slot) plays muted while visible, pauses when
    // scrolled away; tap for sound. The conversation screenshot becomes its poster.
    const lv = mediaBySlot.get('live_call_video')?.[0] || mediaBySlot.get('demo_video')?.[0];
    let demoUsed = false;
    if (lv) {
      demoUsed = !mediaBySlot.get('live_call_video')?.[0];
      const ph = document.getElementById('ph-live_call_video');
      const poster = pick('live_call_video');
      const v = mk('video', { src: allowedMedia(lv.url), muted: true, loop: true, playsInline: true, preload: 'auto' });
      if (poster) v.poster = allowedMedia(poster.url);
      v.setAttribute('muted', ''); v.setAttribute('playsinline', '');
      const snd = mk('button', { type: 'button', className: 'vsound', textContent: 'Tap for sound' });
      snd.addEventListener('click', () => { v.muted = !v.muted; snd.textContent = v.muted ? 'Tap for sound' : 'Sound on'; });
      v.addEventListener('loadedmetadata', () => { if (v.videoWidth > v.videoHeight) ph.classList.add('wide'); });
      ph.replaceChildren(v, snd); ph.classList.add('has-shot'); ph.parentElement.hidden = false; ph.closest('.feature').classList.remove('nophone');
      new IntersectionObserver((es) => es.forEach((en) => { if (en.isIntersecting) v.play().catch(() => {}); else v.pause(); }), { threshold: .4 }).observe(ph);
    }
    // Whatever is left over (not paired to a feature) goes in the swipe row.
    const extras = ['hero_overlay', 'objective_overlay', 'conversation_overlay', 'call_screenshots', 'feature_media'].flatMap((s) => mediaBySlot.get(s) || []).filter((r) => isImg(r) && !used.has(r));
    if (extras.length) {
      document.getElementById('moreShots').replaceChildren(...extras.map((r, i) => { const f = mk('figure', { className: 'shot' }); f.append(slotImg(r, `Emysa app screenshot ${i + 1}`)); return f; }));
      document.querySelector('.appshots').hidden = false;
    }
    const dv = mediaBySlot.get('demo_video')?.[0];
    if (dv && !demoUsed) { document.getElementById('demoVideo').append(mk('video', { src: allowedMedia(dv.url), controls: true, playsInline: true, preload: 'metadata' })); document.querySelector('.demo').hidden = false; }
  } catch {}
}
const mediaReady = loadMedia();

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
  // Footer background: its own upload, otherwise the same login background.
  await mediaReady;
  const own = mediaBySlot.get('footer_background')?.[0];
  const src = own ? { url: allowedMedia(own.url), video: own.media_type.startsWith('video/') } : vids.length ? { url: vids[0], video: true } : imgs.length ? { url: imgs[0], video: false } : null;
  if (src) {
    const host = document.getElementById('footBg');
    const el = src.video ? mk('video', { src: src.url, muted: true, loop: true, playsInline: true, preload: 'metadata' }) : mk('img', { src: src.url, alt: '', loading: 'lazy' });
    if (src.video) { el.setAttribute('muted', ''); new IntersectionObserver((es) => es.forEach((en) => { en.isIntersecting ? el.play().catch(() => {}) : el.pause(); }), { threshold: .05 }).observe(host); }
    host.append(el);
  }
})();

// Typed voice transcript, same behaviour as the Get Started screen: each word types across the time it is spoken.
(async () => {
  const stage = document.getElementById('voice'), log = document.getElementById('introLog'), skipBtn = document.getElementById('introSkip');
  let script; try { script = await (await fetch('/assets/intro/intro.json')).json(); } catch { stage.hidden = true; return; }
  const lines = script.lines, first = lines.map((l) => l.words[0].start), lastEnd = lines.at(-1).words.at(-1).end;
  const rows = lines.map(() => { const r = document.createElement('div'); r.className = 'introLine'; r.innerHTML = '<span class="introPrompt">&gt;</span><span class="txt"></span>'; return r; });
  const caret = Object.assign(document.createElement('span'), { className: 'introCaret', textContent: '•' });
  let cur = -1, raf = 0, done = false;
  const render = (t) => {
    let li = -1; while (li + 1 < lines.length && first[li + 1] <= t) li++;
    if (li < 0) return;
    if (li !== cur) { cur = li; log.innerHTML = ''; for (let k = Math.max(0, li - 2); k <= li; k++) { rows[k].classList.toggle('cur', k === li); rows[k].classList.toggle('prev', k === li - 1); log.appendChild(rows[k]); } }
    const parts = []; for (const w of lines[li].words) { if (t < w.start) break; const p = t >= w.end ? 1 : Math.max(.15, (t - w.start) / Math.max(.05, w.end - w.start)); parts.push(w.text.slice(0, Math.max(1, Math.ceil(w.text.length * p)))); }
    for (let k = Math.max(0, li - 2); k < li; k++) rows[k].lastChild.textContent = lines[k].text;
    rows[li].lastChild.textContent = parts.join(' '); rows[li].appendChild(caret); stage.classList.toggle('silent', t > lastEnd);
  };
  const audio = new Audio(script.audio.startsWith('/') ? script.audio : '/' + script.audio); audio.playsInline = true; audio.preload = 'auto';
  const tick = () => { if (done) return; render(audio.currentTime); raf = requestAnimationFrame(tick); };
  const start = () => audio.play().then(() => { raf = requestAnimationFrame(tick); });
  const finish = () => { done = true; cancelAnimationFrame(raf); audio.pause(); cur = -1; render(lastEnd + 1); caret.remove(); stage.classList.add('silent'); skipBtn.textContent = 'Replay'; };
  audio.addEventListener('ended', () => setTimeout(finish, 700), { once: true });
  skipBtn.addEventListener('click', () => { if (done) { done = false; audio.currentTime = 0; skipBtn.textContent = 'Skip'; start().catch(() => {}); } else finish(); });
  const hint = document.getElementById('introHint');
  audio.addEventListener('playing', () => { hint.hidden = true; }, { once: true });
  log.innerHTML = '<div class="introLine cur"><span class="introPrompt">&gt;</span><span class="txt"></span></div>'; log.firstChild.appendChild(caret);
  // Autoplay now. iPhone only unlocks sound on a real tap (click/touchend), so retry on those until it starts.
  start().catch(() => {
    const evs = ['click', 'touchend', 'keydown'];
    const cleanup = () => evs.forEach((e) => document.removeEventListener(e, retry, true));
    const retry = () => { if (done) return cleanup(); start().then(cleanup).catch(() => {}); };
    evs.forEach((e) => document.addEventListener(e, retry, true));
  });
})();

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

// Scroll animation: word-by-word text fill, staggered rises, hero parallax, screenshot scale, footer wordmark rise
(() => {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) { document.querySelectorAll('.rise,.feature,[data-reveal]').forEach((e) => e.classList.add('in')); return; }
  document.querySelectorAll('[data-words]').forEach((el) => { el.innerHTML = el.textContent.trim().split(/\s+/).map((w) => `<span class="wd">${w}</span>`).join(' '); });
  const pio = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('in'); pio.unobserve(e.target); } }), { threshold: .18 });
  document.querySelectorAll('[data-reveal]').forEach((p) => pio.observe(p));
  const fio = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('in'); fio.unobserve(e.target); } }), { threshold: .3 });
  document.querySelectorAll('.feature').forEach((f) => fio.observe(f));
  const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } }), { threshold: .12, rootMargin: '0px 0px -6% 0px' });
  document.querySelectorAll('.rise').forEach((el, i) => { if (!el.style.getPropertyValue('--d')) el.style.setProperty('--d', `${(i % 3) * .1}s`); io.observe(el); });
  const clamp = (n) => Math.min(1, Math.max(0, n));
  const hero = document.querySelector('.hero'), heroBg = document.querySelector('.hero-bg'), heroCopy = document.querySelector('.hero-copy');
  const words = [...document.querySelectorAll('[data-words]')].map((el) => ({ el, w: [...el.querySelectorAll('.wd')] }));
  const foot = document.querySelector('.foot-mark span');
  let queued = false;
  const frame = () => {
    queued = false; const vh = innerHeight, y = scrollY;
    const hp = clamp(y / (hero.offsetHeight || vh));
    heroBg.style.transform = `translate3d(0,${y * .25}px,0) scale(${1 + hp * .12})`;
    heroCopy.style.transform = `translate3d(0,${y * .22}px,0)`; heroCopy.style.opacity = 1 - hp * 1.15;
    document.querySelectorAll('.phone').forEach((p) => { const r = p.getBoundingClientRect(); p.style.setProperty('--fy', `${((r.top + r.height / 2 - vh / 2) * -.07).toFixed(1)}px`); });
    if (foot) { const r = foot.parentElement.getBoundingClientRect(), p = clamp((vh - r.top) / (r.height * 1.2)); foot.style.setProperty('--ty', `${(1 - p) * 60}%`); foot.style.setProperty('--o', p.toFixed(3)); }
  };
  const ask = () => { if (!queued) { queued = true; requestAnimationFrame(frame); } };
  addEventListener('scroll', ask, { passive: true }); addEventListener('resize', ask); frame();
})();
