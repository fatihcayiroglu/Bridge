// e2e/tests/message-history-paging.spec.ts — the SHIPPED message-list scaling contract.
//
// Formerly virtual-scroll.spec.ts. That suite tested `window._bridgeVS`, a
// virtual-scroll debug API that was never implemented (only a type declaration
// exists), so its four tests skipped on every run. Virtualisation is not to be
// implemented just to turn those skips green.
//
// What Bridge ships instead is history PAGING (client/js/core/MessageLoader.svelte
// + MessageListPanel.svelte): opening a channel fetches only the newest
// PAGE_SIZE (50) messages; reaching the top of #messages-area loads the next
// older page through the REST cursor. That bounds the initial DOM no matter how
// long the history is — the property the old "DOM nodes stay under WINDOW_SIZE"
// test wanted — and is measured here in a real browser against a real server.
// The REST cursor itself is covered by cursor-pagination.spec.ts.

import { test, expect } from '../helpers/apiTest';
import type { Page } from '@playwright/test';
import { getTokens, createTestServer, createTestChannel } from '../helpers/bridge';
import { openSocket, closeSockets, joinChannelConfirmed, paceSends, waitForEvent } from '../helpers/socket';

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:3000';
const PAGE_SIZE = 50;               // MessageLoader.svelte: GET …/messages?limit=50
const TOTAL = PAGE_SIZE + 6;        // one full page + an older remainder

test.use({ storageState: 'fixtures/auth-state.json' }); // signed in as alice

test.describe('Message history paging in the message list', () => {
  test.describe.configure({ mode: 'serial' });

  let serverId = '';
  let channelId = '';
  let channelName = '';
  const contents: string[] = [];

  test.beforeAll(async ({ request }) => {
    test.setTimeout(240_000);
    const token = getTokens().alice;
    const stamp = Date.now();
    const server = await createTestServer(request, token, `Paging ${stamp}`);
    expect(server, 'paging server fixture').toBeTruthy();
    serverId = server._id || server.id;
    channelName = `paging-${stamp}`;
    const channel = await createTestChannel(request, token, serverId, channelName);
    expect(channel, 'paging channel fixture').toBeTruthy();
    channelId = channel._id || channel.id;

    const socket = await openSocket(token);
    try {
      await joinChannelConfirmed(socket, channelId, serverId, 6, 'alice');
      for (let i = 0; i < TOTAL; i++) {
        await paceSends('alice');
        const content = `paging-${String(i).padStart(3, '0')}-${stamp}`;
        const ackId = `paging-${stamp}-${i}`;
        const ack = waitForEvent<{ ackId: string; messageId: string }>(socket, 'message:ack', 15_000, a => a?.ackId === ackId);
        socket.emit('message:send', { channelId, serverId, content, ackId });
        expect((await ack).messageId, `message ${i} must be persisted`).toBeTruthy();
        contents.push(content);
      }
    } finally {
      closeSockets(socket);
    }
  });

  async function openChannel(page: Page): Promise<void> {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#app')).toBeVisible({ timeout: 30_000 });
    await page.locator(`.server-icon[data-id="${serverId}"]`).first().click({ timeout: 25_000 });
    await page.locator(`[aria-label="Kanal: ${channelName}"]`).first().click({ timeout: 20_000 });
    await expect(page.locator('#messages-area .msg', { hasText: contents[TOTAL - 1] })).toBeVisible({ timeout: 20_000 });
  }

  const rows = (page: Page) => page.locator('#messages-area article.msg[data-id]');

  test('opening a long channel renders only the newest page, and says older history exists', async ({ page }) => {
    await openChannel(page);
    // Exactly one page in the DOM: the initial render is bounded by PAGE_SIZE.
    await expect(rows(page)).toHaveCount(PAGE_SIZE);
    // The newest page is contents[TOTAL-PAGE_SIZE .. TOTAL-1]; everything older is not rendered.
    await expect(page.locator('#messages-area .msg', { hasText: contents[TOTAL - PAGE_SIZE] })).toHaveCount(1);
    for (const older of contents.slice(0, TOTAL - PAGE_SIZE)) {
      await expect(page.locator('#messages-area .msg', { hasText: older })).toHaveCount(0);
    }
    await expect(page.locator('#messages-area .msg-note')).toBeVisible();
  });

  test('reaching the top loads the older page in order, and the "older history" note goes away', async ({ page, request }) => {
    await openChannel(page);
    await expect(rows(page)).toHaveCount(PAGE_SIZE);
    await page.locator('#messages-area').evaluate(el => { el.scrollTop = 0; });
    await expect(page.locator('#messages-area .msg', { hasText: contents[0] })).toHaveCount(1, { timeout: 20_000 });
    // Every seeded message is now rendered once, oldest first.
    const texts = await rows(page).allInnerTexts();
    const order = contents.map(c => texts.findIndex(t => t.includes(c)));
    expect(order.every(i => i >= 0), 'every seeded message is rendered').toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    // The whole history (the seed plus the channel-join probe messages) is now rendered.
    const res = await request.get(`${BASE_URL}/api/channels/${channelId}/messages?limit=100`, {
      headers: { Authorization: `Bearer ${getTokens().alice}` },
    });
    expect(res.status()).toBe(200);
    const history = await res.json() as { messages: unknown[]; hasMore: boolean };
    expect(history.hasMore).toBe(false);
    expect(history.messages.length).toBeGreaterThan(PAGE_SIZE);
    await expect(rows(page)).toHaveCount(history.messages.length);
    await expect(page.locator('#messages-area .msg-note')).toHaveCount(0);
  });
});
