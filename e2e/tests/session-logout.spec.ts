// e2e/tests/session-logout.spec.ts
//
// P4 — LOGOUT IS REACHABLE AND ACTUALLY ENDS THE SESSION (real browser, real server).
//
// MEASURED before the fix (Chromium, phone viewport, local server):
//   · no visible logout control anywhere — 0 in the shell, 0 in all six settings tabs;
//   · the client's logout request went to `/api/logout` with `redirect: 'error'`; the refresh cookie
//     is path-scoped to `/api/refresh` so the server answered 307, the redirect was not followed
//     (the service worker even turned it into a synthetic 503), and `/api/refresh` still returned
//     200 afterwards — the session survived "logout".

import { test, expect, type Page, type BrowserContext, type APIRequestContext } from '@playwright/test';
import { registerFreshUser, loginViaUI, createTestServer } from '../helpers/bridge';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:3000';
const PASSWORD = 'E2eTestPass987!';

// Every context starts signed OUT: the project default signs contexts in as a shared fixture
// user, and logging that user out would break unrelated suites.
test.use({ storageState: { cookies: [], origins: [] } });

/** First-use onboarding is marked as seen for this account (same treatment as the P2/P3 suites). */
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

/**
 * A brand-new account with no servers gets the first-run "start a server" dialog, which covers the
 * shell. That flow is not what this suite measures, so each account owns one server beforehand.
 */
async function freshAccountWithServer(request: APIRequestContext, label: string): Promise<{ username: string; userId: string }> {
  const { token, username } = await registerFreshUser(request, label);
  const list = await request.get(`${BASE}/api/servers`, { headers: { Authorization: `Bearer ${token}` } });
  const servers = list.ok() ? await list.json() as unknown[] : [];
  if (!Array.isArray(servers) || servers.length === 0) {
    const created = await createTestServer(request, token, `${label} home`);
    if (!created) throw new Error(`could not create a server for ${label}`);
  }
  return { username, userId: userIdOf(token) };
}

async function signIn(page: Page, username: string): Promise<void> {
  await loginViaUI(page, username, PASSWORD);
  await expect(page.locator('#app')).toBeVisible({ timeout: 25_000 });
}

/**
 * The refresh cookie this browser holds right now. After logout the browser drops it, so a check
 * made from the page would pass even if the server never revoked anything; the captured value is
 * replayed from the test runner instead. Exactly ONE replay per check: the refresh endpoint is
 * rate-limited and repeated misses earn the IP an automatic ban (measured — do not poll it).
 */
async function refreshCookie(context: BrowserContext): Promise<string> {
  const cookie = (await context.cookies(`${BASE}/api/refresh`)).find((c) => c.name === 'bridge_refresh');
  if (!cookie) throw new Error('no bridge_refresh cookie after sign-in');
  return cookie.value;
}

async function replayRefresh(request: APIRequestContext, value: string): Promise<number> {
  const res = await request.post(`${BASE}/api/refresh`, {
    headers: { 'Content-Type': 'application/json', Cookie: `bridge_refresh=${value}` },
    data: {},
  });
  return res.status();
}

function logoutFinished(page: Page) {
  return page.waitForResponse((r) => r.url().endsWith('/api/refresh/logout') && r.request().method() === 'POST', { timeout: 15_000 });
}

async function openSecurityTab(page: Page): Promise<void> {
  await page.evaluate(() => document.querySelector('[data-bridge-action="openSettingsModal"]')
    ?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  await page.locator('#tab-security').click();
  await expect(page.getByTestId('sec-sessions')).toBeVisible();
}

test.describe('P4 — session logout', () => {
  test('Security › Log out returns to sign-in and the refresh session is revoked server-side', async ({ browser, request }) => {
    const { username, userId } = await freshAccountWithServer(request, 'p4logout');
    const context = await browser.newContext({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true });
    await markOnboardingSeen(context, userId);
    const page = await context.newPage();
    await signIn(page, username);
    const cookie = await refreshCookie(context);

    await openSecurityTab(page);
    const done = logoutFinished(page);
    await page.getByTestId('sec-logout').click();
    expect((await done).status()).toBe(200);

    await expect(page.locator('#auth-screen')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('#app')).toBeHidden();
    // Before P4 this replay returned 200: the session outlived "logout".
    expect(await replayRefresh(request, cookie)).toBe(401);

    // A reload must not resurrect the session.
    await page.reload();
    await expect(page.locator('#l-username')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('#app')).toBeHidden();
    await context.close();
  });

  test('Log out on all devices ends the OTHER browser\'s session too (two-step confirm)', async ({ browser, request }) => {
    const { username, userId } = await freshAccountWithServer(request, 'p4logoutall');
    const phone = await browser.newContext({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true });
    const laptop = await browser.newContext();
    await markOnboardingSeen(phone, userId);
    await markOnboardingSeen(laptop, userId);
    const phonePage = await phone.newPage();
    const laptopPage = await laptop.newPage();
    await signIn(phonePage, username);
    await signIn(laptopPage, username);
    const laptopCookie = await refreshCookie(laptop);

    await openSecurityTab(phonePage);
    const all = phonePage.getByTestId('sec-logout-all');
    await all.click();
    // First tap only arms the action.
    await expect(phonePage.locator('#app')).toBeVisible();
    await expect(phonePage.getByTestId('sec-logout-all-cancel')).toBeVisible();
    const done = phonePage.waitForResponse((r) => r.url().endsWith('/api/logout-all'), { timeout: 15_000 });
    await all.click();
    expect((await done).status()).toBe(200);

    await expect(phonePage.locator('#auth-screen')).toBeVisible({ timeout: 15_000 });
    expect(await replayRefresh(request, laptopCookie)).toBe(401);
    // The other browser's access token no longer works either (tokenVersion bumped).
    const laptopMe = await laptopPage.evaluate(async () => (await fetch('/api/me', {
      headers: { Authorization: `Bearer ${localStorage.getItem('token') ?? ''}` },
    })).status);
    expect(laptopMe).toBe(401);
    await phone.close();
    await laptop.close();
  });

  test('wide layout shows Log out at the bottom of the settings sidebar', async ({ browser, request }) => {
    const { username, userId } = await freshAccountWithServer(request, 'p4logoutwide');
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await markOnboardingSeen(context, userId);
    const page = await context.newPage();
    await signIn(page, username);
    const cookie = await refreshCookie(context);
    await page.evaluate(() => document.querySelector('[data-bridge-action="openSettingsModal"]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    const sidebarLogout = page.getByTestId('settings-logout');
    await expect(sidebarLogout).toBeVisible();
    const done = logoutFinished(page);
    await sidebarLogout.click();
    expect((await done).status()).toBe(200);
    await expect(page.locator('#auth-screen')).toBeVisible({ timeout: 15_000 });
    expect(await replayRefresh(request, cookie)).toBe(401);
    await context.close();
  });
});

test('BASE is loopback (this suite logs real sessions out)', () => {
  expect(new URL(BASE).hostname).toMatch(/^(127\.0\.0\.1|localhost)$/);
});
