import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { TIKTOK_URL, TIKTOK_HANDLE, TIKTOK_EMBED_SRC, creatorEmbedHtml, mountCreatorEmbed } from '../lib/tiktokEmbed.js';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const html = read('index.html');
const css = read('styles.css');
const app = read('app.js');
const profile = html.slice(html.indexOf('<div class="sectionLabel">Community</div>'), html.indexOf('<div class="sectionLabel">App</div>'));

// ---- the profile page ----

test('the profile page has one social link, TikTok, and no other social links', () => {
  assert.match(profile, /id="socialTikTok"/);
  assert.match(profile, />TikTok</);
  assert.match(profile, /@emysacall/);
  for (const gone of ['x.com', 'instagram', 'discord', 'facebook', 'youtube', 'linkedin', 'socialX', 'socialInstagram', 'socialDiscord']) {
    assert.ok(!profile.toLowerCase().includes(gone), `profile still mentions ${gone}`);
  }
  assert.equal((profile.match(/class="profileCard/g) || []).length, 1, 'one card in Community');
  // sign-in with Google / Apple is not a social link and stays
  assert.match(html, /id="loginGoogle"/);
  assert.match(html, /id="signupApple"/);
});

test('the TikTok row opens an in-app page with the account link and the embed', () => {
  const page = html.slice(html.indexOf('id="sheet-tiktok"'));
  assert.match(page, /id="tiktokEmbedBox"/);
  assert.match(page, /id="tiktokOpenLink" href="https:\/\/www\.tiktok\.com\/@emysacall" target="_blank" rel="noopener"/);
  assert.match(app, /\$\('socialTikTok'\)\.addEventListener\('click', openTikTok\);/);
  assert.match(app, /function openTikTok\(\) \{\n  openSheet\('sheet-tiktok'\);\n  mountCreatorEmbed\(\$\('tiktokEmbedBox'\)\);/);
  // keyboard users can open it too
  assert.match(app, /\$\('socialTikTok'\)\.addEventListener\('keydown'/);
});

test('the TikTok icon is the supplied one, drawn in the theme color rather than fixed black', () => {
  const icon = profile.slice(profile.indexOf('<svg'), profile.indexOf('</svg>'));
  assert.match(icon, /M16\.8217 5\.1344C16\.0886 4\.29394/);
  assert.match(icon, /stroke="currentColor"/);
  assert.doesNotMatch(icon, /#000000|#000\b/);
});

// ---- the embed ----

test('the account link is the creator page, without tracking parameters', () => {
  assert.equal(TIKTOK_HANDLE, 'emysacall');
  assert.equal(TIKTOK_URL, 'https://www.tiktok.com/@emysacall');
  assert.equal(TIKTOK_EMBED_SRC, 'https://www.tiktok.com/embed.js');
  assert.doesNotMatch(html, /is_from_webapp|sender_device/);
});

test('the embed is TikTok\u2019s creator embed for @emysacall', () => {
  const dom = new JSDOM(`<div id="box"></div>`);
  const box = dom.window.document.getElementById('box');
  box.innerHTML = creatorEmbedHtml();
  const q = box.querySelector('blockquote.tiktok-embed');
  assert.equal(q.getAttribute('cite'), 'https://www.tiktok.com/@emysacall');
  assert.equal(q.getAttribute('data-unique-id'), 'emysacall');
  assert.equal(q.getAttribute('data-embed-type'), 'creator');
  assert.match(q.getAttribute('style'), /max-width: 780px; min-width: 288px/);
  const a = q.querySelector('section a');
  assert.equal(a.textContent, '@emysacall');
  assert.equal(a.getAttribute('href'), 'https://www.tiktok.com/@emysacall?refer=creator_embed');
  assert.equal(a.getAttribute('rel'), 'noopener'); // it opens in a new tab and must not hand over the opener
});

test('mounting adds the embed and TikTok\u2019s script once, and only when asked', () => {
  // nothing of TikTok is loaded with the page itself
  assert.doesNotMatch(html, /tiktok\.com\/embed\.js/);
  assert.doesNotMatch(app, /tiktok\.com\/embed\.js/);
  const dom = new JSDOM(`<div id="box"></div>`);
  const box = dom.window.document.getElementById('box');
  assert.equal(mountCreatorEmbed(box), true);
  assert.equal(box.querySelectorAll('blockquote.tiktok-embed').length, 1);
  const scripts = box.querySelectorAll('script');
  assert.equal(scripts.length, 1);
  assert.equal(scripts[0].getAttribute('src'), 'https://www.tiktok.com/embed.js');
  assert.ok(scripts[0].async);
  // the script comes after the blockquote it will replace
  assert.ok(box.firstElementChild.matches('blockquote'));
  assert.ok(box.lastElementChild.matches('script'));
  // opening the page again changes nothing
  assert.equal(mountCreatorEmbed(box), false);
  assert.equal(box.querySelectorAll('blockquote.tiktok-embed').length, 1);
  assert.equal(box.querySelectorAll('script').length, 1);
});

// ---- the home hero ----

test('nothing blurs or hazes the top of the hero video, in any theme', () => {
  assert.doesNotMatch(css, /\.dashHero::before/);
  assert.doesNotMatch(css, /--hero-fade/);
  const btn = css.match(/\.dashHero \.dashIconBtn\{[^}]*\}/)[0];
  assert.doesNotMatch(btn, /backdrop-filter/);
  // the header sits straight on the picture in light ink, which is readable in every theme because the video is dark
  assert.match(css, /\.dashHero \.dashName\{color:#fff6ee;/);
  assert.match(css, /\.dashHero \.dashTag\{color:rgba\(255,246,238,/);
  assert.match(css, /\.dashHero \.dashIconBtn\{color:#fff6ee;/);
});
