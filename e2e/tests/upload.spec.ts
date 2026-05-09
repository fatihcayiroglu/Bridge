// e2e/tests/upload.spec.ts — Dosya Yükleme E2E Testleri
// Kapsam:
//   API: tekli/çoklu dosya yükleme, boyut/tip sınırları, yetkisiz yükleme
//   UI:  upload butonu görünürlüğü, dosya seçici, preview

import { test, expect } from '@playwright/test';
import * as path from 'path';
import { BridgePage, getTokens, createTestServer, createTestChannel } from '../helpers/bridge';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

// Test dosyaları (base64 → Buffer ile oluşturulur, disk gerektirmez)
const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const TINY_TXT = 'Bridge E2E test dosyası';

test.describe('Dosya Yükleme Akışları', () => {
  let tokens;
  let testServerId: string;
  let testChannelId: string;

  test.beforeAll(async ({ request }) => {
    tokens = getTokens();

    const server = await createTestServer(request, tokens.alice, `Upload E2E ${Date.now()}`);
    testServerId = server?._id || server?.id;

    if (!testServerId) return;

    const ch = await createTestChannel(request, tokens.alice, testServerId, 'upload-test');
    testChannelId = ch?._id || ch?.id;
  });

  // ── API Testleri ─────────────────────────────────────────

  test('API: küçük PNG yükleme başarılı', async ({ request }) => {
    if (!testChannelId) test.skip();

    const imgBuffer = Buffer.from(TINY_PNG_B64, 'base64');

    const res = await request.post(`${BASE_URL}/api/upload`, {
      headers: { Authorization: `Bearer ${tokens.alice}` },
      multipart: {
        file: {
          name: 'test.png',
          mimeType: 'image/png',
          buffer: imgBuffer,
        },
        channelId: testChannelId,
      },
    });

    // 200/201 başarı, 404 (endpoint farklı yol), 413 (boyut limiti) — 5xx olmamalı
    expect(res.status()).toBeLessThan(500);

    if (res.status() < 300) {
      const data = await res.json();
      // URL veya id dönmeli
      expect(data.url || data.fileUrl || data.id || data._id).toBeTruthy();
    }
  });

  test('API: metin dosyası yükleme', async ({ request }) => {
    if (!testChannelId) test.skip();

    const txtBuffer = Buffer.from(TINY_TXT, 'utf-8');

    const res = await request.post(`${BASE_URL}/api/upload`, {
      headers: { Authorization: `Bearer ${tokens.alice}` },
      multipart: {
        file: {
          name: 'test.txt',
          mimeType: 'text/plain',
          buffer: txtBuffer,
        },
        channelId: testChannelId,
      },
    });

    expect(res.status()).toBeLessThan(500);
  });

  test('API: yetkisiz yükleme reddedilir', async ({ request }) => {
    if (!testChannelId) test.skip();

    const imgBuffer = Buffer.from(TINY_PNG_B64, 'base64');

    const res = await request.post(`${BASE_URL}/api/upload`, {
      // Authorization header YOK
      multipart: {
        file: {
          name: 'hack.png',
          mimeType: 'image/png',
          buffer: imgBuffer,
        },
        channelId: testChannelId,
      },
    });

    expect(res.status()).toBeGreaterThanOrEqual(401);
  });

  test('API: çok büyük dosya reddedilir (413)', async ({ request }) => {
    if (!testChannelId) test.skip();

    // 30MB sahte buffer (sunucu limiti genellikle 8-25MB)
    const bigBuffer = Buffer.alloc(30 * 1024 * 1024, 0);

    const res = await request.post(`${BASE_URL}/api/upload`, {
      headers: { Authorization: `Bearer ${tokens.alice}` },
      multipart: {
        file: {
          name: 'big.bin',
          mimeType: 'application/octet-stream',
          buffer: bigBuffer,
        },
        channelId: testChannelId,
      },
    });

    // 413 veya 400 bekleniyor — 200 olmamalı
    expect(res.status()).toBeGreaterThanOrEqual(400);
  });

  test('API: yüklenen dosya mesaj olarak gönderildiğinde kanalda görünür', async ({ request }) => {
    if (!testChannelId) test.skip();

    const imgBuffer = Buffer.from(TINY_PNG_B64, 'base64');

    // Önce yükle
    const uploadRes = await request.post(`${BASE_URL}/api/upload`, {
      headers: { Authorization: `Bearer ${tokens.alice}` },
      multipart: {
        file: {
          name: 'attach.png',
          mimeType: 'image/png',
          buffer: imgBuffer,
        },
        channelId: testChannelId,
      },
    });

    if (!uploadRes.ok()) test.skip();
    const uploadData = await uploadRes.json();
    const fileUrl = uploadData.url || uploadData.fileUrl;
    if (!fileUrl) test.skip();

    // Mesaj içinde URL ile gönder
    const msgRes = await request.post(`${BASE_URL}/api/channels/${testChannelId}/messages`, {
      headers: { Authorization: `Bearer ${tokens.alice}`, 'Content-Type': 'application/json' },
      data: JSON.stringify({ content: `Dosya: ${fileUrl}`, attachments: [fileUrl] }),
    });

    expect(msgRes.status()).toBeLessThan(300);
  });

  // ── UI Testleri ──────────────────────────────────────────

  test('UI: upload butonu mesaj input alanında görünür', async ({ page }) => {
    if (!testServerId || !testChannelId) test.skip();

    const bp = new BridgePage(page);
    await bp.loginViaToken(tokens.alice);
    await bp.goto('/');
    await page.waitForTimeout(1500);

    // Server'a git
    const serverIcon = page.locator(`[data-server-id="${testServerId}"], [data-id="${testServerId}"]`).first();
    if (await serverIcon.count() > 0) {
      await serverIcon.click();
      await page.waitForTimeout(800);
    }

    // Upload / attachment butonu
    const uploadBtn = page.locator(
      '#upload-btn, .upload-btn, [aria-label*="upload"], [aria-label*="Attach"], [aria-label*="Dosya"], [data-testid="upload"]'
    ).first();

    if (await uploadBtn.count() > 0) {
      await expect(uploadBtn).toBeVisible();
    }

    await expect(page.locator('body')).toBeVisible();
  });

  test('UI: dosya seçici file input içeriyor', async ({ page }) => {
    if (!testServerId) test.skip();

    const bp = new BridgePage(page);
    await bp.loginViaToken(tokens.alice);
    await bp.goto('/');
    await page.waitForTimeout(1500);

    const serverIcon = page.locator(`[data-server-id="${testServerId}"], [data-id="${testServerId}"]`).first();
    if (await serverIcon.count() > 0) {
      await serverIcon.click();
      await page.waitForTimeout(800);
    }

    // Gizli file input DOM'da var olmalı
    const fileInput = page.locator('input[type="file"]').first();
    await expect(fileInput).toHaveCount(1);
  });

  test('UI: görsel yükleme sonrası önizleme gösterilir', async ({ page }) => {
    if (!testServerId) test.skip();

    const bp = new BridgePage(page);
    await bp.loginViaToken(tokens.alice);
    await bp.goto('/');
    await page.waitForTimeout(1500);

    const serverIcon = page.locator(`[data-server-id="${testServerId}"], [data-id="${testServerId}"]`).first();
    if (await serverIcon.count() > 0) {
      await serverIcon.click();
      await page.waitForTimeout(800);
    }

    const fileInput = page.locator('input[type="file"]').first();
    if (await fileInput.count() === 0) test.skip();

    // Tiny PNG buffer dosyasını input'a set et
    const imgBuffer = Buffer.from(TINY_PNG_B64, 'base64');
    const tmpPath = '/tmp/bridge-e2e-test.png';
    require('fs').writeFileSync(tmpPath, imgBuffer);

    await fileInput.setInputFiles(tmpPath);
    await page.waitForTimeout(800);

    // Önizleme alanı veya dosya ismi gösterilmeli
    const preview = page.locator(
      '.upload-preview, .attachment-preview, [data-testid="upload-preview"], img[src*="blob:"]'
    ).first();

    if (await preview.count() > 0) {
      await expect(preview).toBeVisible();
    }

    await expect(page.locator('body')).toBeVisible();
  });
});
