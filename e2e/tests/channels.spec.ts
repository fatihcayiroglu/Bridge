// e2e/tests/channels.spec.ts — Sprint 14: TypeScript dönüşümü (.js → .ts)
// e2e/tests/channels.spec.js — Kanal Oluşturma E2E Testleri
// Kritik akış: sunucu oluştur → kanal oluştur → kanala gir → mesaj gönder

import { test, expect } from '../helpers/apiTest';
import { BridgePage, getTokens, createTestServer } from '../helpers/bridge';

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:3000';

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
    expect(server, 'kanal yönetimi sunucu fikstürü oluşturulamadı').toBeTruthy();
    testServerId = server._id || server.id;
    expect(testServerId, 'kanal yönetimi sunucu kimliği eksik').toBeTruthy();
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
    expect(res.status(), await res.text()).toBe(400);
  });

  // ── Kanal Testleri ───────────────────────────────────────

  test('API: text kanalı oluşturma', async ({ request }) => {

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

    const res = await request.post(`${BASE_URL}/api/servers/${testServerId}/channels`, {
      headers: { Authorization: `Bearer ${tokens.alice}`, 'Content-Type': 'application/json' },
      data: JSON.stringify({ name: `ses-kanal-${Date.now()}`, type: 'voice' }),
    });
    expect(res.status()).toBeLessThan(300);
  });

  test('API: kanal listesi', async ({ request }) => {

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

    // Silinecek kanal oluştur
    const createRes = await request.post(`${BASE_URL}/api/servers/${testServerId}/channels`, {
      headers: { Authorization: `Bearer ${tokens.alice}`, 'Content-Type': 'application/json' },
      data: JSON.stringify({ name: `silinecek-${Date.now()}`, type: 'text' }),
    });
    const created = await createRes.json();
    const channelId = (created.channel || created)._id || (created.channel || created).id;

    const delRes = await request.delete(
      `${BASE_URL}/api/servers/${testServerId}/channels/${channelId}`,
      { headers: { Authorization: `Bearer ${tokens.alice}` } }
    );
    expect(delRes.status()).toBeLessThan(300);
  });

  test('API: yetkisiz kullanıcı kanal oluşturamamalı', async ({ request }) => {

    // Bob sunucuya üye değil
    const res = await request.post(`${BASE_URL}/api/servers/${testServerId}/channels`, {
      headers: { Authorization: `Bearer ${tokens.bob}`, 'Content-Type': 'application/json' },
      data: JSON.stringify({ name: 'yetkisiz-kanal', type: 'text' }),
    });
    expect(res.status(), await res.text()).toBe(403);
  });

  test('API: özel karakterli kanal ismi', async ({ request }) => {

    const res = await request.post(`${BASE_URL}/api/servers/${testServerId}/channels`, {
      headers: { Authorization: `Bearer ${tokens.alice}`, 'Content-Type': 'application/json' },
      data: JSON.stringify({ name: 'genel-tartışma', type: 'text' }),
    });
    // Türkçe harfler kanal adında izinlidir (lib/channelName.ts): 201 ve ad aynen
    // saklanır. `< 500` 403/404/429'u da "izin verildi" sayıyordu.
    expect(res.status(), await res.text()).toBe(201);
    expect((await res.json() as { name?: string }).name).toBe('genel-tartışma');
  });

  // ── UI Testleri ──────────────────────────────────────────

  test('UI: kanal listesi sidebar\'da görünmeli', async ({ page }) => {
    const bp = new BridgePage(page);
    await bp.goto('/');

    // Eskiden `if (count > 0)` içindeydi ve tek koşulsuz kontrol `body` görünürlüğüydü:
    // liste hiç çizilmese de geçerdi. Kanal listesi yalnızca bir sunucu seçiliyken
    // render edilir; bu paketin kendi sunucusu açılır ve varsayılan metin kanalı
    // ('general', ServerRepository.createWithDefaultsAtomic) listede görünmelidir.
    await page.locator(`.server-icon[data-id="${testServerId}"]`).first().click({ timeout: 15_000 });
    await expect(page.locator('.channel-list-host').first()).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('[aria-label="Kanal: general"]').first()).toBeVisible({ timeout: 10_000 });
  });

  test('UI: sunucu oluşturma modalı açılmalı', async ({ page }) => {
    const bp = new BridgePage(page);
    await bp.goto('/');

    // Eski seçicilerin (`add-server`, `[title*="Sunucu"]`…) hiçbiri istemcide yoktu ve
    // her iki kontrol de `if (count > 0)` içindeydi: test hiçbir şey ölçmeden geçiyordu.
    // Gerçek tetikleyici sunucu rayındaki düğmedir (index.html, `openServerStart`);
    // açtığı yüzey EmptyServerStart.svelte'nin modal diyaloğudur.
    const addServerBtn = page.locator('button.server-add[data-bridge-action="openServerStart"]');
    await expect(addServerBtn).toBeVisible({ timeout: 15_000 });
    await addServerBtn.click();
    await expect(page.locator('.empty-server-backdrop[role="dialog"][aria-modal="true"]')).toBeVisible({ timeout: 10_000 });
  });
});
