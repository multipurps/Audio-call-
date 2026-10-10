(() => {
const $ = (s) => document.querySelector(s);
const SB = 'https://gucblbvfzuraaozswfwd.supabase.co';
const KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imd1Y2JsYnZmenVyYWFvenN3ZndkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU0NzQ0ODQsImV4cCI6MjA5MTA1MDQ4NH0.OCsEC_FfOJmoL5sQWP8zYnw9SmWuy4xggfcpIIxQw-c';

// Menu
const burger = $('#burger'), menu = $('#menu');
const setMenu = (open) => { menu.classList.toggle('open', open); burger.setAttribute('aria-expanded', open); document.body.style.overflow = open ? 'hidden' : ''; };
burger.addEventListener('click', () => setMenu(!menu.classList.contains('open')));
menu.addEventListener('click', (e) => { if (e.target.closest('a,button')) setMenu(false); });
addEventListener('keydown', (e) => e.key === 'Escape' && setMenu(false));

// Scroll reveal
const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } }), { threshold: .15 });
document.querySelectorAll('.reveal').forEach((el) => io.observe(el));

// Hero background: same auth_backgrounds the login screen uses (video first, then crossfading images)
(async () => {
  let rows = [];
  try {
    const r = await fetch(`${SB}/rest/v1/auth_backgrounds?select=url,media_type&order=created_at.asc`, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } });
    rows = r.ok ? await r.json() : [];
  } catch {}
  const vids = rows.filter((x) => x.media_type === 'video').map((x) => x.url);
  const imgs = rows.filter((x) => x.media_type !== 'video').map((x) => x.url);
  if (vids.length) {
    const v = $('.bg-v'); let i = 0;
    const next = () => { v.src = vids[i++ % vids.length]; v.loop = vids.length === 1; v.play().catch(() => {}); };
    v.addEventListener('ended', next); v.addEventListener('playing', () => v.classList.add('on'), { once: true }); next();
  } else if (imgs.length) {
    const layers = [$('.bg-a'), $('.bg-b')]; let i = 0, a = 0;
    const show = () => { const n = 1 - a; layers[n].style.backgroundImage = `url('${imgs[i % imgs.length]}')`; layers[n].classList.add('on'); layers[a].classList.remove('on'); a = n; i++; };
    show(); if (imgs.length > 1) setInterval(show, 6000);
  }
})();

// Introduction voice with live transcript
const audio = $('#intro'), live = $('#live'), play = $('#play'), prog = $('#prog');
let lines = [], cur = -1, words = [];
fetch('/assets/intro/intro.json').then((r) => r.json()).then((d) => { lines = d.lines; }).catch(() => {});
const draw = (i) => {
  cur = i; const l = lines[i]; live.innerHTML = '';
  const p = document.createElement('p'); p.className = 'ln';
  words = l.words.map((w) => { const s = document.createElement('span'); s.className = 'w'; s.textContent = w.text + ' '; p.append(s); return s; });
  live.append(p);
};
const tick = () => {
  const t = audio.currentTime;
  if (lines.length) {
    let i = lines.findIndex((l) => t >= l.words[0].start - .2 && t <= l.words.at(-1).end + .9);
    if (i === -1) i = cur;
    if (i !== cur && i > -1) draw(i);
    if (cur > -1) lines[cur].words.forEach((w, k) => words[k].classList.toggle('on', t >= w.start));
  }
  prog.style.width = (audio.duration ? t / audio.duration * 100 : 0) + '%';
  if (!audio.paused) requestAnimationFrame(tick);
};
play.addEventListener('click', () => audio.paused ? audio.play() : audio.pause());
audio.addEventListener('play', () => { play.classList.add('on'); play.setAttribute('aria-label', 'Pause'); tick(); });
audio.addEventListener('pause', () => { play.classList.remove('on'); play.setAttribute('aria-label', 'Play the introduction'); });
audio.addEventListener('ended', () => { cur = -1; live.innerHTML = '<p class="idle">Play it again, or get started below.</p>'; prog.style.width = '0'; });

// Install
let deferred = null; const dlg = $('#dlg');
addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e; });
addEventListener('appinstalled', () => { deferred = null; });
const note = (t, m) => { $('#dlgT').textContent = t; $('#dlgM').textContent = m; dlg.showModal(); };
$('#dlgClose').addEventListener('click', () => dlg.close());
const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
document.querySelectorAll('.install-action').forEach((b) => b.addEventListener('click', async () => {
  if (standalone()) return note('Emysa is installed', 'You are already using the installed app.');
  if (deferred) { const p = deferred; deferred = null; p.prompt(); return; }
  if (typeof window.AddToHomeScreen === 'function') {
    try { const g = window.AddToHomeScreen({ appName: 'Emysa', appIconUrl: '/icon-192.png', assetUrl: '/vendor/adhs/assets/img/', maxModalDisplayCount: -1, skipFirstVisit: false, allowClose: true }); g.show('en'); if (g.modalIsShowing()) return; } catch {}
  }
  note('Install Emysa', /iphone|ipad|ipod/i.test(navigator.userAgent) ? 'In Safari, tap Share, then Add to Home Screen.' : 'Open your browser menu and choose Install app or Add to Home screen.');
}));
})();
