/* Global button loading spinner.
 *
 * Any <button> that disables itself right after being tapped (the app's
 * pattern for "a request is running") gets a spinner while the work runs, so
 * no button looks frozen. It never rewrites the button's label, so existing
 * "Saving…" style labels keep working; the spinner itself is drawn by CSS
 * (button.isLoading::before in styles.css).
 *
 * The spinner stops when: the button is re-enabled or removed, the requests
 * started by the tap have all finished (the button may stay disabled on
 * purpose afterwards), nothing was requested at all (a purely local disable),
 * or after 90 s as a safety net.
 *
 * Programmatic use: window.btnLoading.start(btn) / window.btnLoading.stop(btn).
 */
(function () {
  'use strict';
  if (window.btnLoading) return;

  var CLICK_WINDOW_MS = 1500; // a disable within this long of a tap is "because of" that tap
  var NO_REQUEST_MS = 1500;   // no request started since the tap: it was not a request
  var SETTLE_MS = 600;        // quiet period after the last request ends before we stop
  var MAX_MS = 90000;

  var inflight = 0;
  var lastFetchStart = 0;
  var lastClick = { el: null, t: 0 };
  var active = new Map(); // button -> { clickT, timers: [] }
  var settleTimer = null;

  function now() { return Date.now(); }

  function isButton(el) {
    if (!el || !el.tagName) return false;
    if (el.tagName === 'BUTTON') return true;
    return el.tagName === 'INPUT' && /^(button|submit)$/i.test(el.type || '');
  }

  function start(btn, clickT) {
    if (!isButton(btn) || active.has(btn)) return;
    var iconOnly = !(btn.textContent || '').trim();
    btn.classList.add('isLoading');
    if (iconOnly) btn.classList.add('isLoadingIcon');
    btn.setAttribute('aria-busy', 'true');
    var entry = { clickT: clickT || now(), timers: [] };
    entry.timers.push(setTimeout(function () {
      if (lastFetchStart < entry.clickT) stop(btn); // nothing was requested
    }, NO_REQUEST_MS));
    entry.timers.push(setTimeout(function () { stop(btn); }, MAX_MS));
    active.set(btn, entry);
  }

  function stop(btn) {
    var entry = active.get(btn);
    if (!entry) return;
    entry.timers.forEach(clearTimeout);
    active.delete(btn);
    btn.classList.remove('isLoading', 'isLoadingIcon');
    btn.removeAttribute('aria-busy');
  }

  function scheduleSettle() {
    clearTimeout(settleTimer);
    settleTimer = setTimeout(function () {
      if (inflight > 0) return;
      Array.from(active.keys()).forEach(function (btn) {
        var entry = active.get(btn);
        // Requests started by this tap have finished; the button staying
        // disabled from here on is intentional, not "loading".
        if (entry && lastFetchStart >= entry.clickT) stop(btn);
      });
    }, SETTLE_MS);
  }

  // Count in-flight requests.
  var origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function () {
      inflight++;
      lastFetchStart = now();
      var p;
      try { p = origFetch.apply(this, arguments); } catch (err) { inflight = Math.max(0, inflight - 1); throw err; }
      var done = function () { inflight = Math.max(0, inflight - 1); if (!inflight) scheduleSettle(); };
      p.then(done, done);
      return p;
    };
  }

  // Remember what was just tapped (capture phase: runs before the handler).
  document.addEventListener('click', function (e) {
    var t = e.target && e.target.closest ? e.target.closest('button, input[type=button], input[type=submit]') : null;
    lastClick = { el: t, t: now() };
  }, true);

  function relatedToClick(btn) {
    var el = lastClick.el;
    if (!el || now() - lastClick.t > CLICK_WINDOW_MS) return false;
    return el === btn || (el.contains && el.contains(btn)) || (btn.contains && btn.contains(el));
  }

  if (typeof MutationObserver === 'function') {
    new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i++) {
        var btn = records[i].target;
        if (!isButton(btn)) continue;
        if (btn.disabled) { if (relatedToClick(btn)) start(btn, lastClick.t); }
        else stop(btn);
      }
      // Buttons that were removed from the page while loading.
      active.forEach(function (_entry, b) { if (b.isConnected === false) stop(b); });
    }).observe(document.documentElement, { attributes: true, attributeFilter: ['disabled'], subtree: true });
  }

  window.btnLoading = { start: function (b) { start(b, now()); }, stop: stop };
})();
