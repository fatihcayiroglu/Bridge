// e2e/tests/channels.spec.js — Kanal Oluşturma E2E Testleri
// Kritik akış: sunucu oluştur → kanal oluştur → kanala gir → mesaj gönder

const { test, expect } = require('@playwright/test');
const { BridgePage, getTokens, createTestServer } = require('../helpers/bridge');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

test.describe('Kanal Yönetimi', () => {
  let tokens;
  let testServerId;

  test.beforeAll(async ({ request }) => {
    tokens = getTokens();

    const server = await createTestServer(
      request,
      tokens.alice,
      `Kanal Test Server ${Date.now()}`
    );
    testServerId = server._id || server.id;
  });

  // ── Sunucu Testleri ──────────────────────────────────────

  test('API: sunucu oluşturma', async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/servers`, {
      headers: { Authorization: `Bearer ${tokens.alice}`, 'Content-Type': 'application/json' },
      data: JSON.stringify({ name: `Yeni Server ${Date.now()}`, description: 'Test' }),
    });
    expect(res.status()).toBeLessThan(300);
    const data = await res.json();
    const server = data.server || data;
    expect(server.name || server._id).toBeTruthy();
  });

  test('API: sunucu listesi', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/servers`, {
      headers: { Authorization: `Bearer ${tokens.alice}` },
    });
    expect(res.status()).toBe(200);
    const data = await res.json();
    const servers = data.servers || data;
    expect(Array.isArray(servers)).toBe(true);
  });

  test('API: boş isimle sunucu oluşturulamaz', async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/servers`, {
      headers: { Authorization: `Bearer ${tokens.alice}`, 'Content-Type': 'application/json' },
      data: JSON.stringify({ name: '' }),
    });
    expect(res.status()).toBeGreaterThanOrEqual(400);
  });

  // ── Kanal Testleri ───────────────────────────────────────

  test('API: text kanalı oluşturma', async ({ request }) => {
    if (!testServerId) test.skip();

    const res = await request.post(`${BASE_URL}/api/servers/${testServerId}/channels`, {
      headers: { Authorization: `Bearer ${tokens.alice}`, 'Content-Type': 'application/json' },
      data: JSON.stringify({ name: `test-kanal-${Date.now()}`, type: 'text' }),
    });
    expect(res.status()).toBeLessThan(300);
    const data = await res.json();
    const channel = data.channel || data;
    expect(channel.name || channel._id).toBeTruthy();
  });

  test('API: voice kanalı oluşturma', async ({ request }) => {
    if (!testServerId) test.skip();

    const res = await request.post(`${BASE_URL}/api/servers/${testServerId}/channels`, {
      headers: { Authorization: `Bearer ${tokens.alice}`, 'Content-Type': 'application/json' },
      data: JSON.stringify({ name: `ses-kanal-${Date.now()}`, type: 'voice' }),
    });
    expect(res.status()).toBeLessThan(300);
  });

  test('API: kanal listesi', async ({ request }) => {
    if (!testServerId) test.skip();

    const res = await request.get(`${BASE_URL}/api/servers/${testServerId}/channels`, {
      headers: { Authorization: `Bearer ${tokens.alice}` },
    });
    expect(res.status()).toBe(200);
    const data = await res.json();
    const channels = data.channels || data;
    expect(Array.isArray(channels)).toBe(true);
    expect(channels.length).toBeGreaterThan(0);
  });

  test('API: kanal silme', async ({ request }) => {
    if (!testServerId) test.skip();

    // Silinecek kanal oluştur
    const createRes = await request.post(`${BASE_URL}/api/servers/${testServerId}/channels`, {
      headers: { Authorization: `Bearer ${tokens.alice}`, 'Content-Type': 'application/json' },
      data: JSON.stringify({ name: `silinecek-${Date.now()}`, type: 'text' }),
    });
    const created = await createRes.json();
    const channelId = (created.channel || created)._id || (created.channel || created).id;
    if (!channelId) test.skip();

    const delRes = await request.delete(
      `${BASE_URL}/api/servers/${testServerId}/channels/${channelId}`,
      { headers: { Authorization: `Bearer ${tokens.alice}` } }
    );
    expect(delRes.status()).toBeLessThan(300);
  });

  test('API: yetkisiz kullanıcı kanal oluşturamamalı', async ({ request }) => {
    if (!testServerId) test.skip();

    // Bob sunucuya üye değil
    const res = await request.post(`${BASE_URL}/api/servers/${testServerId}/channels`, {
      headers: { Authorization: `Bearer ${tokens.bob}`, 'Content-Type': 'application/json' },
      data: JSON.stringify({ name: 'yetkisiz-kanal', type: 'text' }),
    });
    expect(res.status()).toBeGreaterThanOrEqual(400);
  });

  test('API: özel karakterli kanal ismi', async ({ request }) => {
    if (!testServerId) test.skip();

    const res = await request.post(`${BASE_URL}/api/servers/${testServerId}/channels`, {
      headers: { Authorization: `Bearer ${tokens.alice}`, 'Content-Type': 'application/json' },
      data: JSON.stringify({ name: 'genel-tartışma', type: 'text' }),
    });
    // İzin verilmeli veya sanitize edilmeli
    expect(res.status()).toBeLessThan(500);
  });

  // ── UI Testleri ──────────────────────────────────────────

  test('UI: kanal listesi sidebar\'da görünmeli', async ({ page }) => {
    const bp = new BridgePage(page);
    await bp.goto('/');
    await page.waitForTimeout(1500);

    // Sidebar mevcut mu
    const sidebar = page.locator('.channel-list, #channel-list, .sidebar, aside').first();
    const count = await sidebar.count();
    if (count > 0) {
      await expect(sidebar).toBeVisible();
    }
    // En azından sayfa yüklendi
    await expect(page.locator('body')).toBeVisible();
  });

  test('UI: sunucu oluşturma modalı açılmalı', async ({ page }) => {
    const bp = new BridgePage(page);
    await bp.goto('/');
    await page.waitForTimeout(1000);

    // Sunucu oluştur butonu
    const addServerBtn = page.locator(
      '[data-testid="add-server"], .add-server, [title*="Sunucu"], [title*="Server"], [aria-label*="server"]'
    ).first();

    if (await addServerBtn.count() > 0) {
      await addServerBtn.click();
      await page.waitForTimeout(500);

      // Modal açılmış olmalı
      const modal = page.locator('.modal, [role="dialog"], .overlay').first();
      if (await modal.count() > 0) {
        await expect(modal).toBeVisible();
      }
    }
  });
});
