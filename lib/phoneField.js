// Phone number field with the country code kept apart from the number, like WhatsApp's sign-up:
//
//   [ 🇺🇸 United States            > ]
//   [ +1   your phone number         ]
//
// mountPhoneField(input) hides the page's existing <input> and shows this instead. The hidden input stays
// the single source of truth and its .value is always the full international number ("+14155552671", or ""
// when nothing is typed), so every existing read, write and listener keeps working unchanged. Writing a full
// number to .value ("+2348031234567") selects the right country and fills in the rest.
//
// The default is the United States, always. It is never guessed from the language, the IP or the number.
import { COUNTRIES, DEFAULT_COUNTRY, KEEPS_LEADING_ZERO, countryByIso, countryForDigits, dialForIso, dialLabel, flag, nameForIso } from './countries.js';

const digitsOf = (s) => String(s || '').replace(/\D/g, '');

// ---------- pure helpers (unit-tested) ----------

// The international number for a country and what was typed, or '' when no digits were typed.
export function composeE164(iso, typed) {
  let national = digitsOf(typed);
  if (!national) return '';
  const dial = dialForIso(iso);
  // A leading 0 is the national "trunk" prefix (0803... in Nigeria, 07911... in the UK) and is not part of the
  // international number, except in the few countries where it really is.
  if (national[0] === '0' && !KEEPS_LEADING_ZERO.has(String(iso).toUpperCase())) national = national.replace(/^0+/, '');
  // In the +1 plan a leading 1 is the long-distance prefix people type out of habit: 1 415 555 2671.
  if (dial.length === 1 && dial === '1' && national.length === 11 && national[0] === '1') national = national.slice(1);
  if (!national) return '';
  return `+${dial}${national}`;
}

// "+234 803 123 4567" or "00234803..." -> { iso, national }, or null when it is not an international number.
export function parseInternational(text) {
  const s = String(text || '').trim();
  if (!/^(\+|00)/.test(s)) return null;
  const digits = digitsOf(s.replace(/^00/, ''));
  if (!digits) return { iso: null, national: '' };
  const hit = countryForDigits(digits);
  if (!hit) return null;
  return { iso: hit.iso, national: digits.slice(hit.dial.length) };
}

// The text the number box shows for a stored value.
export function splitValue(value, fallbackIso = DEFAULT_COUNTRY) {
  const parsed = parseInternational(value);
  if (parsed && parsed.iso) return parsed;
  return { iso: fallbackIso, national: digitsOf(value) };
}

export function searchCountries(query) {
  const q = String(query || '').trim().toLowerCase().replace(/^\+/, '');
  if (!q) return COUNTRIES;
  const num = /^\d+$/.test(q);
  return COUNTRIES.filter(([iso, name, dial]) => (num ? dial.startsWith(q) : (name.toLowerCase().includes(q) || iso.toLowerCase() === q)));
}

// ---------- DOM ----------

const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
const CHEVRON = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M9 6l6 6-6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

// Bottom sheet with a search box and every country. Resolves to an ISO code, or null if closed.
export function openCountryPicker({ selected = DEFAULT_COUNTRY, host } = {}) {
  return new Promise((resolve) => {
    const root = el('div', 'cpRoot');
    const backdrop = el('div', 'cpBackdrop');
    const sheet = el('div', 'cpSheet');
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-modal', 'true');
    sheet.setAttribute('aria-label', 'Select country');
    const head = el('div', 'cpHead');
    head.append(el('h2', 'cpTitle', 'Select country'));
    const close = el('button', 'cpClose'); close.type = 'button'; close.setAttribute('aria-label', 'Close');
    close.innerHTML = '<svg viewBox="0 0 24 24" fill="none"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>';
    head.append(close);
    const search = el('input', 'cpSearch'); search.type = 'search'; search.placeholder = 'Search country or code'; search.autocomplete = 'off'; search.setAttribute('aria-label', 'Search country or code');
    const list = el('div', 'cpList'); list.setAttribute('role', 'listbox');
    sheet.append(head, search, list);
    root.append(backdrop, sheet);
    const parent = host || document.body;
    if (parent !== document.body) root.classList.add('inDialog'); // inside a modal <dialog> it must live in the dialog
    parent.appendChild(root);

    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      document.removeEventListener('keydown', onKey, true);
      root.classList.add('closing');
      setTimeout(() => root.remove(), matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 240);
      resolve(value);
    };
    function onKey(e) { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(null); } }
    document.addEventListener('keydown', onKey, true);

    const draw = () => {
      list.textContent = '';
      const rows = searchCountries(search.value);
      if (!rows.length) { list.append(el('div', 'cpEmpty', 'No country found')); return; }
      for (const [iso, name] of rows) {
        const row = el('button', `cpRow${iso === selected ? ' on' : ''}`); row.type = 'button'; row.setAttribute('role', 'option'); row.dataset.iso = iso;
        row.setAttribute('aria-selected', iso === selected ? 'true' : 'false');
        row.append(el('span', 'cpFlag', flag(iso)), el('span', 'cpName', name), el('span', 'cpDial', dialLabel(iso)));
        row.addEventListener('click', () => finish(iso));
        list.append(row);
      }
    };
    draw();
    search.addEventListener('input', draw);
    close.addEventListener('click', () => finish(null));
    backdrop.addEventListener('click', () => finish(null));
    requestAnimationFrame(() => {
      root.classList.add('in');
      list.querySelector('.cpRow.on')?.scrollIntoView({ block: 'center' });
    });
  });
}

// Replace an existing phone <input> with the two-row field. Returns a small controller.
export function mountPhoneField(input, { big = false, placeholder = 'your phone number' } = {}) {
  if (!input) return null;
  if (input._phoneField) return input._phoneField;

  const anchor = input.closest('.inputWrap, .profileCard') || input;
  const field = el('div', `pfField${big ? ' big' : ''}`);
  const countryBtn = el('button', 'pfCountry'); countryBtn.type = 'button';
  const flagEl = el('span', 'pfFlag');
  const nameEl = el('span', 'pfName');
  const chev = el('span', 'pfChevron'); chev.innerHTML = CHEVRON;
  countryBtn.append(flagEl, nameEl, chev);
  const row = el('div', 'pfRow');
  const dialEl = el('span', 'pfDial');
  const box = el('input', 'pfInput');
  box.type = 'tel'; box.inputMode = 'tel'; box.autocomplete = 'tel-national'; box.maxLength = 28; box.placeholder = placeholder;
  box.setAttribute('aria-label', input.getAttribute('aria-label') || 'Phone number');
  row.append(dialEl, box);
  field.append(countryBtn, row);
  anchor.parentNode.insertBefore(field, anchor);
  anchor.style.display = 'none';

  const nativeValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  const nativeDisabled = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'disabled');
  let iso = DEFAULT_COUNTRY;
  let typed = '';

  const paint = () => {
    flagEl.textContent = flag(iso);
    nameEl.textContent = nameForIso(iso);
    dialEl.textContent = dialLabel(iso);
    countryBtn.setAttribute('aria-label', `Country: ${nameForIso(iso)}, ${dialLabel(iso)}. Tap to change.`);
    if (box.value !== typed) box.value = typed;
  };
  const store = () => nativeValue.set.call(input, composeE164(iso, typed));
  const tell = () => input.dispatchEvent(new Event('input', { bubbles: true }));

  // The page reads and writes input.value as an international number; keep the visible field in step.
  Object.defineProperty(input, 'value', {
    configurable: true,
    get() { return nativeValue.get.call(this); },
    set(v) {
      const s = String(v ?? '').trim();
      if (!s) { iso = DEFAULT_COUNTRY; typed = ''; } // cleared: back to the default country, never the last one
      else {
        const p = parseInternational(s);
        if (p) { if (p.iso) iso = p.iso; typed = p.national; } else typed = s;
      }
      store(); paint();
    },
  });
  Object.defineProperty(input, 'disabled', {
    configurable: true,
    get() { return nativeDisabled.get.call(this); },
    set(v) { nativeDisabled.set.call(this, v); box.disabled = !!v; countryBtn.disabled = !!v; },
  });
  input.focus = () => box.focus();

  box.addEventListener('input', () => {
    const raw = box.value;
    const p = parseInternational(raw);
    if (p) { if (p.iso) iso = p.iso; typed = p.national; } else typed = raw;
    store(); paint(); tell();
  });
  countryBtn.addEventListener('click', async () => {
    const chosen = await openCountryPicker({ selected: iso, host: field.closest('dialog') || undefined });
    if (!chosen) return;
    iso = chosen; store(); paint(); tell();
    box.focus();
  });

  const api = {
    get country() { return iso; },
    set country(next) { iso = countryByIso(next)[0]; store(); paint(); },
    get national() { return typed; },
    get e164() { return nativeValue.get.call(input); },
    field,
  };
  input._phoneField = api;
  paint();
  // Something may already be in the input (autofill, a restored value).
  const existing = nativeValue.get.call(input);
  if (existing) input.value = existing;
  return api;
}
