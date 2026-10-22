// Overlay stacking: whatever opens last is on top.
//
// The app has several kinds of full-screen overlay: sheets (Voice, Connected accounts...), the
// Premium and Add-time screens, and the sign-in / "Verify Your Number" screen. Each had its own fixed
// z-index (sheets 150, Premium 120, sign-in 100), so a screen launched FROM a sheet (Get Premium on
// the Voice page, Calling lines on Connected accounts) opened underneath it and only appeared when the
// sheet was closed.
//
// The rule now lives in one place: when an overlay becomes visible while another overlay is already
// visible, it is placed one level above the highest visible one. When it is hidden again the override
// is removed, so the screen underneath is simply there again. With nothing else open nothing changes:
// the CSS z-index applies as before (the sign-in screen stays under the cookie banner, for example).
//
// It watches the `hidden` class, so every code path that shows or hides an overlay is covered without
// each one having to remember to call anything.

export const OVERLAY_SELECTOR = '.sheetScreen, .addTimeScreen, #authScreen';
export const Z_BASE = 150;
// Below the in-call screen (200) and toasts, which must always win.
export const Z_MAX = 190;

/** z-index for an overlay that just opened, given the z-index of every other visible overlay. null = leave it to CSS. */
export function stackedZ(visibleOtherZs, { base = Z_BASE, max = Z_MAX } = {}) {
  if (!visibleOtherZs.length) return null;
  return Math.min(Math.max(base - 1, ...visibleOtherZs) + 1, max);
}

export function installOverlayStacking(doc = document, win = window) {
  const overlays = [...doc.querySelectorAll(OVERLAY_SELECTOR)];
  const isOpen = (el) => !el.classList.contains('hidden');
  const zOf = (el) => Number(el.style.zIndex) || Number(win.getComputedStyle(el).zIndex) || 0;

  const bringToFront = (el) => {
    const z = stackedZ(overlays.filter((o) => o !== el && isOpen(o)).map(zOf));
    el.style.zIndex = z == null ? '' : String(z);
  };

  const observer = new win.MutationObserver((records) => {
    for (const r of records) {
      const el = r.target;
      const wasHidden = (r.oldValue || '').split(/\s+/).includes('hidden');
      if (wasHidden && isOpen(el)) bringToFront(el);
      else if (!wasHidden && !isOpen(el)) el.style.zIndex = '';
    }
  });
  for (const el of overlays) observer.observe(el, { attributes: true, attributeFilter: ['class'], attributeOldValue: true });
  return observer;
}
