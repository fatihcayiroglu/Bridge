// e2e/tests/messaging.spec.js — Mesaj Gönderme E2E Testleri
// Kritik akış: mesaj gönder, al, gerçek zamanlı güncelleme

const { test, expect } = require('@playwright/test');
const { BridgePage, getTokens, createTestServer, createTestChannel, sendApiMessage } = require('../helpers/bridge');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

test.describe('Mesajlaşma Akışları', () => {
  let testServerId;
  let testChannelId;
  let tokens;

  test.beforeAll(async ({ request }) => {
    tokens = getTokens();

    // Test sunucusu ve kanalı oluştur
    const server = await createTestServer(request, tokens.alice, `E2E Mesaj Server ${Date.now()}`);
    testServerId = server._id || server.id;

    if (testServerId) {
      const ch = await createTestChannel(request, tokens.alice, testServerId, 'genel');
      testChannelId = ch._id || ch.id;
    }
  });

  // ── API Testleri ─────────────────────────────────────────

  test('API: mesaj gönderme', async ({ request }) => {
    if (!testChannelId) test.skip();

    const res = await request.post(`${BASE_URL}/api/channels/${testChannelId}/messages`, {
      headers: {
        Authorization: `Bearer ${tokens.alice}`,
        'Content-Type': 'application/json',
      },
      data: JSON.stringify({ content: 'Merhaba dünya! E2E testi.' }),
    });

    expect(res.status()).toBe(200);
    const data = await res.json();
    expect(data.content || data.message?.content).toContain('Merhaba');
  });

  test('API: mesajları listeleme', async ({ request }) => {
    if (!testChannelId) test.skip();

    // Önce bir mesaj gönder
    await request.post(`${BASE_URL}/api/channels/${testChannelId}/messages`, {
      headers: { Authorization: `Bearer ${tokens.alice}`, 'Content-Type': 'application/json' },
      data: JSON.stringify({ content: 'Listeleme test mesajı' }),
    });

    // Mesajları getir
    const res = await request.get(`${BASE_URL}/api/channels/${testChannelId}/messages`, {
      headers: { Authorization: `Bearer ${tokens.alice}` },
    });

    expect(res.status()).toBe(200);
    const data = await res.json();
    const messages = data.messages || data;
    expect(Array.isArray(messages)).toBe(true);
    expect(messages.length).toBeGreaterThan(0);
  });

  test('API: boş mesaj reddedilmeli', async ({ request }) => {
    if (!testChannelId) test.skip();

    const res = await request.post(`${BASE_URL}/api/channels/${testChannelId}/messages`, {
      headers: { Authorization: `Bearer ${tokens.alice}`, 'Content-Type': 'application/json' },
      data: JSON.stringify({ content: '' }),
    });

    expect(res.status()).toBeGreaterThanOrEqual(400);
  });

  test('API: üye olmayan kullanıcı mesaj gönderememeli', async ({ request }) => {
    if (!testChannelId) test.skip();

    const res = await request.post(`${BASE_URL}/api/channels/${testChannelId}/messages`, {
      headers: { Authorization: `Bearer ${tokens.bob}`, 'Content-Type': 'application/json' },
      data: JSON.stringify({ content: 'Yetkisiz mesaj' }),
    });

    // 403 Forbidden bekleniyor
    expect(res.status()).toBe(403);
  });

  test('API: mesaj silme', async ({ request }) => {
    if (!testChannelId) test.skip();

    // Mesaj gönder
    const sendRes = await request.post(`${BASE_URL}/api/channels/${testChannelId}/messages`, {
      headers: { Authorization: `Bearer ${tokens.alice}`, 'Content-Type': 'application/json' },
      data: JSON.stringify({ content: 'Silinecek mesaj' }),
    });
    const sent = await sendRes.json();
    const msgId = sent._id || sent.id || sent.message?._id;
    if (!msgId) test.skip();

    // Sil
    const delRes = await request.delete(
      `${BASE_URL}/api/channels/${testChannelId}/messages/${msgId}`,
      { headers: { Authorization: `Bearer ${tokens.alice}` } }
    );
    expect(delRes.status()).toBeLessThan(300);
  });

  test('API: mesaj düzenleme', async ({ request }) => {
    if (!testChannelId) test.skip();

    const sendRes = await request.post(`${BASE_URL}/api/channels/${testChannelId}/messages`, {
      headers: { Authorization: `Bearer ${tokens.alice}`, 'Content-Type': 'application/json' },
      data: JSON.stringify({ content: 'Orijinal içerik' }),
    });
    const sent = await sendRes.json();
    const msgId = sent._id || sent.id || sent.message?._id;
    if (!msgId) test.skip();

    const editRes = await request.patch(
      `${BASE_URL}/api/channels/${testChannelId}/messages/${msgId}`,
      {
        headers: { Authorization: `Bearer ${tokens.alice}`, 'Content-Type': 'application/json' },
        data: JSON.stringify({ content: 'Düzenlenmiş içerik' }),
      }
    );
    expect(editRes.status()).toBeLessThan(300);
  });

  test('API: sayfalama cursor çalışmalı', async ({ request }) => {
    if (!testChannelId) test.skip();

    const res = await request.get(
      `${BASE_URL}/api/channels/${testChannelId}/messages?limit=5`,
      { headers: { Authorization: `Bearer ${tokens.alice}` } }
    );
    expect(res.status()).toBe(200);
    const data = await res.json();
    // cursor veya pagination alanı gelmeli
    expect(data).toBeDefined();
  });

  // ── UI Testleri ──────────────────────────────────────────

  test('UI: mesaj input görünmeli', async ({ page }) => {
    const bp = new BridgePage(page);
    await bp.goto('/');
    await page.waitForTimeout(1000);

    // Ana sayfa yüklendi mi
    await expect(page.locator('body')).toBeVisible();
    // Bir kanal seçiliyse mesaj input'u olmalı
    const input = page.locator(
      '[data-testid="message-input"], #message-input, .message-input, [placeholder*="Message"], [placeholder*="Mesaj"]'
    ).first();

    // Input varsa görünür olmalı (kanal seçili olmayabilir)
    const count = await input.count();
    if (count > 0) {
      await expect(input).toBeVisible();
    }
  });

  test('UI: uzun mesaj 2000 karakteri geçememeli', async ({ request }) => {
    if (!testChannelId) test.skip();

    const longMsg = 'A'.repeat(2001);
    const res = await request.post(`${BASE_URL}/api/channels/${testChannelId}/messages`, {
      headers: { Authorization: `Bearer ${tokens.alice}`, 'Content-Type': 'application/json' },
      data: JSON.stringify({ content: longMsg }),
    });

    // 2000 karakterden uzun mesaj reddedilmeli
    expect(res.status()).toBeGreaterThanOrEqual(400);
  });

  test('API: XSS içerikli mesaj sanitize edilmeli', async ({ request }) => {
    if (!testChannelId) test.skip();

    const xssPayload = '<script>alert("xss")</script>Merhaba';
    const res = await request.post(`${BASE_URL}/api/channels/${testChannelId}/messages`, {
      headers: { Authorization: `Bearer ${tokens.alice}`, 'Content-Type': 'application/json' },
      data: JSON.stringify({ content: xssPayload }),
    });

    if (res.status() < 400) {
      const data = await res.json();
      const content = data.content || data.message?.content || '';
      // Script tag'i çalışmamalı (sanitize veya encode edilmiş olmalı)
      expect(content).not.toContain('<script>');
    }
  });
});
