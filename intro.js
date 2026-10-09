// Pre-login voice intro for the Get Started panel.
// Plays pre-generated audio lines, types each line word by word in sync with
// the audio, taps haptics per word, then reveals Sign Up / Log In.
// Everything is static (no account, no network calls besides the assets), so it
// works before sign-up, before the cookie banner is accepted, and offline.
//
// Word timing: if a line has `words: [{text, start}]` (seconds) those are used;
// otherwise words are spread evenly across the audio's duration.

const INTRO_SEEN_KEY = 'emysa_intro_seen';
const HAPTICS_KEY = 'emysa_haptics_enabled'; // same toggle the profile screen uses

// --- haptics -----------------------------------------------------------------
// navigator.vibrate does nothing on iPhone. On iOS 17.4+ Safari/PWA, toggling a
// <input type="checkbox" switch> gives a light native tap. Best effort: it works
// from tap handlers; from timers it can be hit-or-miss, so test on a real device.
let hapticLabel = null;
function ensureHapticEl() {
  if (hapticLabel) return;
  hapticLabel = document.createElement('label');
  hapticLabel.setAttribute('aria-hidden', 'true');
  hapticLabel.style.cssText = 'position:fixed;left:-100px;top:-100px;opacity:0;pointer-events:none;';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.setAttribute('switch', '');
  hapticLabel.appendChild(input);
  document.body.appendChild(hapticLabel);
}
function tap() {
  try { if (localStorage.getItem(HAPTICS_KEY) === '0') return; } catch {}
  if (navigator.vibrate) { navigator.vibrate(8); return; } // Android
  try { ensureHapticEl(); hapticLabel.click(); } catch {} // iOS
}

// --- player ------------------------------------------------------------------
export function introAlreadySeen() {
  try { return !!localStorage.getItem(INTRO_SEEN_KEY); } catch { return false; }
}

export async function playIntro({ panel, onDone }) {
  const stage = panel.querySelector('#introStage');
  const textEl = panel.querySelector('#introText');
  const skipBtn = panel.querySelector('#introSkip');
  const buttons = panel.querySelector('.gsButtons');

  let finished = false;
  let audio = null;
  let raf = 0;

  const finish = () => {
    if (finished) return;
    finished = true;
    cancelAnimationFrame(raf);
    if (audio) { audio.pause(); audio.src = ''; }
    try { localStorage.setItem(INTRO_SEEN_KEY, '1'); } catch {}
    stage.classList.add('done');
    buttons.classList.add('revealed');
    onDone && onDone();
  };

  skipBtn.addEventListener('click', finish);

  let script;
  try {
    script = await (await fetch('assets/intro/intro.json')).json();
  } catch { return finish(); } // never block sign-in because the intro failed

  stage.classList.add('ready');

  // One continuous track; each word has an absolute start time (seconds).
  audio = new Audio(script.audio);
  audio.playsInline = true;
  const lines = script.lines;
  const firstStart = lines.map((l) => l.words[0].start);
  let curLine = -1, shown = 0;

  const tick = () => {
    if (finished) return;
    const t = audio.currentTime;
    let li = 0;
    while (li + 1 < lines.length && firstStart[li + 1] <= t) li++;
    const words = lines[li].words;
    if (li !== curLine) { curLine = li; shown = 0; textEl.textContent = ''; textEl.classList.add('typing'); }
    let n = 0;
    while (n < words.length && words[n].start <= t) n++;
    if (n > shown) { textEl.textContent = words.slice(0, n).map((w) => w.text).join(' '); tap(); shown = n; }
    raf = requestAnimationFrame(tick);
  };
  const start = () => audio.play().then(() => { raf = requestAnimationFrame(tick); });
  audio.addEventListener('ended', () => {
    const last = lines[lines.length - 1];
    textEl.textContent = last.words.map((w) => w.text).join(' ');
    setTimeout(finish, 600);
  }, { once: true });
  audio.addEventListener('error', finish, { once: true });
  start().catch(() => {
    // Autoplay with sound is blocked until the first touch (cookie OK counts). Wait for it silently.
    document.addEventListener('pointerdown', () => { if (!finished) start().catch(finish); }, { once: true, capture: true });
  });
}
