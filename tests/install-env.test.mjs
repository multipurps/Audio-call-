import test from 'node:test';
import assert from 'node:assert/strict';
await import('../install-env.js');
const { detect, guide } = globalThis.EmysaInstallEnv;

const CASES = [
  ['iPhone Safari 26 (OS frozen at 18)', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1', 5, 'lib', 'iPhone · iOS 26 · Safari 26'],
  ['iPhone Safari 18', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Mobile/15E148 Safari/604.1', 5, 'lib', 'iPhone · iOS 18 · Safari 18'],
  ['iPhone Safari 17', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1', 5, 'lib', 'iPhone · iOS 17 · Safari 17'],
  ['iPhone Chrome', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/140.0.0.0 Mobile/15E148 Safari/604.1', 5, 'lib', 'iPhone · iOS 18 or later · Chrome 140'],
  ['iPhone Firefox', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/140.0 Mobile/15E148 Safari/605.1.15', 5, 'ios-firefox', 'iPhone · iOS 18 or later · Firefox 140'],
  ['iPhone Edge', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 EdgiOS/140.0 Mobile/15E148 Safari/605.1.15', 5, 'ios-edge', 'iPhone · iOS 18 or later · Edge 140'],
  ['iPhone Instagram', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 350.0.0', 5, 'inapp', 'iPhone · iOS 18 or later · Instagram in-app browser'],
  ['iPhone generic web view', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148', 5, 'inapp', 'iPhone · iOS 17 · in-app browser'],
  ['iPad Safari (reports as a Mac)', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15', 5, 'lib', 'iPad · iPadOS 26 · Safari 26'],
  ['Mac Safari (no touch)', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15', 0, 'lib', 'Mac · macOS · Safari 18'],
  ['Android Chrome', 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36', 5, 'lib', 'Android phone · Android 15 · Chrome 140'],
  ['Android Samsung Internet', 'Mozilla/5.0 (Linux; Android 15; SM-S928B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/27.0 Chrome/140.0.0.0 Mobile Safari/537.36', 5, 'android-samsung', 'Android phone · Android 15 · Samsung Internet 27'],
  ['Android Firefox', 'Mozilla/5.0 (Android 15; Mobile; rv:140.0) Gecko/140.0 Firefox/140.0', 5, 'android-firefox', 'Android phone · Android 15 · Firefox 140'],
  ['Android Edge', 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36 EdgA/140.0.0.0', 5, 'lib', 'Android phone · Android 15 · Edge 140'],
  ['Android Facebook web view', 'Mozilla/5.0 (Linux; Android 14; SM-A546B; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/140.0.0.0 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/450.0.0]', 5, 'inapp', 'Android phone · Android 14 · Facebook in-app browser'],
  ['Windows Chrome', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36', 0, 'lib', 'Windows PC · Windows · Chrome 140'],
  ['Windows Edge', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0', 0, 'lib', 'Windows PC · Windows · Edge 140'],
  ['Windows Firefox', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0', 0, 'desktop-unsupported', 'Windows PC · Windows · Firefox 140'],
];

for (const [name, ua, touch, route, chip] of CASES) {
  test(`detects ${name}`, () => {
    const env = detect({ ua, maxTouchPoints: touch, referrer: '' });
    assert.equal(env.route, route);
    assert.equal(env.chip, chip);
  });
}

test('every route that is not handled by the library has real steps, and none is the iOS Safari default', () => {
  for (const [name, ua, touch, route] of CASES) {
    if (route === 'lib') continue;
    const g = guide(detect({ ua, maxTouchPoints: touch, referrer: '' }));
    assert.ok(g.steps.length >= 3, name);
    if (!/iPhone|iPod/.test(ua) || /FxiOS|EdgiOS/.test(ua) === false) continue;
    assert.ok(!/Add to Home Screen/.test(g.steps[0]), `${name} must not start with the Safari steps`);
  }
});
