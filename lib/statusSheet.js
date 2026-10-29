// Emysa's one popup: an animated bottom sheet for results (success / error / info / warning), questions
// (confirm) and short text entry (prompt). It replaces the browser's native alert / confirm / prompt boxes.
//
//   await sheet({ kind: 'success', title: 'Successful', message: '5 min added.' });
//   if (await confirmSheet({ title: 'Delete this chat?', message: 'This can\u2019t be undone.', confirmLabel: 'Delete', destructive: true })) { ... }
//   const text = await promptSheet({ title: 'Edit memory', value: 'old text', confirmLabel: 'Save' });   // string | null
//
// Colours come from the app theme tokens (--surface-2, --text, --accent, ...), so the sheet follows
// dark, brave, cream and white by itself. All styling lives in styles.css under "status sheet".
// Sheets queue: asking for a second one while one is open shows it after the first is dismissed.

const KINDS = {
  success: { rgb: '112,190,60', ink: '#0f5b3f', label: 'Successful' },
  error: { rgb: '226,72,66', ink: '#c0332d', label: 'Something went wrong' },
  info: { rgb: '58,98,224', ink: '#2a52d6', label: 'Heads up' },
  warning: { rgb: '240,170,30', ink: '#a86a00', label: 'Are you sure?' },
};

const SVG_NS = 'http://www.w3.org/2000/svg';
const MS_CLOSE = 260;

// A scalloped blob: radius wobbles with the angle, which gives the soft "seal" shape.
export function blobPath(cx, cy, r, lobes, depth, phase = 0, steps = 96) {
  const pts = [];
  for (let i = 0; i < steps; i += 1) {
    const a = (i / steps) * Math.PI * 2;
    const rr = r * (1 + depth * Math.sin(lobes * a + phase));
    pts.push([cx + rr * Math.cos(a), cy + rr * Math.sin(a)]);
  }
  return `M${pts.map(([x, y]) => `${x.toFixed(2)} ${y.toFixed(2)}`).join('L')}Z`;
}

function svg(tag, attrs = {}, children = []) {
  const n = document.createElementNS(SVG_NS, tag);
  Object.entries(attrs).forEach(([k, v]) => n.setAttribute(k, String(v)));
  children.forEach((c) => n.appendChild(c));
  return n;
}

function badge(kind) {
  const k = KINDS[kind] || KINDS.info;
  const root = svg('svg', { viewBox: '0 0 200 200', class: 'stBadgeSvg', 'aria-hidden': 'true' });
  // fill goes through style (not the fill attribute) because only CSS can read the --st-a-* variables.
  const layer = (cls, r, lobes, depth, phase) => svg('g', { class: `stLayer ${cls}` }, [svg('path', { d: blobPath(100, 100, r, lobes, depth, phase), style: `fill:rgba(${k.rgb},var(--st-a-${cls}))` })]);
  root.append(layer('l1', 92, 10, 0.06, 0), layer('l2', 74, 8, 0.07, 0.6), layer('l3', 54, 7, 0.08, 1.2));
  const icon = svg('g', { class: `stIcon stIcon-${kind}`, transform: 'translate(100 100)', stroke: k.ink, fill: 'none', 'stroke-width': 7, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
  if (kind === 'success') {
    icon.append(svg('circle', { class: 'stRing', r: 27, cx: 0, cy: 0, pathLength: 100 }), svg('path', { class: 'stCheck', d: 'M-12 1 L-3 11 L14 -9', pathLength: 100 }));
  } else if (kind === 'info') {
    icon.append(svg('circle', { class: 'stDot', cx: 0, cy: -20, r: 5.5, fill: k.ink, stroke: 'none' }), svg('path', { class: 'stStem', d: 'M0 -6 L0 20', 'stroke-width': 9, pathLength: 100 }));
  } else {
    icon.append(svg('path', { class: 'stBar', d: 'M0 -22 L0 6', 'stroke-width': 9, pathLength: 100 }), svg('circle', { class: 'stDot', cx: 0, cy: 21, r: 5.5, fill: k.ink, stroke: 'none' }));
  }
  root.append(icon);
  return root;
}

const queue = [];
let current = null;

function open(spec) {
  return new Promise((resolve) => { queue.push({ spec, resolve }); if (!current) next(); });
}

function next() {
  const item = queue.shift();
  if (!item) { current = null; return; }
  current = render(item.spec, (value) => { item.resolve(value); current = null; setTimeout(next, 30); });
}

function render(spec, finish) {
  const kind = KINDS[spec.kind] ? spec.kind : (spec.mode === 'confirm' ? (spec.destructive ? 'warning' : 'info') : 'info');
  const mode = spec.mode || 'notice';
  const previousFocus = document.activeElement;
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };

  const root = el('div', 'stRoot');
  const backdrop = el('div', 'stBackdrop');
  const sheet = el('div', 'stSheet');
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-modal', 'true');
  sheet.dataset.kind = kind;
  sheet.tabIndex = -1;
  const titleId = `stTitle${Date.now()}`;
  sheet.setAttribute('aria-labelledby', titleId);

  const close = el('button', 'stClose');
  close.type = 'button';
  close.setAttribute('aria-label', 'Close');
  close.innerHTML = '<svg viewBox="0 0 24 24" fill="none"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>';

  const badgeWrap = el('div', 'stBadge');
  badgeWrap.append(badge(kind));
  const title = el('h2', 'stTitle', spec.title || KINDS[kind].label);
  title.id = titleId;
  const body = el('p', 'stText', spec.message || '');
  body.hidden = !spec.message;

  let input = null;
  if (mode === 'prompt') {
    input = el(spec.multiline === false ? 'input' : 'textarea', 'stInput');
    if (spec.multiline === false) input.type = 'text'; else input.rows = 4;
    input.value = spec.value || '';
    if (spec.placeholder) input.placeholder = spec.placeholder;
  }

  const actions = el('div', 'stActions');
  const primary = el('button', `stBtn primary${spec.destructive ? ' danger' : ''}`, spec.confirmLabel || (mode === 'notice' ? 'Done' : 'Confirm'));
  primary.type = 'button';
  actions.append(primary);
  let secondary = null;
  if (mode !== 'notice') {
    secondary = el('button', 'stBtn ghost', spec.cancelLabel || 'Cancel');
    secondary.type = 'button';
    actions.append(secondary);
  }

  sheet.append(close, badgeWrap, title, body);
  if (input) sheet.append(input);
  sheet.append(actions);
  root.append(backdrop, sheet);
  document.body.appendChild(root);

  let closed = false;
  const cancelValue = mode === 'confirm' ? false : mode === 'prompt' ? null : undefined;
  function dismiss(value) {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey, true);
    root.classList.add('closing');
    setTimeout(() => {
      root.remove();
      try { previousFocus?.focus?.({ preventScroll: true }); } catch { /* ignore */ }
      finish(value);
    }, matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : MS_CLOSE);
  }
  const accept = () => dismiss(mode === 'confirm' ? true : mode === 'prompt' ? input.value : undefined);
  const decline = () => dismiss(cancelValue);

  primary.addEventListener('click', accept);
  secondary?.addEventListener('click', decline);
  close.addEventListener('click', decline);
  backdrop.addEventListener('click', decline);
  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); decline(); }
    else if (e.key === 'Enter' && input && input.tagName === 'INPUT') { e.preventDefault(); accept(); }
    else if (e.key === 'Tab') {
      const items = [...sheet.querySelectorAll('button, input, textarea')].filter((n) => !n.hidden && !n.disabled);
      const first = items[0]; const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }
  document.addEventListener('keydown', onKey, true);

  // Pull the sheet down to dismiss it.
  let startY = null;
  let dy = 0;
  sheet.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button, input, textarea')) return;
    startY = e.clientY; dy = 0; sheet.style.transition = 'none';
    try { sheet.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  });
  sheet.addEventListener('pointermove', (e) => {
    if (startY == null) return;
    dy = Math.max(0, e.clientY - startY);
    sheet.style.transform = `translateY(${dy}px)`;
  });
  const release = () => {
    if (startY == null) return;
    startY = null; sheet.style.transition = '';
    if (dy > 90) { sheet.style.transform = ''; decline(); } else { sheet.style.transform = ''; }
  };
  sheet.addEventListener('pointerup', release);
  sheet.addEventListener('pointercancel', release);

  requestAnimationFrame(() => {
    root.classList.add('in');
    // Focus the sheet itself (not the button) so a tap-first user does not see a keyboard focus ring;
    // Tab still reaches the buttons. A prompt focuses its field.
    try { (input || sheet).focus({ preventScroll: true }); } catch { /* ignore */ }
    if (input) { try { input.setSelectionRange(input.value.length, input.value.length); } catch { /* ignore */ } }
  });
  return { dismiss };
}

export const sheet = (spec = {}) => open({ ...spec, mode: 'notice' });
export const confirmSheet = (spec = {}) => open({ ...spec, mode: 'confirm' });
export const promptSheet = (spec = {}) => open({ ...spec, mode: 'prompt' });
export const successSheet = (message, title = 'Successful') => sheet({ kind: 'success', title, message });
export const errorSheet = (message, title = 'Something went wrong') => sheet({ kind: 'error', title, message });
export const infoSheet = (message, title = 'Heads up') => sheet({ kind: 'info', title, message });
export function closeAllSheets() { queue.length = 0; current?.dismiss?.(undefined); }
