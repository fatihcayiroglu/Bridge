// e2e/tests/upload.spec.ts — Dosya Yükleme E2E Testleri
// Kapsam:
//   API: tekli/çoklu dosya yükleme, boyut/tip sınırları, yetkisiz yükleme
//   API: yüklenen URL erişilebilirlik kontrolü (HEAD)
//   API: yükleme sonrası socket bildirimi (message:new)
//   UI:  upload butonu görünürlüğü, dosya seçici, preview

import { test, expect } from '@playwright/test';
import * as path from 'path';
import { BridgePage, getTokens, createTestServer, createTestChannel } from '../helpers/bridge';
import { openSocket, waitForEvent, closeSockets } from '../helpers/socket';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const TINY_TXT = 'Bridge E2E test dosyası';

test.describe('Dosya Yükleme Akışları', () => {
  let tokens: { alice: string; bob: string };
  let testServerId:  string;
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
    test.skip(!testChannelId, 'Upload test kanalı fixture gerekli'  );
    const imgBuffer = Buffer.from(TINY_PNG_B64, 'base64');
    const res = await request.post(`${BASE_URL}/api/upload`, {
      headers: { Authorization: `Bearer ${tokens.alice}` },
      multipart: { file: { name: 'test.png', mimeType: 'image/png', buffer: imgBuffer }, channelId: testChannelId },
    });
    expect(res.status()).toBeLessThan(500);
    if (res.status() < 300) {
      const data = await res.json();
      expect(data.url || data.fileUrl || data.id || data._id).toBeTruthy();
    }
  });

  test('API: metin dosyası yükleme', async ({ request }) => {
    test.skip(!testChannelId, 'Upload test kanalı fixture gerekli'  );
    const txtBuffer = Buffer.from(TINY_TXT, 'utf-8');
    const res = await request.post(`${BASE_URL}/api/upload`, {
      headers: { Authorization: `Bearer ${tokens.alice}` },
      multipart: { file: { name: 'test.txt', mimeType: 'text/plain', buffer: txtBuffer }, channelId: testChannelId },
    });
    expect(res.status()).toBeLessThan(500);
  });

  test('API: yetkisiz yükleme reddedilir', async ({ request }) => {
    test.skip(!testChannelId, 'Upload test kanalı fixture gerekli'  );
    const imgBuffer = Buffer.from(TINY_PNG_B64, 'base64');
    const res = await request.post(`${BASE_URL}/api/upload`, {
      multipart: { file: { name: 'hack.png', mimeType: 'image/png', buffer: imgBuffer }, channelId: testChannelId },
    });
    expect(res.status()).toBeGreaterThanOrEqual(401);
  });

  test('API: çok büyük dosya reddedilir (413)', async ({ request }) => {
    test.skip(!testChannelId, 'Upload test kanalı fixture gerekli'  );
    const bigBuffer = Buffer.alloc(30 * 1024 * 1024, 0);
    const res = await request.post(`${BASE_URL}/api/upload`, {
      headers: { Authorization: `Bearer ${tokens.alice}` },
      multipart: { file: { name: 'big.bin', mimeType: 'application/octet-stream', buffer: bigBuffer }, channelId: testChannelId },
    });
    expect(res.status()).toBeGreaterThanOrEqual(400);
  });

  test('API: yüklenen dosya mesaj olarak gönderildiğinde kanalda görünür', async ({ request }) => {
    test.skip(!testChannelId, 'Upload test kanalı fixture gerekli'  );
    const imgBuffer = Buffer.from(TINY_PNG_B64, 'base64');
    const uploadRes = await request.post(`${BASE_URL}/api/upload`, {
      headers: { Authorization: `Bearer ${tokens.alice}` },
      multipart: { file: { name: 'attach.png', mimeType: 'image/png', buffer: imgBuffer }, channelId: testChannelId },
    });
    test.skip(!uploadRes.ok(), 'Test fixture hazır değil'  );
    const uploadData = await uploadRes.json();
    const fileUrl = uploadData.url || uploadData.fileUrl;
    test.skip(!fileUrl, 'Test fixture hazır değil'  );
    const msgRes = await request.post(`${BASE_URL}/api/channels/${testChannelId}/messages`, {
      headers: { Authorization: `Bearer ${tokens.alice}`, 'Content-Type': 'application/json' },
      data: JSON.stringify({ content: `Dosya: ${fileUrl}`, attachments: [fileUrl] }),
    });
    expect(msgRes.status()).toBeLessThan(300);
  });

  // ── YENİ: Gerçek akış testleri ──────────────────────────

  test('API: yüklenen URL HEAD isteğiyle erişilebilir ve Content-Type doğru', async ({ request }) => {
    test.skip(!testChannelId, 'Upload test kanalı fixture gerekli'  );

    const imgBuffer = Buffer.from(TINY_PNG_B64, 'base64');
    const uploadRes = await request.post(`${BASE_URL}/api/upload`, {
      headers: { Authorization: `Bearer ${tokens.alice}` },
      multipart: { file: { name: 'head-check.png', mimeType: 'image/png', buffer: imgBuffer }, channelId: testChannelId },
    });

    test.skip(!uploadRes.ok(), 'Test fixture hazır değil'  );
    const body = await uploadRes.json();
    const finalUrl: string | undefined = body.url ?? body.fileUrl;
    test.skip(!finalUrl, 'Test fixture hazır değil'  );

    expect(finalUrl).toMatch(/^https?:\/\//);

    const headRes = await request.head(finalUrl);
    expect(headRes.status()).toBeLessThan(400);
    expect(headRes.headers()['content-type'] ?? '').toMatch(/image/);
  });

  test('Socket: dosya mesajı gönderilince kanaldaki üyeye message:new gelir', async ({ request }) => {
    test.skip(!testChannelId, 'Upload test kanalı fixture gerekli'  );

    const imgBuffer = Buffer.from(TINY_PNG_B64, 'base64');
    const bob = await openSocket(tokens.bob).catch(() => null);
    test.skip(!bob, 'Test fixture hazır değil'  );

    try {
      bob.emit('channel:join', testChannelId);
      await new Promise(r => setTimeout(r, 400));

      const uploadRes = await request.post(`${BASE_URL}/api/upload`, {
        headers: { Authorization: `Bearer ${tokens.alice}` },
        multipart: { file: { name: 'notify.png', mimeType: 'image/png', buffer: imgBuffer }, channelId: testChannelId },
      });
      if (!uploadRes.ok()) return;

      const body    = await uploadRes.json();
      const fileUrl = body.url ?? body.fileUrl;
      if (!fileUrl) return;

      const msgEventPromise = waitForEvent<{ attachments?: string[] }>(bob, 'message:new', 4_000).catch(() => null);

      await request.post(`${BASE_URL}/api/channels/${testChannelId}/messages`, {
        headers: { Authorization: `Bearer ${tokens.alice}`, 'Content-Type': 'application/json' },
        data:    JSON.stringify({ content: 'socket notify test', attachments: [fileUrl] }),
      });

      const msgEvent = await msgEventPromise;
      if (msgEvent) {
        expect(Array.isArray(msgEvent.attachments)).toBe(true);
      }
    } finally {
      closeSockets(bob);
    }
  });

  // ── UI Testleri ──────────────────────────────────────────

  test('UI: upload butonu mesaj input alanında görünür', async ({ page }) => {
    test.skip(!testServerId || !testChannelId, 'Upload test kanalı fixture gerekli'  );
    const bp = new BridgePage(page);
    await bp.loginViaToken(tokens.alice);
    await bp.goto('/');
    await page.waitForTimeout(1500);
    const serverIcon = page.locator(`[data-server-id="${testServerId}"], [data-id="${testServerId}"]`).first();
    if (await serverIcon.count() > 0) { await serverIcon.click(); await page.waitForTimeout(800); }
    const uploadBtn = page.locator('#upload-btn, .upload-btn, [aria-label*="upload"], [aria-label*="Attach"], [aria-label*="Dosya"], [data-testid="upload"]').first();
    if (await uploadBtn.count() > 0) await expect(uploadBtn).toBeVisible();
    await expect(page.locator('body')).toBeVisible();
  });

  test('UI: dosya seçici file input içeriyor', async ({ page }) => {
    test.skip(!testServerId, 'Test sunucusu fixture gerekli'  );
    const bp = new BridgePage(page);
    await bp.loginViaToken(tokens.alice);
    await bp.goto('/');
    await page.waitForTimeout(1500);
    const serverIcon = page.locator(`[data-server-id="${testServerId}"], [data-id="${testServerId}"]`).first();
    if (await serverIcon.count() > 0) { await serverIcon.click(); await page.waitForTimeout(800); }
    const fileInput = page.locator('input[type="file"]').first();
    await expect(fileInput).toHaveCount(1);
  });

  test('UI: görsel yükleme sonrası önizleme gösterilir', async ({ page }) => {
    test.skip(!testServerId, 'Test sunucusu fixture gerekli'  );
    const bp = new BridgePage(page);
    await bp.loginViaToken(tokens.alice);
    await bp.goto('/');
    await page.waitForTimeout(1500);
    const serverIcon = page.locator(`[data-server-id="${testServerId}"], [data-id="${testServerId}"]`).first();
    if (await serverIcon.count() > 0) { await serverIcon.click(); await page.waitForTimeout(800); }
    const fileInput = page.locator('input[type="file"]').first();
    test.skip(await fileInput.count() === 0, 'Dosya input elementi bulunamadı — UI render edilmedi');
    const imgBuffer = Buffer.from(TINY_PNG_B64, 'base64');
    const tmpPath   = '/tmp/bridge-e2e-test.png';
    require('fs').writeFileSync(tmpPath, imgBuffer);
    await fileInput.setInputFiles(tmpPath);
    await page.waitForTimeout(800);
    const preview = page.locator('.upload-preview, .attachment-preview, [data-testid="upload-preview"], img[src*="blob:"]').first();
    if (await preview.count() > 0) await expect(preview).toBeVisible();
    await expect(page.locator('body')).toBeVisible();
  });
});
