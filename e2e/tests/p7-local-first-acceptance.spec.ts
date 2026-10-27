/**
 * P7 cross-pillar gates in a real browser (docs/P7_TRUST_SOCIAL_FOUNDATION.md,
 * A4 "Offline message history" and the "Cross-pillar closure gates" table):
 *   · offline channel open renders the cached window without the network;
 *   · account switch: zero cross-account local-content exposure.
 *
 * Not here: the offline RELOAD gate. A reload without network stays on the
 * sign-in screen because the session bootstrap (restoreSession in
 * client/js/core/auth-compat.ts) starts the app only after a successful
 * /api/me; opening local history before that is an open owner decision.
 *
 * The client unit suites (client/tests/local-first-*) cover the store, the
 * loader and the outbox in isolation. These tests drive the whole path: the
 * service worker, the history loader and the encrypted local store.
 */
import { test, expect } from '@playwright/test';
import type { APIRequestContext, BrowserContext, Page } from '@playwright/test';
import { getTokens, createTestServer, createTestChannel, registerFreshUser, loginViaUI } from '../helpers/bridge';

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:3000';
const PASSWORD = 'E2eTestPass987!';

async function openChannel(page: Page, serverId: string, channelName: string): Promise<void> {
  await page.locator(`.server-icon[data-id="${serverId}"]`).first().click({ timeout: 25_000 });
  await page.locator(`[aria-label="Kanal: ${channelName}"]`).first().click({ timeout: 20_000 });
  await page.locator('#msg-input').waitFor({ state: 'visible', timeout: 20_000 });
}

async function send(page: Page, body: string): Promise<void> {
  const composer = page.locator('#msg-input');
  await composer.click();
  await composer.fill(body);
  await composer.press('Enter');
  await expect(page.locator('.msg', { hasText: body }).first()).toBeVisible({ timeout: 20_000 });
  // The product's anti-spam limit is per user; stay under it.
  await page.waitForTimeout(1100);
}

/** Every IndexedDB value and web-storage string of this origin, searched for `needle` in plaintext. */
async function plaintextHits(page: Page, needle: string): Promise<string[]> {
  return page.evaluate(async (text: string) => {
    const hits: string[] = [];
    for (const [name, store] of [['localStorage', localStorage], ['sessionStorage', sessionStorage]] as const) {
      for (let i = 0; i < store.length; i++) {
        const key = store.key(i) ?? '';
        if ((store.getItem(key) ?? '').includes(text) || key.includes(text)) hits.push(`${name}:${key}`);
      }
    }
    const dbs = typeof indexedDB.databases === 'function' ? await indexedDB.databases() : [];
    for (const info of dbs) {
      if (!info.name) continue;
      const db = await new Promise<IDBDatabase | null>(resolve => {
        const open = indexedDB.open(info.name as string);
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => resolve(null);
      });
      if (!db) continue;
      for (const storeName of Array.from(db.objectStoreNames)) {
        const values = await new Promise<unknown[]>(resolve => {
          const req = db.transaction(storeName, 'readonly').objectStore(storeName).getAll();
          req.onsuccess = () => resolve(req.result as unknown[]);
          req.onerror = () => resolve([]);
        });
        for (const value of values) {
          let serialized = '';
          try { serialized = JSON.stringify(value) ?? ''; } catch { serialized = String(value); }
          if (serialized.includes(text)) { hits.push(`indexedDB:${info.name}/${storeName}`); break; }
        }
      }
      db.close();
    }
    return hits;
  }, needle);
}

async function markOnboardingSeen(context: BrowserContext, userId: string): Promise<void> {
  await context.addInitScript((uid: string) => {
    localStorage.setItem('bridge_onboarding_v3:anon', 'done');
    localStorage.setItem(`bridge_onboarding_v3:${uid}`, 'done');
  }, userId);
}

function userIdOf(token: string): string {
  const body = token.split('.')[1] ?? '';
  return String(JSON.parse(Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')).id ?? '');
}

async function accountWithChannel(request: APIRequestContext, label: string) {
  const { token, username } = await registerFreshUser(request, label);
  const srv = await createTestServer(request, token, `${label} home`);
  const serverId = srv?._id || srv?.id || '';
  const channelName = `${label}-${Date.now().toString(36)}`;
  const ch = await createTestChannel(request, token, serverId, channelName, 'text');
  expect(serverId && (ch?._id || ch?.id), `${label}: server and channel fixtures`).toBeTruthy();
  return { username, userId: userIdOf(token), serverId, channelName };
}

test.describe('P7 cross-pillar gates (real browser)', () => {
  let serverId = '';
  let cachedChannel = '';
  let otherChannel = '';

  test.beforeAll(async ({ request }) => {
    const token = getTokens().alice;
    const stamp = Date.now().toString(36);
    const srv = await createTestServer(request, token, `P7LF ${stamp}`);
    serverId = srv?._id || srv?.id || '';
    cachedChannel = `lf-${stamp}`;
    otherChannel = `lf-other-${stamp}`;
    const a = await createTestChannel(request, token, serverId, cachedChannel, 'text');
    const b = await createTestChannel(request, token, serverId, otherChannel, 'text');
    expect(serverId && (a?._id || a?.id) && (b?._id || b?.id), 'P7 local-first: fixtures').toBeTruthy();
  });

  test('A4: an offline channel open renders the cached window without the network', async ({ page, context }) => {
    test.setTimeout(120_000);
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#app')).toBeVisible({ timeout: 30_000 });
    await openChannel(page, serverId, cachedChannel);
    const bodies = [1, 2].map(i => `lf-open-${Date.now().toString(36)}-${i}`);
    for (const body of bodies) await send(page, body);
    await openChannel(page, serverId, otherChannel);

    await context.setOffline(true);
    try {
      await page.locator(`[aria-label="Kanal: ${cachedChannel}"]`).first().click({ timeout: 20_000 });
      for (const body of bodies) {
        await expect(page.locator('.msg', { hasText: body }).first()).toBeVisible({ timeout: 15_000 });
      }
    } finally {
      await context.setOffline(false);
    }
  });

  test('account switch: the next account sees none of the previous account\'s local content', async ({ browser, request }) => {
    test.setTimeout(150_000);
    const first = await accountWithChannel(request, 'lfa');
    const second = await accountWithChannel(request, 'lfb');
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    await markOnboardingSeen(context, first.userId);
    await markOnboardingSeen(context, second.userId);
    const page = await context.newPage();
    try {
      await loginViaUI(page, first.username, PASSWORD);
      await expect(page.locator('#app')).toBeVisible({ timeout: 25_000 });
      await openChannel(page, first.serverId, first.channelName);
      const secret = `lf-secret-${Date.now().toString(36)}`;
      await send(page, secret);
      expect(await plaintextHits(page, secret), 'no plaintext copy at rest while signed in').toEqual([]);

      await page.evaluate(() => document.querySelector('[data-bridge-action="openSettingsModal"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
      await page.locator('#tab-security').click();
      await page.getByTestId('sec-logout').click();
      await expect(page.locator('#auth-screen')).toBeVisible({ timeout: 15_000 });
      expect(await plaintextHits(page, secret), 'no plaintext copy after sign-out').toEqual([]);

      await loginViaUI(page, second.username, PASSWORD);
      await expect(page.locator('#app')).toBeVisible({ timeout: 25_000 });
      await openChannel(page, second.serverId, second.channelName);
      await expect(page.locator(`.server-icon[data-id="${first.serverId}"]`)).toHaveCount(0);
      expect(await page.locator('body').innerText()).not.toContain(secret);
      expect(await plaintextHits(page, secret), 'no plaintext copy visible to the next account').toEqual([]);
    } finally {
      await context.close();
    }
  });
});
