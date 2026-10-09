// Pre-login voice intro for the Get Started panel.
// One audio track + per-word timings (assets/intro/intro.json). Each word is typed
// character by character across the time it is spoken, so the text follows the voice.
// Works before sign-up / cookie consent: it only uses static files.
import { WebHaptics } from './vendor/web-haptics.js';

const INTRO_SEEN_KEY = 'emysa_intro_seen';
const HAPTICS_KEY = 'emysa_haptics_enabled'; // same toggle the profile screen uses

const haptics = new WebHaptics();
function tap() {
  try { if (localStorage.getItem(HAPTICS_KEY) === '0') return; } catch {}
  try { haptics.trigger([{ duration: 14, intensity: 0.5 }]); } catch {}
}

export function introAlreadySeen() {
  try { return !!localStorage.getItem(INTRO_SEEN_KEY); } catch { return false; }
}

export async function playIntro({ panel, onDone }) {
  const stage = panel.querySelector('#introStage');
  const log = panel.querySelector('#introLog');
  const skipBtn = panel.querySelector('#introSkip');
  const buttons = panel.querySelector('.gsButtons');

  let finished = false, raf = 0, audio = null;
  const finish = () => {
    if (finished) return;
    finished = true;
    cancelAnimationFrame(raf);
    if (audio) { audio.pause(); }
    try { localStorage.setItem(INTRO_SEEN_KEY, '1'); } catch {}
    buttons.classList.add('revealed');
    onDone && onDone();
  };
  skipBtn.addEventListener('click', finish);

  let script;
  try { script = await (await fetch('assets/intro/intro.json')).json(); }
  catch { return finish(); } // never block sign-in because the intro failed

  const lines = script.lines;
  const firstStart = lines.map((l) => l.words[0].start);
  const lastEnd = lines[lines.length - 1].words.at(-1).end;

  // DOM: one row per line, created as the line begins.
  const rows = lines.map((l) => {
    const row = document.createElement('div');
    row.className = 'introLine';
    row.innerHTML = '<span class="introPrompt">&gt;</span><span class="txt"></span>';
    return row;
  });
  const caret = document.createElement('span');
  caret.className = 'introCaret';
  caret.textContent = '•';

  let curLine = -1, lastWordIdx = -1, lastKey = '';
  const render = (t) => {
    let li = -1;
    while (li + 1 < lines.length && firstStart[li + 1] <= t) li++;
    if (li < 0) return;
    if (li !== curLine) {
      curLine = li; lastWordIdx = -1;
      log.innerHTML = '';
      for (let k = Math.max(0, li - 2); k <= li; k++) {
        rows[k].classList.toggle('cur', k === li);
        rows[k].classList.toggle('prev', k === li - 1);
        log.appendChild(rows[k]);
      }
    }
    const words = lines[li].words;
    const parts = [];
    let spoken = -1;
    for (let w = 0; w < words.length; w++) {
      const { text, start, end } = words[w];
      if (t < start) break;
      spoken = w;
      const prog = t >= end ? 1 : Math.max(0.15, (t - start) / Math.max(0.05, end - start));
      parts.push(text.slice(0, Math.max(1, Math.ceil(text.length * prog))));
    }
    if (spoken > lastWordIdx) { lastWordIdx = spoken; tap(); }
    const str = parts.join(' ');
    // finished lines above stay fully typed
    for (let k = Math.max(0, li - 2); k < li; k++) rows[k].lastChild.textContent = lines[k].text;
    if (str !== lastKey) { rows[li].lastChild.textContent = str; lastKey = str; }
    rows[li].appendChild(caret);
    stage.classList.toggle('silent', t > lastEnd);
  };

  audio = new Audio(script.audio);
  audio.playsInline = true;
  audio.preload = 'auto';
  const tick = () => { if (finished) return; render(audio.currentTime); raf = requestAnimationFrame(tick); };
  const start = () => audio.play().then(() => { raf = requestAnimationFrame(tick); });
  audio.addEventListener('ended', () => setTimeout(finish, 700), { once: true });
  audio.addEventListener('error', finish, { once: true });

  // Show the idle prompt right away so the panel never looks empty.
  log.innerHTML = '<div class="introLine cur"><span class="introPrompt">&gt;</span><span class="txt"></span></div>';
  log.firstChild.appendChild(caret);

  // Try autoplay. iPhone blocks sound until a real tap (click/touchend, NOT pointerdown),
  // so keep waiting for taps (cookie OK counts) until playback actually starts.
  start().catch(() => {
    const evs = ['click', 'touchend', 'keydown'];
    const retry = () => {
      if (finished) return cleanup();
      start().then(cleanup).catch(() => {}); // blocked again: keep listening
    };
    const cleanup = () => evs.forEach((e) => document.removeEventListener(e, retry, true));
    evs.forEach((e) => document.addEventListener(e, retry, true));
  });
}
