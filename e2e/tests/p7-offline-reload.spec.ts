/**
 * P7 offline reload (owner decision on #497, 2026-10-27), real browser:
 * a previously authorized user reopens Bridge on the same device with NO
 * network and sees that account's encrypted local history, then reconnects
 * and reconciles. Every other case fails closed to the sign-in screen.
 *
 * The network is really unavailable (context.setOffline), so the reload's
 * /api/me never reaches the server either. Each test uses its own accounts;
 * a logout or revocation never touches the shared fixture users.
 */
import { test, expect } from '@playwright/test';
import type { APIRequestContext, Browser, BrowserContext, Page } from '@playwright/test';
import {
  createInvite, createTestChannel, createTestServer, joinServerViaInvite, loginViaUI, registerFreshUser,
} from '../helpers/bridge';
import { getCsrf } from '../helpers/csrf';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:3000';

test.use({ storageState: { cookies: [], origins: [] } });

interface Account { token: string; username: string; password: string; userId: string }
interface Place { serverId: string; channelId: string; channelName: string }

function userIdOf(token: string): string {
  const body = token.split('.')[1] ?? '';
  return String(JSON.parse(Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')).id ?? '');
}

async function account(request: APIRequestContext, label: string): Promise<Account> {
  const a = await registerFreshUser(request, label);
  return { ...a, userId: userIdOf(a.token) };
}

async function place(request: APIRequestContext, owner: Account, label: string): Promise<Place> {
  const stamp = Date.now().toString(36);
  const srv = await createTestServer(request, owner.token, `${label} ${stamp}`);
  const serverId = String(srv?._id ?? srv?.id ?? '');
  // The server stores channel names in lower case.
  const channelName = `${label}-${stamp}`.toLowerCase();
  const ch = await createTestChannel(request, owner.token, serverId, channelName, 'text');
  const channelId = String(ch?._id ?? ch?.id ?? '');
  expect(serverId && channelId, `${label}: fixtures`).toBeTruthy();
  return { serverId, channelId, channelName };
}

async function signedIn(browser: Browser, who: Account): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  await context.addInitScript((uid: string) => {
    localStorage.setItem('bridge_onboarding_v3:anon', 'done');
    localStorage.setItem(`bridge_onboarding_v3:${uid}`, 'done');
  }, who.userId);
  const page = await context.newPage();
  await loginViaUI(page, who.username, who.password);
  await expect(page.locator('#app')).toBeVisible({ timeout: 25_000 });
  return { context, page };
}

async function openChannel(page: Page, at: Place): Promise<void> {
  await page.locator(`.server-icon[data-id="${at.serverId}"]`).first().click({ timeout: 25_000 });
  await page.locator(`[aria-label="Kanal: ${at.channelName}"]`).first().click({ timeout: 20_000 });
  await page.locator('#msg-input').waitFor({ state: 'visible', timeout: 20_000 });
}

async function send(page: Page, body: string): Promise<void> {
  const composer = page.locator('#msg-input');
  await composer.click();
  await composer.fill(body);
  await composer.press('Enter');
  await expect(page.locator('.msg', { hasText: body }).first()).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(1100); // the product's per-user send rate
}

/** Encrypted record ids of this origin's local-first store (ids only, never contents). */
async function recordIds(page: Page): Promise<string[]> {
  return page.evaluate(async () => new Promise<string[]>(resolve => {
    const open = indexedDB.open('bridge-local-first-records-v1');
    open.onerror = () => resolve([]);
    open.onsuccess = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains('records')) { db.close(); resolve([]); return; }
      const req = db.transaction('records', 'readonly').objectStore('records').getAllKeys();
      req.onsuccess = () => { db.close(); resolve((req.result as IDBValidKey[]).map(String)); };
      req.onerror = () => { db.close(); resolve([]); };
    };
  }));
}

/** The page is served by the service worker and this account's offline grant is stored. */
async function readyForOffline(page: Page, who: Account): Promise<void> {
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.locator('#app')).toBeVisible({ timeout: 25_000 });
  expect(await page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
  await expect.poll(async () => (await recordIds(page)).includes(`u:${who.userId}|n:session|r:offline-grant`),
    { timeout: 15_000, message: 'offline grant stored after a server-validated session' }).toBe(true);
}

async function offlineReload(page: Page, context: BrowserContext): Promise<void> {
  await context.setOffline(true);
  await page.reload({ waitUntil: 'domcontentloaded' });
}

async function expectSignIn(page: Page): Promise<void> {
  await expect(page.locator('#login-form')).toBeVisible({ timeout: 25_000 });
  await expect(page.locator('#app')).toBeHidden();
}

async function editGrant(page: Page, who: Account, edit: 'delete' | 'tamper'): Promise<void> {
  const id = `u:${who.userId}|n:session|r:offline-grant`;
  await page.evaluate(async ({ id, edit }) => new Promise<void>((resolve, reject) => {
    const open = indexedDB.open('bridge-local-first-records-v1');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const store = db.transaction('records', 'readwrite').objectStore('records');
      const get = store.get(id);
      get.onsuccess = () => {
        const row = get.result as { envelope: { ct: string } } | undefined;
        if (!row) { db.close(); reject(new Error('no grant')); return; }
        const done = edit === 'delete' ? store.delete(id) : store.put({
          ...row, envelope: { ...row.envelope, ct: (row.envelope.ct[0] === 'A' ? 'B' : 'A') + row.envelope.ct.slice(1) },
        });
        done.onsuccess = () => { db.close(); resolve(); };
        done.onerror = () => { db.close(); reject(done.error); };
      };
    };
  }), { id, edit });
}

async function logoutViaSecurityTab(page: Page): Promise<void> {
  await page.evaluate(() => document.querySelector('[data-bridge-action="openSettingsModal"]')
    ?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  await page.locator('#tab-security').click();
  await page.getByTestId('sec-logout').click();
  await expectSignIn(page);
}

test.describe('P7 offline reload (real browser, network unavailable)', () => {
  test('reopens the account\'s encrypted local history offline, then reconnects and reconciles', async ({ browser, request }) => {
    test.setTimeout(180_000);
    const alice = await account(request, 'p7orA');
    const at = await place(request, alice, 'p7or');
    const { context, page } = await signedIn(browser, alice);
    try {
      await openChannel(page, at);
      const bodies = [1, 2, 3].map(i => `or-cached-${Date.now().toString(36)}-${i}`);
      for (const body of bodies) await send(page, body);
      await readyForOffline(page, alice);

      await offlineReload(page, context);
      await expect(page.locator('#app'), 'signed-in shell without any network').toBeVisible({ timeout: 25_000 });
      await expect(page.locator('#login-form')).toBeHidden();
      await openChannel(page, at); // the rail and the channel list come from the encrypted snapshot
      for (const body of bodies) await expect(page.locator('.msg', { hasText: body }).first()).toBeVisible({ timeout: 15_000 });

      // Written on the server while this device is offline, by the same
      // account on another device (messages are sent over the socket).
      const later = `or-while-offline-${Date.now().toString(36)}`;
      const other = await signedIn(browser, alice);
      try {
        await openChannel(other.page, at);
        await send(other.page, later);
      } finally {
        await other.context.close();
      }
      await expect(page.locator('.msg', { hasText: later })).toHaveCount(0);

      // Reconnect: /api/me validates again and the channel converges.
      const validated = page.waitForResponse(r => new URL(r.url()).pathname === '/api/me' && r.status() === 200, { timeout: 60_000 });
      await context.setOffline(false);
      await validated;
      await expect(page.locator('.msg', { hasText: later }).first()).toBeVisible({ timeout: 30_000 });
      for (const body of bodies) await expect(page.locator('.msg', { hasText: body }).first()).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test('fails closed with no prior local proof', async ({ browser, request }) => {
    test.setTimeout(120_000);
    const who = await account(request, 'p7orNoProof');
    await place(request, who, 'p7orNP');
    const { context, page } = await signedIn(browser, who);
    try {
      await readyForOffline(page, who);
      await editGrant(page, who, 'delete');
      await offlineReload(page, context);
      await expectSignIn(page);
    } finally { await context.close(); }
  });

  test('fails closed for another account\'s token on this device', async ({ browser, request }) => {
    test.setTimeout(120_000);
    const who = await account(request, 'p7orOwner');
    const other = await account(request, 'p7orOther');
    await place(request, who, 'p7orOA');
    const { context, page } = await signedIn(browser, who);
    try {
      await readyForOffline(page, who);
      await page.evaluate((t: string) => { localStorage.setItem('token', t); localStorage.setItem('bridge_token', t); }, other.token);
      await offlineReload(page, context);
      await expectSignIn(page);
    } finally { await context.close(); }
  });

  test('fails closed after logout, even if the old token is put back', async ({ browser, request }) => {
    test.setTimeout(120_000);
    const who = await account(request, 'p7orLogout');
    await place(request, who, 'p7orLO');
    const { context, page } = await signedIn(browser, who);
    try {
      await readyForOffline(page, who);
      const oldToken = await page.evaluate(() => localStorage.getItem('token'));
      await logoutViaSecurityTab(page);
      await expect.poll(async () => (await recordIds(page)).some(id => id.startsWith(`u:${who.userId}|n:session|`)),
        { timeout: 15_000 }).toBe(false);
      await page.evaluate((t: string) => { localStorage.setItem('token', t); localStorage.setItem('bridge_token', t); }, String(oldToken));
      await offlineReload(page, context);
      await expectSignIn(page);
    } finally { await context.close(); }
  });

  test('fails closed when the grant was tampered with', async ({ browser, request }) => {
    test.setTimeout(120_000);
    const who = await account(request, 'p7orCorrupt');
    await place(request, who, 'p7orCR');
    const { context, page } = await signedIn(browser, who);
    try {
      await readyForOffline(page, who);
      await editGrant(page, who, 'tamper');
      await offlineReload(page, context);
      await expectSignIn(page);
    } finally { await context.close(); }
  });

  test('fails closed once the grant has expired (device clock 8 days later)', async ({ browser, request }) => {
    test.setTimeout(120_000);
    const who = await account(request, 'p7orExpired');
    await place(request, who, 'p7orEX');
    const { context, page } = await signedIn(browser, who);
    try {
      await readyForOffline(page, who);
      await page.clock.install({ time: new Date(Date.now() + 8 * 24 * 60 * 60 * 1000) });
      await offlineReload(page, context);
      await expectSignIn(page);
    } finally { await context.close(); }
  });

  test('a session revoked while offline: local history meanwhile, sign-in on reconnect, then no offline access', async ({ browser, request }) => {
    test.setTimeout(180_000);
    const who = await account(request, 'p7orRevoked');
    const at = await place(request, who, 'p7orRV');
    const { context, page } = await signedIn(browser, who);
    try {
      await openChannel(page, at);
      const body = `or-revoked-${Date.now().toString(36)}`;
      await send(page, body);
      await readyForOffline(page, who);

      await offlineReload(page, context);
      await expect(page.locator('#app')).toBeVisible({ timeout: 25_000 });
      // Every session of this account is ended on the server meanwhile.
      const revoke = await request.post(`${BASE}/api/logout-all`, {
        headers: { Authorization: `Bearer ${who.token}`, 'Content-Type': 'application/json', 'X-CSRF-Token': await getCsrf(request, who.token) },
      });
      expect(revoke.ok(), 'logout-all').toBe(true);

      await context.setOffline(false);
      await expectSignIn(page);
      await expect(page.locator('.msg', { hasText: body })).toHaveCount(0);
      await expect.poll(async () => (await recordIds(page)).some(id => id.startsWith(`u:${who.userId}|n:session|`)),
        { timeout: 15_000 }).toBe(false);
      await offlineReload(page, context);
      await expectSignIn(page);
    } finally { await context.close(); }
  });

  test('fails closed after the account was deleted and its local data erased', async ({ browser, request }) => {
    test.setTimeout(180_000);
    const owner = await account(request, 'p7orErOwner');
    const at = await place(request, owner, 'p7orER');
    const leaving = await account(request, `p7orEr${Date.now().toString(36)}`);
    const code = await createInvite(request, owner.token, at.serverId);
    expect((await joinServerViaInvite(request, leaving.token, String(code))).ok(), 'join').toBe(true);
    const { context, page } = await signedIn(browser, leaving);
    try {
      await openChannel(page, at);
      await send(page, `or-erased-${Date.now().toString(36)}`);
      await readyForOffline(page, leaving);
      const oldToken = await page.evaluate(() => localStorage.getItem('token'));

      await page.locator('[data-bridge-action="openSettingsModal"]').first().click();
      await page.locator('#tab-privacy').click();
      await page.getByTestId('delete-account-start').click();
      await page.getByTestId('delete-account-password').fill(leaving.password);
      await page.getByTestId('delete-account-ack').check();
      await page.getByTestId('delete-account-confirm').click();
      await expectSignIn(page);
      await expect.poll(async () => (await recordIds(page)).some(id => id.startsWith(`u:${leaving.userId}|`)),
        { timeout: 20_000, message: 'local erasure removed every record of the account' }).toBe(false);

      await page.evaluate((t: string) => { localStorage.setItem('token', t); localStorage.setItem('bridge_token', t); }, String(oldToken));
      await offlineReload(page, context);
      await expectSignIn(page);
    } finally { await context.close(); }
  });
});
