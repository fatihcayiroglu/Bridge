// Real client, HTTP authorization and PostgreSQL: an OS-style channel intent
// survives session revalidation while its first authorized response is held.
import { test, expect } from '@playwright/test';
import { createTestServer, createTestChannel, getTokens } from '../helpers/bridge';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:3000';
// Packaged native routing does not use the browser service worker. Keep the
// delayed HTTP response under this test's control instead of a worker's fetch.
test.use({ serviceWorkers: 'block' });

test('revalidates a pending native channel link after the same account restarts its session', async ({ page, request }) => {
  const stamp = Date.now().toString(36);
  const token = getTokens().alice;
  const server = await createTestServer(request, token, `native recovery ${stamp}`);
  const serverId = String(server?._id ?? server?.id ?? '');
  const channelName = `native-recovery-${stamp}`;
  const channel = await createTestChannel(request, token, serverId, channelName, 'text');
  const channelId = String(channel?._id ?? channel?.id ?? '');
  expect(serverId && channelId, 'real authorized destination fixtures').toBeTruthy();

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#app')).toBeVisible();
  await page.locator(`.server-icon[data-id="${serverId}"]`).click();
  await expect(page.locator(`.ch-item[data-id="${channelId}"]`)).toBeVisible();
  await expect(page.locator(`.ch-item[data-id="${channelId}"] .ch-open`)).not.toHaveAttribute('aria-current', 'page');

  let release!: () => void;
  let held = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let requests = 0;
  const path = `/api/servers/${serverId}/channels`;
  await page.route(`**${path}`, async route => {
    requests++;
    if (requests !== 1) { await route.continue(); return; }
    // Hold an actual server-authorized response, never a fabricated list.
    const authorized = await route.fetch();
    expect(authorized.ok()).toBe(true);
    expect((await authorized.json()).some((c: { _id: string }) => c._id === channelId)).toBe(true);
    held = true;
    await gate;
    await route.fulfill({ response: authorized });
  });

  try {
    await page.evaluate(({ channelId, serverId }) => {
      const w = window as Window & { __bridgePendingDeepLinks?: unknown[] };
      w.__bridgePendingDeepLinks = [{ type: 'navigate:channel', channelId, serverId }];
      window.dispatchEvent(new CustomEvent('bridge:deeplink'));
    }, { channelId, serverId });
    await expect.poll(() => held, { message: 'hold the first real authorized channel lookup' }).toBe(true);
    await page.evaluate(async () => {
      const w = window as unknown as Window & {
        currentUser: Record<string, unknown>;
        startApp(token: string, user: Record<string, unknown>): Promise<void>;
      };
      // The already authenticated account enters the same production path as
      // restoreSession/login; this runs the real capture-phase HTTP fence.
      await w.startApp(String(localStorage.getItem('token')), w.currentUser);
    });
    await expect.poll(() => requests, { message: 'fresh authorization after the session stabilizes' }).toBeGreaterThanOrEqual(2);
    release();
    await expect(page.locator(`.ch-item[data-id="${channelId}"] .ch-open`)).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('#ch-h-name')).toHaveText(channelName);
  } finally {
    release();
    await page.unrouteAll({ behavior: 'wait' });
  }
});
