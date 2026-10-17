// Keeps the screen awake while a live call is on screen.
//
// Uses the Screen Wake Lock API where the browser offers it. The lock is
// released by the browser whenever the page is hidden, so it is re-requested
// on visibilitychange. Refusals (permission denied, battery saver, unsupported
// browser) are reported to the console and never break the call.
(function () {
  var wanted = false;
  var sentinel = null;
  var listening = false;

  function nav() { return typeof navigator !== 'undefined' ? navigator : null; }
  function doc() { return typeof document !== 'undefined' ? document : null; }

  function supported() {
    var n = nav();
    return !!(n && n.wakeLock && typeof n.wakeLock.request === 'function');
  }

  function acquire() {
    if (!wanted || sentinel || !supported()) return Promise.resolve(false);
    return nav().wakeLock.request('screen').then(function (lock) {
      // A stop() may have happened while the request was in flight.
      if (!wanted) { try { lock.release(); } catch (e) {} return false; }
      sentinel = lock;
      if (lock.addEventListener) {
        lock.addEventListener('release', function () { if (sentinel === lock) sentinel = null; });
      }
      return true;
    }).catch(function (err) {
      console.warn('[wake-lock] not held during call:', err && err.name ? err.name : err);
      return false;
    });
  }

  function onVisibility() {
    var d = doc();
    if (wanted && d && d.visibilityState === 'visible') acquire();
  }

  function start() {
    wanted = true;
    var d = doc();
    if (d && !listening && d.addEventListener) {
      d.addEventListener('visibilitychange', onVisibility);
      listening = true;
    }
    return acquire();
  }

  function stop() {
    wanted = false;
    var lock = sentinel;
    sentinel = null;
    if (lock && typeof lock.release === 'function') {
      try { Promise.resolve(lock.release()).catch(function () {}); } catch (e) {}
    }
  }

  function isHeld() { return !!sentinel; }

  var api = { start: start, stop: stop, isHeld: isHeld, supported: supported };
  if (typeof window !== 'undefined') window.callWakeLock = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
