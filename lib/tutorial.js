// Reusable guided-tutorial engine. No dependencies and no knowledge of Emysa's screens:
// a tutorial is plain data registered with register(), and the app decides what the steps say.
//
//   register('my-tour', {
//     version: 1,                       // bump to show a finished tutorial again
//     steps: [{
//       id: 'save',                     // optional, for your own reference
//       target: '#addContactBtn',       // selector | () => Element | null (null = centred message)
//       text: 'Tap Add contact.',       // string | (ctx) => string
//       title: 'Optional heading',
//       side: 'auto',                   // 'auto' | 'top' | 'bottom' | 'left' | 'right' | 'center'
//       avoid: ['#moodFloat'],          // extra elements the tooltip must not cover
//       onEnter: async (ctx) => {},     // navigate / open things before the step is measured
//       skipIf: async (ctx) => false,   // true = this step does not apply right now
//       gate: (ctx) => true,            // false = Next stays disabled
//       advanceOn: 'click',             // 'click' on the target, or { event, delay } on document
//       onEvent: (event, ctx) => {},    // runs when an advanceOn event fires
//       interactive: false,             // let taps reach the highlighted element (implied by advanceOn)
//       nextLabel / finishLabel / timeout / pad / radius / scroll
//     }],
//   });
//   start('my-tour', { userId })        // once per user and version; { force: true } replays
//
// Steps whose target is missing or hidden are skipped, never left hanging.

const SPOT_PAD = 6;
const TARGET_WAIT_MS = 1500;
const LOST_RETRY_MS = 800;
const LOST_GIVEUP_MS = 2400;
const ROOT_CLASS = 'tutRoot';

const registry = new Map();
let active = null;

// ---------- pure helpers (unit-tested) ----------

export function clamp(n, lo, hi) { return Math.min(Math.max(n, lo), Math.max(lo, hi)); }

export function unionRects(rects) {
  const list = (rects || []).filter((r) => r && r.width > 0 && r.height > 0);
  if (!list.length) return null;
  const top = Math.min(...list.map((r) => r.top));
  const left = Math.min(...list.map((r) => r.left));
  const bottom = Math.max(...list.map((r) => r.top + r.height));
  const right = Math.max(...list.map((r) => r.left + r.width));
  return { top, left, width: right - left, height: bottom - top };
}

export function padRect(r, pad) {
  return { top: r.top - pad, left: r.left - pad, width: r.width + pad * 2, height: r.height + pad * 2 };
}

// Where to put the tooltip. rect = what to keep clear, tip = tooltip size, bounds = the visible area
// ({ left, top, right, bottom }, already shrunk for the on-screen keyboard). Picks a side with room,
// flips when the preferred side does not fit, and always clamps inside the bounds. fits=false means
// no side had room, so the tooltip overlaps the target as a last resort.
export function computePlacement({ rect, tip, bounds, side = 'auto', gap = 12, margin = 12 }) {
  const bw = bounds.right - bounds.left;
  const bh = bounds.bottom - bounds.top;
  if (!rect || side === 'center') {
    return {
      side: 'center', fits: true, arrow: null,
      top: bounds.top + Math.max(margin, (bh - tip.height) / 2),
      left: bounds.left + Math.max(margin, (bw - tip.width) / 2),
    };
  }
  const space = {
    top: rect.top - bounds.top - margin - gap,
    bottom: bounds.bottom - (rect.top + rect.height) - margin - gap,
    left: rect.left - bounds.left - margin - gap,
    right: bounds.right - (rect.left + rect.width) - margin - gap,
  };
  const need = { top: tip.height, bottom: tip.height, left: tip.width, right: tip.width };
  const crossOk = { top: bw - 2 * margin >= tip.width, bottom: bw - 2 * margin >= tip.width, left: bh - 2 * margin >= tip.height, right: bh - 2 * margin >= tip.height };
  const fits = (s) => space[s] >= need[s] && crossOk[s];
  const vertical = space.bottom >= space.top ? ['bottom', 'top'] : ['top', 'bottom'];
  const horizontal = space.right >= space.left ? ['right', 'left'] : ['left', 'right'];
  const order = [...vertical, ...horizontal];
  if (['top', 'bottom', 'left', 'right'].includes(side)) order.unshift(side);
  let chosen = order.find(fits);
  const ok = Boolean(chosen);
  if (!chosen) chosen = order.slice().sort((a, b) => (space[b] - need[b]) - (space[a] - need[a]))[0];

  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  let top;
  let left;
  if (chosen === 'top' || chosen === 'bottom') {
    left = clamp(cx - tip.width / 2, bounds.left + margin, bounds.right - margin - tip.width);
    top = chosen === 'top' ? rect.top - gap - tip.height : rect.top + rect.height + gap;
  } else {
    top = clamp(cy - tip.height / 2, bounds.top + margin, bounds.bottom - margin - tip.height);
    left = chosen === 'left' ? rect.left - gap - tip.width : rect.left + rect.width + gap;
  }
  top = clamp(top, bounds.top + margin, bounds.bottom - margin - tip.height);
  left = clamp(left, bounds.left + margin, bounds.right - margin - tip.width);
  const arrow = !ok ? null
    : (chosen === 'top' || chosen === 'bottom') ? clamp(cx - left, 20, tip.width - 20) : clamp(cy - top, 20, tip.height - 20);
  return { side: chosen, fits: ok, top, left, arrow };
}

export function tutorialKey(id, userId) { return `emysa.tutorial:${userId || 'anon'}:${id}`; }

function store(storage) { try { return storage || globalThis.localStorage || null; } catch { return null; } }

export function readTutorialState(id, { userId, storage } = {}) {
  try {
    const raw = store(storage)?.getItem(tutorialKey(id, userId));
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function writeTutorialState(id, state, { userId, storage } = {}) {
  try { store(storage)?.setItem(tutorialKey(id, userId), JSON.stringify(state)); } catch { /* private mode: it may show again */ }
}

// Finished (completed or skipped) at this version or newer. A bumped version shows it again.
export function isCompleted(id, { userId, storage, version } = {}) {
  const state = readTutorialState(id, { userId, storage });
  if (!state || !state.status) return false;
  const wanted = version ?? registry.get(id)?.version ?? 1;
  return (state.version ?? 1) >= wanted;
}

export function resetTutorial(id, { userId, storage } = {}) {
  try { store(storage)?.removeItem(tutorialKey(id, userId)); } catch { /* ignore */ }
}

// ---------- registry ----------

export function register(id, def) {
  if (!id || typeof id !== 'string') throw new TypeError('A tutorial needs an id');
  if (!def || !Array.isArray(def.steps) || !def.steps.length) throw new TypeError(`Tutorial "${id}" needs at least one step`);
  def.steps.forEach((s, i) => {
    if (!s || (typeof s.text !== 'string' && typeof s.text !== 'function')) throw new TypeError(`Tutorial "${id}" step ${i + 1} needs text`);
  });
  registry.set(id, { version: 1, ...def });
}

export function isRegistered(id) { return registry.has(id); }
export function isActive() { return Boolean(active); }
export function stop(outcome = 'stopped') { if (active) active.end(outcome); }

// ---------- DOM helpers ----------

function isVisible(el) {
  if (!el || !el.isConnected) return false;
  if (typeof el.checkVisibility === 'function' && !el.checkVisibility({ checkVisibilityCSS: true })) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

function resolve(sel) {
  try {
    if (!sel) return null;
    if (typeof sel === 'function') return sel() || null;
    if (typeof sel === 'string') return document.querySelector(sel);
    return sel;
  } catch { return null; }
}

function rectOf(el) {
  const r = el.getBoundingClientRect();
  return { top: r.top, left: r.left, width: r.width, height: r.height };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

function build() {
  const make = (tag, cls) => { const n = document.createElement(tag); if (cls) n.className = cls; return n; };
  const root = make('div', ROOT_CLASS);
  const dim = make('div', 'tutDim');
  const blocks = { t: make('div', 'tutBlock'), b: make('div', 'tutBlock'), l: make('div', 'tutBlock'), r: make('div', 'tutBlock'), hole: make('div', 'tutBlock') };
  const ring = make('div', 'tutRing');
  const tip = make('div', 'tutTip');
  tip.setAttribute('role', 'dialog');
  tip.setAttribute('aria-label', 'Tutorial');
  tip.setAttribute('aria-live', 'polite');
  tip.tabIndex = -1;
  const arrow = make('div', 'tutArrow');
  const count = make('div', 'tutCount');
  const title = make('div', 'tutTitle');
  const text = make('div', 'tutText');
  const foot = make('div', 'tutFoot');
  const skip = make('button', 'tutSkip'); skip.type = 'button'; skip.textContent = 'Skip';
  const spacer = make('span', 'tutSpacer');
  const back = make('button', 'tutBack'); back.type = 'button'; back.textContent = 'Back';
  const next = make('button', 'tutNext'); next.type = 'button';
  foot.append(skip, spacer, back, next);
  tip.append(arrow, count, title, text, foot);
  root.append(dim, blocks.t, blocks.b, blocks.l, blocks.r, blocks.hole, ring, tip);
  return { root, dim, blocks, ring, tip, arrow, count, title, text, skip, back, next };
}

function setBox(node, top, left, width, height) {
  node.style.top = `${Math.round(top)}px`;
  node.style.left = `${Math.round(left)}px`;
  node.style.width = `${Math.max(0, Math.round(width))}px`;
  node.style.height = `${Math.max(0, Math.round(height))}px`;
}

// ---------- start ----------

export function start(id, { userId, force = false, ctx: seed = {} } = {}) {
  const def = registry.get(id);
  if (!def) throw new Error(`Unknown tutorial: ${id}`);
  if (typeof document === 'undefined') return Promise.resolve(false);
  const abortedKey = `${tutorialKey(id, userId)}:aborted`;
  if (!force) {
    if (isCompleted(id, { userId })) return Promise.resolve(false);
    try { if (sessionStorage.getItem(abortedKey)) return Promise.resolve(false); } catch { /* ignore */ }
    if (active) return Promise.resolve(false);
  } else if (active) {
    active.end('replaced');
  }
  return new Promise((done) => {
    const run = createRun(id, def, userId, seed, abortedKey, done);
    active = run;
    run.begin();
  });
}

function createRun(id, def, userId, seed, abortedKey, done) {
  const steps = def.steps;
  const ui = build();
  const run = {
    index: -1, step: null, targetEl: null, token: 0, ended: false, navigating: false, misses: 0,
    raf: 0, sig: '', lostSince: 0, lostRetried: false, nextDisabled: null, off: [],
  };
  const ctx = {
    id, userId, data: { ...seed },
    next: () => advance(1), back: () => advance(-1), skip: () => run.end('skipped'), finish: () => run.end('completed'),
  };
  const safe = async (fn, ...args) => {
    if (typeof fn !== 'function') return undefined;
    try { return await fn(...args); } catch (err) { console.warn(`[tutorial ${id}]`, err); return undefined; }
  };
  const listen = (target, type, fn, opts) => { target.addEventListener(type, fn, opts); run.off.push(() => target.removeEventListener(type, fn, opts)); };

  // Which steps apply right now (skipIf can depend on state that changes while the tutorial runs).
  async function computePlan() {
    const keep = [];
    for (let i = 0; i < steps.length; i += 1) {
      if (!(await safe(steps[i].skipIf, ctx))) keep.push(i);
    }
    return keep;
  }

  async function waitForTarget(step, token) {
    if (!step.target) return { ok: true, el: null };
    const deadline = performance.now() + (step.timeout ?? TARGET_WAIT_MS);
    for (;;) {
      const el = resolve(step.target);
      if (isVisible(el)) return { ok: true, el };
      if (performance.now() >= deadline) return { ok: false };
      await sleep(80);
      if (run.ended || token !== run.token) return { ok: false, cancelled: true };
    }
  }

  async function show(from, dir) {
    const token = ++run.token;
    run.navigating = true;
    let i = from;
    let direction = dir;
    for (;;) {
      const plan = await computePlan();
      if (run.ended || token !== run.token) return;
      const cand = direction > 0 ? plan.find((x) => x >= i) : [...plan].reverse().find((x) => x <= i);
      if (cand == null) {
        if (direction < 0) { i = 0; direction = 1; continue; }
        // Ran off the end. If steps were dropped only because their targets were missing, do not
        // record it as finished: nothing was really taught, so it must not be marked done.
        run.end(run.misses > 0 && run.index < 0 ? 'aborted' : 'completed');
        return;
      }
      const step = steps[cand];
      await safe(step.onEnter, ctx);
      if (run.ended || token !== run.token) return;
      await nextFrame();
      const found = await waitForTarget(step, token);
      if (run.ended || token !== run.token) return;
      if (!found.ok) {
        run.misses += 1;
        console.warn(`[tutorial ${id}] target missing or hidden, skipping step ${step.id || cand + 1}`);
        i = cand + direction;
        continue;
      }
      render(cand, plan, found.el);
      return;
    }
  }

  function advance(dir) {
    if (run.ended || run.navigating) return;
    const gate = run.step?.gate;
    if (dir > 0 && typeof gate === 'function') { try { if (!gate(ctx)) return; } catch { /* treat as open */ } }
    show(run.index + dir, dir);
  }

  function clearStepListeners() { run.off.splice(0).forEach((fn) => fn()); listenFixed(); }

  function render(i, plan, el) {
    const step = steps[i];
    run.index = i;
    run.step = step;
    run.targetEl = el;
    run.sig = '';
    run.lostSince = 0;
    run.lostRetried = false;
    run.nextDisabled = null;
    run.navigating = false;
    clearStepListeners();

    const pos = plan.indexOf(i);
    const isLast = pos === plan.length - 1;
    ui.count.textContent = plan.length > 1 ? `${pos + 1}/${plan.length}` : '';
    ui.title.textContent = step.title || '';
    ui.title.hidden = !step.title;
    let body = '';
    try { body = typeof step.text === 'function' ? step.text(ctx) : step.text; } catch { body = ''; }
    ui.text.textContent = body || '';
    ui.back.hidden = pos === 0;
    ui.skip.hidden = isLast;
    ui.next.hidden = Boolean(step.hideNext);
    ui.next.textContent = isLast ? (step.finishLabel || 'Finish') : (step.nextLabel || 'Next');
    ui.root.classList.toggle('tutNoTarget', !step.target);
    ui.root.classList.remove('tutLost');
    ui.tip.style.visibility = 'hidden';

    const interactive = Boolean(step.advanceOn) || step.interactive === true;
    ui.blocks.hole.hidden = interactive;

    if (step.advanceOn === 'click') {
      listen(document, 'click', (e) => {
        if (run.step !== step || !run.targetEl || !run.targetEl.contains(e.target)) return;
        // After the app's own click handler has run (it may switch screens).
        setTimeout(() => { if (run.step === step) advance(1); }, step.advanceDelay ?? 220);
      }, true);
    } else if (step.advanceOn && typeof step.advanceOn === 'object' && step.advanceOn.event) {
      const { event, delay = 220 } = step.advanceOn;
      listen(document, event, (e) => {
        if (run.step !== step) return;
        try { step.onEvent?.(e, ctx); } catch { /* ignore */ }
        setTimeout(() => { if (run.step === step) advance(1); }, delay);
      });
    }

    if (el && step.scroll !== false) { try { el.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch { /* ignore */ } }
    if (!interactive) { try { ui.next.focus({ preventScroll: true }); } catch { /* ignore */ } }
    layout();
  }

  // Esc skips. Registered once for the whole run.
  function listenFixed() {
    listen(document, 'keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); run.end('skipped'); } });
  }

  function currentBounds(vw, vh) {
    const vv = window.visualViewport;
    if (!vv) return { left: 0, top: 0, right: vw, bottom: vh };
    return {
      left: Math.max(0, vv.offsetLeft), top: Math.max(0, vv.offsetTop),
      right: Math.min(vw, vv.offsetLeft + vv.width), bottom: Math.min(vh, vv.offsetTop + vv.height),
    };
  }

  function layout() {
    const step = run.step;
    if (!step || run.ended) return;
    const view = ui.root.getBoundingClientRect();
    const vw = view.width || window.innerWidth;
    const vh = view.height || window.innerHeight;

    // Gate: Next stays disabled until the step's condition is met.
    let blocked = false;
    if (typeof step.gate === 'function') { try { blocked = !step.gate(ctx); } catch { blocked = false; } }
    if (blocked !== run.nextDisabled) {
      run.nextDisabled = blocked;
      ui.next.disabled = blocked;
      ui.next.setAttribute('aria-disabled', blocked ? 'true' : 'false');
    }

    let spot = null;
    let place = null;
    if (step.target) {
      let el = run.targetEl;
      if (!isVisible(el)) el = run.targetEl = resolve(step.target);
      if (!isVisible(el)) { handleLost(step); return; }
      run.lostSince = 0;
      ui.root.classList.remove('tutLost');
      spot = padRect(rectOf(el), step.pad ?? SPOT_PAD);
      const extras = (step.avoid || []).map((s) => resolve(s)).filter(isVisible).map(rectOf);
      place = unionRects([spot, ...extras]);
    }
    const bounds = currentBounds(vw, vh);
    const sig = [run.index, vw, vh, bounds.left, bounds.top, bounds.right, bounds.bottom,
      spot && [spot.top, spot.left, spot.width, spot.height].map(Math.round).join(','),
      place && [place.top, place.left, place.width, place.height].map(Math.round).join(',')].join('|');
    if (sig === run.sig) return;
    run.sig = sig;

    if (spot) {
      const hole = {
        top: clamp(spot.top, 0, vh), left: clamp(spot.left, 0, vw),
        bottom: clamp(spot.top + spot.height, 0, vh), right: clamp(spot.left + spot.width, 0, vw),
      };
      setBox(ui.blocks.t, 0, 0, vw, hole.top);
      setBox(ui.blocks.b, hole.bottom, 0, vw, vh - hole.bottom);
      setBox(ui.blocks.l, hole.top, 0, hole.left, hole.bottom - hole.top);
      setBox(ui.blocks.r, hole.top, hole.right, vw - hole.right, hole.bottom - hole.top);
      setBox(ui.blocks.hole, hole.top, hole.left, hole.right - hole.left, hole.bottom - hole.top);
      setBox(ui.ring, spot.top, spot.left, spot.width, spot.height);
      let radius = step.radius;
      if (radius == null) {
        try { radius = getComputedStyle(run.targetEl).borderRadius; } catch { radius = ''; }
        if (!radius || radius === '0px') radius = '12px';
      }
      ui.ring.style.borderRadius = typeof radius === 'number' ? `${radius}px` : radius;
    } else {
      setBox(ui.blocks.t, 0, 0, vw, vh);
      ['b', 'l', 'r', 'hole'].forEach((k) => setBox(ui.blocks[k], 0, 0, 0, 0));
    }

    ui.tip.style.maxWidth = `${Math.max(200, Math.min(320, bounds.right - bounds.left - 24))}px`;
    const tip = { width: ui.tip.offsetWidth, height: ui.tip.offsetHeight };
    const placement = computePlacement({ rect: place, tip, bounds, side: step.side || 'auto' });
    ui.tip.style.top = `${Math.round(placement.top)}px`;
    ui.tip.style.left = `${Math.round(placement.left)}px`;
    ui.tip.dataset.side = placement.arrow == null ? 'none' : placement.side;
    if (placement.arrow != null) ui.tip.style.setProperty('--tut-arrow', `${Math.round(placement.arrow)}px`);
    ui.tip.style.visibility = 'visible';
  }

  // The target vanished mid-step (the person closed the form, navigated, …): dim everything, try the
  // step's own onEnter once to bring it back, and move on if it never returns.
  function handleLost(step) {
    const now = performance.now();
    if (!run.lostSince) run.lostSince = now;
    ui.root.classList.add('tutLost');
    ui.tip.style.visibility = 'hidden';
    setBox(ui.blocks.t, 0, 0, ui.root.clientWidth, ui.root.clientHeight);
    ['b', 'l', 'r', 'hole'].forEach((k) => setBox(ui.blocks[k], 0, 0, 0, 0));
    run.sig = '';
    const lostFor = now - run.lostSince;
    if (lostFor > LOST_RETRY_MS && !run.lostRetried) {
      run.lostRetried = true;
      safe(step.onEnter, ctx);
    } else if (lostFor > LOST_GIVEUP_MS) {
      run.lostSince = now + 60000; // do not re-trigger while the move is in flight
      run.misses += 1;
      show(run.index + 1, 1);
    }
  }

  function frame() {
    if (run.ended) return;
    run.raf = requestAnimationFrame(frame);
    layout();
  }

  ui.skip.addEventListener('click', () => run.end('skipped'));
  ui.back.addEventListener('click', () => advance(-1));
  ui.next.addEventListener('click', () => advance(1));
  // The dimmed area must not scroll the page behind it.
  ui.root.addEventListener('wheel', (e) => { if (!ui.tip.contains(e.target)) e.preventDefault(); }, { passive: false });

  run.begin = () => {
    document.body.appendChild(ui.root);
    listenFixed();
    run.raf = requestAnimationFrame(frame);
    show(0, 1);
  };

  run.end = (outcome) => {
    if (run.ended) return;
    run.ended = true;
    cancelAnimationFrame(run.raf);
    run.off.splice(0).forEach((fn) => fn());
    ui.root.remove();
    if (outcome === 'completed' || outcome === 'skipped') {
      writeTutorialState(id, { version: def.version ?? 1, status: outcome, at: Date.now() }, { userId });
    } else if (outcome === 'aborted') {
      try { sessionStorage.setItem(abortedKey, '1'); } catch { /* ignore */ }
    }
    if (active === run) active = null;
    done(outcome);
  };

  return run;
}
