import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
const home = html.slice(html.indexOf('id="screen-home"'), html.indexOf('id="screen-chat"'));

test('every element app.js looks up by a literal id exists in index.html', () => {
  const createdAtRuntime = new Set(['miniToast']); // built by showToast()
  const missing = [...new Set([...app.matchAll(/\$\('([A-Za-z0-9_-]+)'\)/g)].map((m) => m[1]))].filter((id) => !ids.has(id) && !createdAtRuntime.has(id));
  assert.deepEqual(missing, []);
});

test('bottom nav is Home / Chat / Recent / Profile and every tab has a screen', () => {
  const nav = html.slice(html.indexOf('<nav id="tabBar"'), html.indexOf('</nav>'));
  const tabs = [...nav.matchAll(/data-tab="([a-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual(tabs, ['home', 'chat', 'recent', 'profile']);
  for (const tab of [...tabs, 'contacts']) assert.ok(ids.has(`screen-${tab}`), `screen-${tab}`);
});

test('Home keeps the agreed pieces and none of the removed ones', () => {
  for (const keep of ['Emysa', 'Your calls. Your people. Your voice.', 'On your behalf', 'Balance', 'Add time', 'What should Emysa handle?', 'Call someone', 'Schedule a call', 'Follow up for me', 'Ask / find something', 'More', 'People']) {
    assert.ok(home.includes(keep), keep);
  }
  assert.deepEqual([...home.matchAll(/data-action="([a-z]+)"/g)].map((m) => m[1]), ['call', 'schedule', 'followup', 'ask', 'more']);
  for (const gone of ['Things Emysa can handle', 'callsList', 'recentChatsList', 'Recent calls', 'contactsList']) {
    assert.ok(!home.includes(gone), gone);
  }
});

test('the old Home is the Chat screen and the chat input bar follows the Chat tab only', () => {
  assert.ok(html.includes('id="homeIdleGreeting"') && html.indexOf('id="homeIdleGreeting"') > html.indexOf('id="screen-chat"'));
  assert.ok(css.includes('#screen-chat.active{display:flex'));
  assert.ok(!/#screen-home\.active\{display:flex/.test(css));
  assert.ok(app.includes("toggle('visible', name === 'chat')"));
  assert.ok(!html.includes('<div id="homeInputBar" class="visible">'));
});

test('top-right of Home is Notifications (not Profile) and opens its sheet', () => {
  assert.ok(home.includes('id="dashNotifBtn"') && home.includes('href="#ic-notifications"'));
  assert.ok(!home.includes('ic-settings') && !home.includes('dashSettingsBtn'));
  assert.ok(ids.has('sheet-notifications'));
  assert.ok(app.includes("openSheet('sheet-notifications')"));
});

test('On your behalf is an empty scaffold: no invented items', () => {
  const behalf = home.slice(home.indexOf('aria-label="On your behalf"'), home.indexOf('aria-label="People"'));
  assert.ok(behalf.includes('id="dashBehalfList"'));
  assert.ok(!/Scheduled|In progress|Completed|Sarah|Ayodele|Package/.test(behalf));
});

test('Profile tab shows a ring and the profile picture only while active', () => {
  assert.ok(/\.tabBtn\.active \.tabAvatarRing\{[^}]*box-shadow/.test(css));
  assert.ok(/\.tabAvatarRing img\{display:none/.test(css));
  assert.ok(app.includes('function setNavAvatar') && app.includes('loadNavAvatar();'));
});

test('every icon the new screens use is defined in the sprite', () => {
  const defined = new Set([...html.matchAll(/<symbol id="(ic-[a-z-]+)"/g)].map((m) => m[1]));
  const used = new Set([...html.matchAll(/href="#(ic-[a-z-]+)"/g)].map((m) => m[1]));
  assert.ok(used.size > 0);
  for (const id of used) assert.ok(defined.has(id), id);
});

test('Add time is a full page with stepper, price button and legal links (no old sheet)', () => {
  const page = html.slice(html.indexOf('id="addTimeScreen"'), html.indexOf('id="sheet-notifications"'));
  for (const id of ['addTimeClose', 'addTimeBig', 'addTimeMinus', 'addTimePlus', 'addTimeQty', 'addTimeBuy', 'addTimeTerms', 'addTimePrivacy']) assert.ok(page.includes(`id="${id}"`), id);
  assert.ok(page.includes('of call time'));
  assert.ok(!html.includes('id="addTimeDialog"'));
  assert.ok(!/valid for 30 days/i.test(page)); // expiry is not built, so the page must not promise it
  assert.ok(app.includes('Purchase ${labels.buy} ·'));
});

test('payment return page is in the PWA scope and never claims the payment succeeded', () => {
  const page = readFileSync(new URL('../pay-return.html', import.meta.url), 'utf8');
  assert.ok(page.includes('href="./index.html"'));
  assert.ok(!/payment (was )?successful|you have been charged|minutes (were )?added/i.test(page));
});
