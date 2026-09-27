// e2e/tests/bot-marketplace-journey.spec.ts
//
// Final21 Phase 14 — a server admin adds a bot from the marketplace in a real browser.
//
// Fixture (REST, deterministic): alice owns a "home" server with a bot that has a
// /ping command and is published; alice submits a listing asking for
// [commands, messages:reply]; the admin fixture approves it and binds the bot.
// Everything the admin does after that happens IN THE UI:
//   server menu → "Bot ekle" → search → details (plain-language permissions, trust)
//   → install → consent dialog → cancel (nothing installed) → install → confirm
//   → /ping from the composer → the bot's reply appears with the BOT badge
//   → uninstall with confirmation.
// The server's final state is asserted after each UI step, not just the UI.
// A fixture failure FAILS the test; it is never reported as a skip.

import { test, expect } from '../helpers/apiTest';
import type { APIRequestContext, Page } from '@playwright/test';
import { io, type Socket } from 'socket.io-client';
import tr from '../../client/js/core/i18n/tr';
import { apiRequest, getTokens } from '../helpers/bridge';

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:3000';
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'AdminPass123!';

test.use({ locale: 'tr-TR' });

interface Fixture {
  homeServerId: string;
  adminToken: string;
  listingId: string;
  listingName: string;
  targetServerId: string;
  channelName: string;
  botToken: string;
}

async function json<T>(res: Awaited<ReturnType<APIRequestContext['get']>>, label: string): Promise<T> {
  if (!res.ok()) throw new Error(`${label}: HTTP ${res.status()} ${await res.text()}`);
  return await res.json() as T;
}

async function buildFixture(request: APIRequestContext): Promise<Fixture> {
  const alice = getTokens().alice;
  const stamp = Date.now().toString(36);
  const home = await json<{ _id: string }>(await apiRequest(request, 'POST', `${BASE_URL}/api/servers`, { name: `Bot home ${stamp}`, icon: '🤖' }, alice), 'home server');
  const created = await json<{ bot: { _id: string }; token: string }>(
    await apiRequest(request, 'POST', `${BASE_URL}/api/servers/${home._id}/bots`, { name: `journey-bot-${stamp}` }, alice), 'create bot');
  const botHeaders = { Authorization: `Bot ${created.token}`, 'Content-Type': 'application/json' };
  await json(await request.patch(`${BASE_URL}/api/bots/me/slash-commands`, {
    headers: botHeaders, data: JSON.stringify({ commands: [{ name: 'ping', description: 'Ping' }] }),
  }), 'register command');
  await json(await apiRequest(request, 'PATCH', `${BASE_URL}/api/servers/${home._id}/bots/${created.bot._id}`, { isPublic: true }, alice), 'publish bot');

  const listingId = `journey-${stamp}`;
  const listingName = `Journey Bot ${stamp}`;
  await json(await apiRequest(request, 'POST', `${BASE_URL}/api/bots/marketplace`, {
    id: listingId, name: listingName, description: 'Pings back', category: 'tools',
    commands: ['ping'], permissions: ['commands', 'messages:reply'],
  }, alice), 'submit listing');
  const adminLogin = await json<{ token?: string }>(await request.post(`${BASE_URL}/api/login`, {
    headers: { 'Content-Type': 'application/json' },
    data: JSON.stringify({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD }),
  }), 'admin login');
  if (!adminLogin.token) throw new Error('admin login returned no token');
  await json(await apiRequest(request, 'PATCH', `${BASE_URL}/api/bots/marketplace/${listingId}`, { approved: true, executableBotId: created.bot._id }, adminLogin.token), 'approve listing');

  const target = await json<{ _id: string }>(await apiRequest(request, 'POST', `${BASE_URL}/api/servers`, { name: `Bot target ${stamp}`, icon: '🧩' }, alice), 'target server');
  const channels = await json<Array<{ name: string; type: string }>>(await apiRequest(request, 'GET', `${BASE_URL}/api/servers/${target._id}/channels`, undefined, alice), 'channels');
  const text = channels.find((channel) => channel.type === 'text');
  if (!text) throw new Error('target server has no text channel');
  return {
    homeServerId: home._id, adminToken: adminLogin.token, listingId, listingName,
    targetServerId: target._id, channelName: text.name, botToken: created.token,
  };
}

async function installState(request: APIRequestContext, fixture: Fixture): Promise<{ installed: string[]; grants: Record<string, string[]> }> {
  return json(await apiRequest(request, 'GET', `${BASE_URL}/api/bots/marketplace/installed?serverId=${fixture.targetServerId}`, undefined, getTokens().alice), 'installed');
}

async function openMarketplaceFromServerMenu(page: Page, fixture: Fixture): Promise<void> {
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#app')).toBeVisible({ timeout: 30_000 });
  await page.locator(`.server-icon[data-id="${fixture.targetServerId}"]`).first().click({ timeout: 25_000 });
  await page.locator('#server-header-btn').click();
  await page.getByRole('menuitem', { name: new RegExp(tr.server_menu_add_bots) }).click({ timeout: 15_000 });
  await expect(page.locator('#bot-marketplace-modal .mp-panel')).toBeVisible({ timeout: 15_000 });
}

test.describe('bot marketplace — admin journey in the browser', () => {
  let fixture: Fixture;
  let botSocket: Socket | null = null;

  test.beforeAll(async ({ request }) => {
    fixture = await buildFixture(request);
  });

  test.afterAll(async ({ request }) => {
    botSocket?.close();
    if (!fixture) return;
    // Leave no listing or servers behind; deleting the home server removes its bot.
    const alice = getTokens().alice;
    await apiRequest(request, 'DELETE', `${BASE_URL}/api/bots/marketplace/${fixture.listingId}`, undefined, fixture.adminToken);
    await apiRequest(request, 'DELETE', `${BASE_URL}/api/servers/${fixture.targetServerId}`, undefined, alice);
    await apiRequest(request, 'DELETE', `${BASE_URL}/api/servers/${fixture.homeServerId}`, undefined, alice);
  });

  test('discover, review permissions, consent, use, and remove a bot', async ({ page, request }) => {
    test.setTimeout(180_000);
    await openMarketplaceFromServerMenu(page, fixture);

    // Discovery: search narrows to the listing.
    await page.locator('#mp-search').fill(fixture.listingName);
    const card = page.locator(`.mp-card[data-bot-id="${fixture.listingId}"]`);
    await expect(card).toBeVisible({ timeout: 15_000 });

    // Permission clarity + trust signal in the details.
    await card.locator('.mp-btn-detail').click();
    const detail = page.locator('.mp-det-panel');
    await expect(detail.locator('.mp-perms-list')).toContainText(tr.bot_perm_commands);
    await expect(detail.locator('.mp-perms-list')).toContainText(tr.bot_perm_messages_reply);
    await expect(detail.locator('.mp-trust')).toContainText(tr.bot_author_unverified);
    await detail.locator('.mp-det-cls').click();

    // Consent: cancelling installs nothing.
    await card.locator('.mp-btn-inst').click();
    const dialog = page.locator('.bridge-product-dialog');
    await expect(dialog).toContainText(tr.bot_perm_messages_reply);
    await dialog.locator('[data-product-dialog-action="cancel"]').click();
    await expect(dialog).toBeHidden();
    expect((await installState(request, fixture)).installed).not.toContain(fixture.listingId);

    // Consent: confirming installs exactly the shown scopes.
    await card.locator('.mp-btn-inst').click();
    await dialog.locator('[data-product-dialog-action="confirm"]').click();
    await expect(card.locator('.mp-btn-inst')).toHaveText(tr.ui_kaldir, { timeout: 15_000 });
    const afterInstall = await installState(request, fixture);
    expect(afterInstall.installed).toContain(fixture.listingId);
    expect(afterInstall.grants[fixture.listingId]).toEqual(['commands', 'messages:reply']);
    await page.locator('.mp-close').click();

    // Use: the bot answers /ping; the reply carries the BOT badge.
    botSocket = io(BASE_URL, { auth: { token: fixture.botToken }, transports: ['websocket'], reconnection: false });
    await new Promise<void>((resolve, reject) => {
      botSocket!.once('botAuthenticated', () => resolve());
      botSocket!.once('connect_error', (err) => reject(err));
    });
    const replyText = `pong-${fixture.listingId}`;
    const replied = new Promise<number>((resolve) => {
      botSocket!.on('message:new', async (message: { _id: string; content?: string }) => {
        if (message.content !== '/ping journey') return;
        const res = await request.post(`${BASE_URL}/api/bots/interactions/${message._id}/reply`, {
          headers: { Authorization: `Bot ${fixture.botToken}`, 'Content-Type': 'application/json' },
          data: JSON.stringify({ content: replyText }),
        });
        resolve(res.status());
      });
    });
    await page.locator(`[aria-label="Kanal: ${fixture.channelName}"]`).first().click({ timeout: 20_000 });
    const composer = page.locator('#msg-input');
    await composer.click();
    await composer.fill('/ping journey');
    await composer.press('Enter');
    expect(await replied).toBe(200);
    const botMessage = page.locator('.msg', { hasText: replyText }).first();
    await expect(botMessage).toBeVisible({ timeout: 20_000 });
    await expect(botMessage.locator('.msg-app-badge')).toHaveText(tr.message_bot_badge);
    await expect(page.locator('.msg', { hasText: '/ping journey' }).first().locator('.msg-app-badge')).toHaveCount(0);

    // Uninstall from the marketplace, with confirmation.
    await page.locator('#server-header-btn').click();
    await page.getByRole('menuitem', { name: new RegExp(tr.server_menu_add_bots) }).click();
    await page.locator('#mp-search').fill(fixture.listingName);
    await card.locator('.mp-btn-inst').click();
    await dialog.locator('[data-product-dialog-action="confirm"]').click();
    await expect(card.locator('.mp-btn-inst')).toHaveText(tr.market_install, { timeout: 15_000 });
    expect((await installState(request, fixture)).installed).not.toContain(fixture.listingId);
  });
});
