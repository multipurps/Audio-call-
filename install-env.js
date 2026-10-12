/* Detects device, operating system, browser, version and in-app browsers, and decides how Emysa can be installed.
   Loaded as a classic script in the browser (window.EmysaInstallEnv) and importable in tests (globalThis.EmysaInstallEnv). */
(function (root) {
  'use strict';

  function detect(input) {
    const nav = typeof navigator !== 'undefined' ? navigator : {};
    const o = input || {};
    const ua = o.ua ?? nav.userAgent ?? '';
    const platform = o.platform ?? nav.platform ?? '';
    const touch = o.maxTouchPoints ?? nav.maxTouchPoints ?? 0;
    const referrer = o.referrer ?? (typeof document !== 'undefined' ? document.referrer : '') ?? '';
    const brave = o.brave ?? !!nav.brave;
    const num = (re) => { const r = ua.match(re); return r ? parseInt(r[1], 10) : null; };

    // iPadOS Safari reports itself as a Mac; only real iPads have touch points.
    const iPad = /iPad/.test(ua) || (/Macintosh/.test(ua) && touch > 1);
    const iPhone = /iPhone|iPod/.test(ua);
    const ios = iPad || iPhone;
    const android = /Android/.test(ua);

    // In-app browsers cannot install anything; the visitor has to open the page in a real browser first.
    const named = [
      [/Instagram/, 'Instagram'], [/FBAN|FBAV|FB_IAB|FBIOS/, 'Facebook'], [/LinkedInApp/, 'LinkedIn'],
      [/Snapchat/, 'Snapchat'], [/musical_ly|BytedanceWebview|TikTok|trill_/, 'TikTok'], [/Line\//, 'LINE'],
      [/MicroMessenger/, 'WeChat'], [/Twitter/, 'X'], [/Pinterest/, 'Pinterest'], [/GSA\//, 'the Google app'], [/Barcelona/, 'Threads'],
    ].find(([re]) => re.test(ua));
    let inApp = named ? named[1] : null;
    if (!inApp && /\/\/(l|lm)\.(instagram|facebook)\.com|\/\/t\.co\//.test(referrer) && (ios || android)) inApp = /instagram/.test(referrer) ? 'Instagram' : /facebook/.test(referrer) ? 'Facebook' : 'X';
    if (!inApp && android && /; wv\)/.test(ua)) inApp = 'an in-app browser';
    if (!inApp && ios && /AppleWebKit/.test(ua) && !/Safari\//.test(ua)) inApp = 'an in-app browser';

    let browser = 'Unknown browser', browserVersion = null;
    if (ios) {
      if (/CriOS/.test(ua)) { browser = 'Chrome'; browserVersion = num(/CriOS\/(\d+)/); }
      else if (/FxiOS/.test(ua)) { browser = 'Firefox'; browserVersion = num(/FxiOS\/(\d+)/); }
      else if (/EdgiOS/.test(ua)) { browser = 'Edge'; browserVersion = num(/EdgiOS\/(\d+)/); }
      else if (/OPiOS|OPT\//.test(ua)) { browser = 'Opera'; browserVersion = num(/(?:OPiOS|OPT)\/(\d+)/); }
      else if (/DuckDuckGo/.test(ua)) { browser = 'DuckDuckGo'; browserVersion = num(/DuckDuckGo\/(\d+)/); }
      else if (/Version\/\d+/.test(ua)) { browser = 'Safari'; browserVersion = num(/Version\/(\d+)/); }
    } else if (android) {
      if (/SamsungBrowser/.test(ua)) { browser = 'Samsung Internet'; browserVersion = num(/SamsungBrowser\/(\d+)/); }
      else if (/EdgA/.test(ua)) { browser = 'Edge'; browserVersion = num(/EdgA\/(\d+)/); }
      else if (/OPR\//.test(ua)) { browser = 'Opera'; browserVersion = num(/OPR\/(\d+)/); }
      else if (/Firefox\//.test(ua)) { browser = 'Firefox'; browserVersion = num(/Firefox\/(\d+)/); }
      else if (/DuckDuckGo/.test(ua)) { browser = 'DuckDuckGo'; browserVersion = num(/DuckDuckGo\/(\d+)/); }
      else if (/Chrome\//.test(ua)) { browser = brave ? 'Brave' : 'Chrome'; browserVersion = num(/Chrome\/(\d+)/); }
    } else {
      if (/Edg\//.test(ua)) { browser = 'Edge'; browserVersion = num(/Edg\/(\d+)/); }
      else if (/OPR\//.test(ua)) { browser = 'Opera'; browserVersion = num(/OPR\/(\d+)/); }
      else if (/Firefox\//.test(ua)) { browser = 'Firefox'; browserVersion = num(/Firefox\/(\d+)/); }
      else if (/Chrome\//.test(ua)) { browser = brave ? 'Brave' : 'Chrome'; browserVersion = num(/Chrome\/(\d+)/); }
      else if (/Version\/\d+.*Safari\//.test(ua)) { browser = 'Safari'; browserVersion = num(/Version\/(\d+)/); }
    }

    let device = 'Device', os = '', osVersion = null;
    if (iPad) device = 'iPad'; else if (iPhone) device = 'iPhone';
    else if (android) device = /Mobile/.test(ua) ? 'Android phone' : 'Android tablet';
    else if (/Macintosh/.test(ua)) device = 'Mac'; else if (/Windows/.test(ua)) device = 'Windows PC';
    else if (/CrOS/.test(ua)) device = 'Chromebook'; else if (/Linux/.test(ua)) device = 'Linux PC';

    if (ios) {
      os = iPad ? 'iPadOS' : 'iOS';
      // Safari's version number is the real OS version. Other browsers freeze the OS in the UA at 18, so from 18
      // upward it can only be reported as "18 or later".
      if (browser === 'Safari' && browserVersion) osVersion = browserVersion;
      else { const v = num(/OS (\d+)_/) ?? num(/Mac OS X 10_(\d+)/); osVersion = v; }
    } else if (android) { os = 'Android'; osVersion = num(/Android (\d+)/); }
    else if (/Macintosh/.test(ua)) os = 'macOS'; else if (/Windows/.test(ua)) os = 'Windows';
    else if (/CrOS/.test(ua)) os = 'ChromeOS'; else if (/Linux/.test(ua)) os = 'Linux';
    const osApprox = ios && browser !== 'Safari' && osVersion >= 18;

    // route: 'lib' = the add-to-homescreen library has accurate, illustrated steps for this combination.
    let route = 'generic';
    if (inApp) route = 'inapp';
    else if (ios) route = browser === 'Safari' || browser === 'Chrome' ? 'lib' : browser === 'Firefox' ? 'ios-firefox' : browser === 'Edge' ? 'ios-edge' : 'ios-other';
    else if (android) route = browser === 'Chrome' || browser === 'Brave' || browser === 'Edge' ? 'lib' : browser === 'Samsung Internet' ? 'android-samsung' : browser === 'Firefox' ? 'android-firefox' : 'android-other';
    else route = browser === 'Chrome' || browser === 'Edge' || browser === 'Brave' || browser === 'Opera' ? 'lib' : browser === 'Safari' ? 'lib' : 'desktop-unsupported';

    const osLabel = os ? os + (osVersion ? ' ' + osVersion + (osApprox ? ' or later' : '') : '') : '';
    const browserLabel = inApp ? (inApp === 'an in-app browser' ? 'in-app browser' : inApp + ' in-app browser') : browser + (browserVersion ? ' ' + browserVersion : '');
    const chip = [device, osLabel, browserLabel].filter(Boolean).join(' · ');
    return { device, os, osVersion, osApprox, browser, browserVersion, inApp, ios, android, iPad, route, chip };
  }

  // Steps for the environments the library does not cover or gets wrong. `host` is the in-app app name.
  function guide(env) {
    const copy = env.ios ? 'Safari' : 'Chrome';
    switch (env.route) {
      case 'inapp':
        return { title: `Open Emysa in ${copy}`, intro: `${env.inApp === 'an in-app browser' ? 'This browser' : env.inApp} can't install apps.`,
          steps: [`Tap the ⋯ or share menu in ${env.inApp === 'an in-app browser' ? 'this window' : env.inApp}.`, env.ios ? 'Choose Open in Safari.' : 'Choose Open in Chrome (or Open in browser).', 'Tap Install again.'], copy: true };
      case 'ios-firefox':
        return { title: 'Install on iPhone with Firefox', steps: ['Tap the menu button (☰) at the bottom right of Firefox.', 'Tap Share.', 'Scroll and tap Add to Home Screen.', 'Tap Add.'], copy: false };
      case 'ios-edge':
        return { title: 'Install on iPhone with Edge', steps: ['Tap the ⋯ menu at the bottom of Edge.', 'Tap Share.', 'Scroll and tap Add to Home Screen.', 'Tap Add.'], copy: true, note: 'Safari works too: open this page there and use Share, then Add to Home Screen.' };
      case 'ios-other':
        return { title: 'Open Emysa in Safari', intro: `${env.browser} can't add apps to your Home Screen.`, steps: ['Copy the link below.', 'Open Safari and paste it in the address bar.', 'Tap Install on that page.'], copy: true };
      case 'android-samsung':
        return { title: 'Install with Samsung Internet', steps: ['Tap the menu (☰) at the bottom right.', 'Tap Add page to, then Home screen.', 'Tap Add.'], copy: false, note: 'If you see an install icon in the address bar, you can tap that instead.' };
      case 'android-firefox':
        return { title: 'Install with Firefox', steps: ['Tap the ⋮ menu.', 'Tap Install.', 'Confirm Add to Home screen.'], copy: false };
      case 'android-other':
        return { title: `Install with ${env.browser === 'Unknown browser' ? 'your browser' : env.browser}`, steps: ['Open the browser menu.', 'Choose Install app or Add to Home screen.', 'Confirm.'], copy: true, note: 'If you don\'t see it, open this page in Chrome.' };
      case 'desktop-unsupported':
        return { title: 'Open Emysa in a browser that installs apps', intro: `${env.browser} on a computer can't install web apps.`, steps: ['Open this page in Chrome, Edge or Safari.', 'Chrome and Edge: click the install icon in the address bar.', 'Safari on Mac: File, then Add to Dock.'], copy: true };
      default:
        return { title: 'Install Emysa', steps: ['Open your browser menu.', 'Choose Install app or Add to Home Screen.'], copy: true };
    }
  }

  root.EmysaInstallEnv = { detect, guide };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.EmysaInstallEnv;
})(typeof globalThis !== 'undefined' ? globalThis : this);
