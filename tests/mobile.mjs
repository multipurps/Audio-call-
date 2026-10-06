// Browser integration tests against real app files and API handlers, with all
// auth/database/provider boundaries replaced by isolated fixtures. No paid calls.
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { database, loadApi, response } from './helpers.mjs';

const root = resolve('.');
const server = createServer(async (req, res) => {
  const path = resolve(root, '.' + new URL(req.url, 'http://test').pathname.replace(/\/$/, '/index.html'));
  if (!path.startsWith(root + '/')) { res.writeHead(403).end(); return; }
  try {
    const types = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.json': 'application/json', '.png': 'image/png' };
    res.setHeader('Content-Type', types[extname(path)] || 'application/octet-stream');
    res.end(await readFile(path));
  } catch { res.writeHead(404).end(); }
});
await new Promise((resolve) => server.listen(0, '0.0.0.0', resolve));
const baseURL = `http://127.0.0.1:${server.address().port}`;
const executablePath = process.env.CHROMIUM_PATH;
const browser = await chromium.launch({ ...(executablePath ? { executablePath, args: ['--no-sandbox', '--disable-dev-shm-usage'] } : {}) });
const stubSupabase = `
export function createClient() {
  return {
    auth: { onAuthStateChange() {}, async getSession() { return { data: { session: { access_token: 'test', user: { id: 'user-1', email: 'test@example.test' } } } }; } },
    from(table) {
      const query = { select() { return query; }, eq() { return query; }, upsert() { return query; }, order() { return query; }, maybeSingle() { return query; },
        then(ok) { return Promise.resolve({ data: table === 'profiles' ? { name: 'Sam', language: 'en' } : table === 'user_approvals' ? { approved: true } : [], error: null }).then(ok); }
      }; return query;
    },
    channel() { const c = { on() { return c; }, subscribe() { return c; } }; return c; }, removeChannel() {},
  };
}`;
await mkdir('test-results', { recursive: true });
try {
  for (const [width, height] of [[320, 568], [390, 844], [430, 932]]) {
    const db = database({ contacts: [
      { id: 'contact-1', user_id: 'user-1', name: 'Alex Morgan', phone_number: '+1 (415) 555-2671' },
      { id: 'contact-2', user_id: 'user-1', name: '<img src=x onerror=alert(1)>', phone_number: '+442079460958' },
    ] });
    let dialed = 0;
    let failSummary = false;
    const providerFetch = async (url) => {
      if (url.includes('twilio.com')) { if (url.endsWith('/Calls.json')) dialed++; return { ok: true, json: async () => ({ sid: 'test-sid' }) }; }
      if (failSummary) return { ok: false };
      return { ok: true, json: async () => ({ choices: [{ message: { content: "I'll confirm lunch at noon and keep it friendly." } }] }) };
    };
    const handlers = {};
    for (const name of ['assistant', 'contacts', 'calls']) handlers[name] = (await loadApi(`api/${name}.js`, db, providerFetch)).default;
    const context = await browser.newContext({ viewport: { width, height }, isMobile: true, hasTouch: true, reducedMotion: 'reduce', serviceWorkers: 'block' });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('https://esm.sh/**', (route) => route.fulfill({ contentType: 'text/javascript', body: stubSupabase }));
    await page.route('**/api/**', async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      const name = url.pathname.split('/').pop();
      const result = response();
      if (!handlers[name]) { await route.fulfill({ json: {} }); return; }
      try {
        await handlers[name]({ method: req.method(), headers: req.headers(), query: Object.fromEntries(url.searchParams), body: req.postDataJSON() || {} }, result);
        await route.fulfill({ status: result.code, json: result.data });
      } catch (err) { errors.push(`API: ${err.message}`); await route.fulfill({ status: 500, json: { error: err.message } }); }
    });
    await page.goto(baseURL);
    await expect(page.locator('#authScreen')).toHaveClass(/hidden/);
    await expect(page.locator('#tabBar .tabBtn')).toHaveCount(4);
    assert.deepEqual(await page.locator('#tabBar .tabBtn').allTextContents().then((labels) => labels.map((s) => s.trim())), ['Home', 'Recent', 'Contacts', 'Profile']);
    const navStyle = await page.locator('#tabBar').evaluate((el) => {
      const css = getComputedStyle(el); return [css.padding, css.borderWidth, css.backgroundColor];
    });
    assert.deepEqual(navStyle, ['0px', '0px', 'rgba(0, 0, 0, 0)']);
    await page.getByRole('button', { name: 'Contacts', exact: true }).click();
    await expect(page.locator('.contactRow')).toHaveCount(2);
    await expect(page.locator('#contactsList img')).toHaveCount(0);
    await page.screenshot({ path: `test-results/contacts-${width}.png` });
    const fab = await page.locator('#openKeypadBtn').boundingBox();
    const nav = await page.locator('#tabBar').boundingBox();
    assert.ok(fab.y + fab.height < nav.y, 'Keypad button must stay above nav');
    await page.getByRole('button', { name: 'Open keypad' }).click();
    await expect(page.locator('#keypadDialog')).toBeVisible();
    await expect(page.locator('[data-digit]')).toHaveCount(12);
    await page.locator('[data-digit="*"]').click();
    await page.locator('[data-digit="#"]').click();
    await expect(page.locator('#dialCallBtn')).toBeDisabled();
    await page.locator('#dialNumber').fill('+1 415 555 2671');
    await expect(page.locator('#dialMatch')).toHaveText('Alex Morgan');
    await expect(page.locator('#dialSaveBtn')).toBeHidden();
    await page.locator('#dialNumber').fill('+12025550199');
    await expect(page.locator('#dialSaveBtn')).toBeVisible();
    const dialButton = await page.locator('#dialCallBtn').boundingBox();
    assert.ok(dialButton.y + dialButton.height <= height, 'Call button fits without scrolling');
    await page.screenshot({ path: `test-results/keypad-${width}.png` });
    await page.getByRole('button', { name: 'Save Contact', exact: true }).click();
    await page.locator('#newContactName').fill('Jamie');
    await page.locator('#addContactBtn').click();
    await expect(page.locator('.contactRow')).toHaveCount(3);
    assert.equal(db.tables.contacts[2].phone_number, '+12025550199');
    await page.getByRole('button', { name: 'Call Alex Morgan', exact: true }).click();
    await expect(page.locator('#contactCallDialog [data-method]')).toHaveCount(3);
    await expect(page.locator('#contactCallDialog')).not.toContainText('Emysa');
    await page.screenshot({ path: `test-results/methods-${width}.png` });
    await page.locator('[data-method=phone]').click();
    await expect(page.locator('#screen-chat')).toHaveClass(/active/);
    await expect(page.locator('#preCallLabel')).toHaveText('Alex Morgan · Phone');
    assert.equal(dialed, 0);
    await page.locator('#briefInput').fill('Confirm lunch at noon. Keep it friendly.');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Call Now', exact: true })).toBeEnabled();
    assert.equal(dialed, 0);
    await page.screenshot({ path: `test-results/script-${width}.png` });
    await page.getByRole('button', { name: 'Call Now', exact: true }).click();
    await expect(page.locator('#callScreen')).toBeVisible();
    assert.equal(dialed, 1);
    await page.locator('#callEndBtn').click();
    await expect(page.locator('#callScreen')).toBeHidden();
    await page.getByRole('button', { name: 'Recent', exact: true }).click();
    await expect(page.locator('[data-subtab=calls]')).toHaveClass(/active/);
    await expect(page.locator('.recentRow')).toHaveCount(1);
    await page.getByRole('button', { name: 'Chat', exact: true }).click();
    await expect(page.locator('#recentChatsList .savedChatRow')).toHaveCount(1);
    await page.locator('#recentChatsList .savedChatRow').click();
    await expect(page.locator('#homeChat')).toContainText('Confirm lunch at noon');
    await expect(page.getByRole('button', { name: 'Call Now', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: 'Call Emysa', exact: true }).click();
    await page.locator('#emysaCallbackNumber').fill('+14155550999');
    await page.getByRole('button', { name: 'Continue in chat' }).click();
    await expect(page.locator('#preCallLabel')).toContainText('Emysa');
    failSummary = true;
    await page.locator('#briefInput').fill('Help me plan tomorrow.');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.locator('#homeChat')).toContainText('Could not prepare the summary');
    await expect(page.locator('#briefInput')).toHaveValue('Help me plan tomorrow.');
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
    assert.equal(dialed, 1);
    failSummary = false;
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Call Now', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Call Now', exact: true }).click();
    await expect(page.locator('#callScreen')).toBeVisible();
    assert.equal(dialed, 2);
    assert.equal(db.tables.calls[1].contact_id, null);
    assert.match(db.tables.calls[1].objective, /calling the app user directly/);
    await page.locator('#callEndBtn').click();
    // Reload and resume an unplaced plan, revise it, then cancel it.
    await page.getByRole('button', { name: 'Contacts', exact: true }).click();
    await page.getByRole('button', { name: 'Call Jamie', exact: true }).click();
    await page.locator('[data-method=phone]').click();
    await page.locator('#briefInput').fill('Ask about tomorrow.');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Call Now', exact: true })).toBeEnabled();
    await page.reload();
    await expect(page.locator('#authScreen')).toHaveClass(/hidden/);
    await page.getByRole('button', { name: 'Recent', exact: true }).click();
    await page.getByRole('button', { name: 'Chat', exact: true }).click();
    await page.locator('#recentChatsList .savedChatRow').filter({ hasText: 'Jamie' }).click();
    await expect(page.getByRole('button', { name: 'Call Now', exact: true })).toBeEnabled();
    await expect(page.locator('#preCallLabel')).toHaveText('Jamie · Phone');
    await page.getByRole('button', { name: 'Revise script', exact: true }).click();
    await expect(page.locator('#briefInput')).toHaveValue('Ask about tomorrow.');
    await page.locator('#briefInput').fill('Ask about next week instead.');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.locator('.callNowBtn:enabled')).toHaveCount(1);
    await expect(page.locator('.callNowBtn:disabled')).toHaveCount(1);
    await page.locator('#cancelPreCallBtn').click();
    await expect(page.locator('#preCallContext')).toBeHidden();
    await expect(page.locator('.callNowBtn:enabled')).toHaveCount(0);
    assert.equal(dialed, 2);
    await page.getByRole('button', { name: 'Profile', exact: true }).click();
    await expect(page.locator('#screen-profile')).toHaveClass(/active/);
    await expect(page.locator('#profileEmailDisplay')).toHaveText('Sam');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'No horizontal overflow');
    assert.deepEqual(errors, [], 'No runtime errors');
    await context.close();
    console.log(`Mobile flow passed at ${width}×${height}`);
  }
} finally {
  await browser.close();
  server.close();
}
