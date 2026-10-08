// e2e/tests/upload.spec.ts — Dosya Yükleme E2E Testleri
// Kapsam:
//   API: tekli/çoklu dosya yükleme, boyut/tip sınırları, yetkisiz yükleme
//   API: yüklenen URL erişilebilirlik kontrolü (HEAD)
//   API: yükleme sonrası socket bildirimi (message:new)
//   UI:  upload butonu görünürlüğü, dosya seçici, preview

import { test, expect } from '../helpers/apiTest';
import { request as pwRequest } from '@playwright/test';
import * as path from 'path';
import { BridgePage, getTokens, createTestServer, createTestChannel, joinServer } from '../helpers/bridge';
import { openSocket, waitForEvent, closeSockets, paceSends, joinChannelConfirmed } from '../helpers/socket';

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:3000';

const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const TINY_TXT = 'Bridge E2E test dosyası';

test.describe('Dosya Yükleme Akışları', () => {
  let tokens: { alice: string; bob: string };
  let testServerId:  string;
  let testChannelId: string;

  test.beforeAll(async ({ request }) => {
    tokens = getTokens();

    const server = await createTestServer(request, tokens.alice, `Upload E2E ${Date.now()}`);
    expect(server, 'yükleme sunucusu oluşturulamadı').toBeTruthy();
    testServerId = server._id || server.id;
    expect(testServerId, 'yükleme sunucu kimliği yok').toBeTruthy();
    const ch = await createTestChannel(request, tokens.alice, testServerId, 'upload-test');
    expect(ch, 'yükleme kanalı oluşturulamadı').toBeTruthy();
    testChannelId = ch._id || ch.id;
    expect(testChannelId, 'yükleme kanal kimliği yok').toBeTruthy();
    expect(await joinServer(request, tokens.alice, tokens.bob, testServerId),
      'Bob yükleme sunucusuna katılamadı').toBe(true);
  });

  // ── API Testleri ─────────────────────────────────────────

  test('API: küçük PNG yükleme başarılı', async ({ request }) => {
    expect(testChannelId, 'yükleme kanalı fikstürü eksik').toBeTruthy();
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
    expect(testChannelId, 'yükleme kanalı fikstürü eksik').toBeTruthy();
    const txtBuffer = Buffer.from(TINY_TXT, 'utf-8');
    const res = await request.post(`${BASE_URL}/api/upload`, {
      headers: { Authorization: `Bearer ${tokens.alice}` },
      multipart: { file: { name: 'test.txt', mimeType: 'text/plain', buffer: txtBuffer }, channelId: testChannelId },
    });
    expect(res.status()).toBeLessThan(500);
  });

  test('API: yetkisiz yükleme reddedilir', async ({ request }) => {
    expect(testChannelId, 'yükleme kanalı fikstürü eksik').toBeTruthy();
    const imgBuffer = Buffer.from(TINY_PNG_B64, 'base64');
    const res = await request.post(`${BASE_URL}/api/upload`, {
      multipart: { file: { name: 'hack.png', mimeType: 'image/png', buffer: imgBuffer }, channelId: testChannelId },
    });
    expect(res.status()).toBeGreaterThanOrEqual(401);
  });

  test('API: çok büyük dosya reddedilir (413)', async ({ request }) => {
    expect(testChannelId, 'yükleme kanalı fikstürü eksik').toBeTruthy();
    const bigBuffer = Buffer.alloc(30 * 1024 * 1024, 0);
    const res = await request.post(`${BASE_URL}/api/upload`, {
      headers: { Authorization: `Bearer ${tokens.alice}` },
      multipart: { file: { name: 'big.bin', mimeType: 'application/octet-stream', buffer: bigBuffer }, channelId: testChannelId },
    });
    expect(res.status()).toBeGreaterThanOrEqual(400);
  });

  // KALDIRILDI — 'API: yüklenen dosya mesaj olarak gönderildiğinde kanalda görünür'
  // `POST /api/channels/:id/messages` uygulanmayan bir uçtu (gönderim kanonik
  // olarak Socket.IO `file:send` üzerindendir). Aynı davranışın uçtan uca ve
  // yetkilendirme kanıtı tests/attachments.spec.ts içindedir; burada
  // tekrarlanmaz ve OBSOLET uç YENİDEN CANLANDIRILMAZ.

  // ── YENİ: Gerçek akış testleri ──────────────────────────

  test('API: yükleme yanıtı geçerli URL döndürür ve URL yetkisiz erişime KAPALIDIR', async ({ request }) => {
    expect(testChannelId, 'yükleme kanalı fikstürü eksik').toBeTruthy();

    const imgBuffer = Buffer.from(TINY_PNG_B64, 'base64');
    const uploadRes = await request.post(`${BASE_URL}/api/upload`, {
      headers: { Authorization: `Bearer ${tokens.alice}` },
      multipart: { file: { name: 'head-check.png', mimeType: 'image/png', buffer: imgBuffer }, channelId: testChannelId },
    });
    expect(uploadRes.status()).toBe(200);

    const body = await uploadRes.json() as { url?: string; fileUrl?: string; fileType?: string };
    const finalUrl = body.url ?? body.fileUrl;
    expect(finalUrl, 'yükleme url döndürmedi').toBeTruthy();

    // Yerel depolama sağlayıcısı GÖRELİ yol döndürür ('/uploads/...'); mutlak
    // URL yalnızca CDN sağlayıcısında geçerlidir. Her ikisi de kabul edilir.
    expect(finalUrl!).toMatch(/^(https?:\/\/|\/)/);
    expect(body.fileType ?? '').toMatch(/image/);

    // ════════════════════════════════════════════════════════════════════
    // BU TEST BİR KUSURU "BEKLENEN DAVRANIŞ" SANIYORDU
    // ════════════════════════════════════════════════════════════════════
    // Eski hâli, henüz mesaja iliştirilmemiş bir yüklemenin YÜKLEYEN için de
    // kapalı olduğunu iddia ediyordu. Oysa `middleware/uploadAuthz.ts` bunu
    // açıkça tersine tanımlar:
    //     "orphan: yalnız yükleyen erişebilir (sahibi bilinmiyorsa kimse)"
    //
    // Gerçek sebep bir ANAHTAR BİÇİMİ uyuşmazlığıydı: `recordUpload` anahtarı
    // `uploads/<ad>` olarak saklarken `findOwner` yalnızca `/uploads/<ad>` ve
    // `<ad>` biçimlerini arıyordu. Hiçbiri eşleşmediği için `uploaderId`
    // DAİMA null kalıyor ve yükleyen kendi dosyasını okuyamıyordu (403).
    // Gönderim öncesi önizleme bu yüzden kırıktı.
    //
    // Ayrıca eski hâl GERÇEKTEN kimliksiz DEĞİLDİ: paylaşılan `request`
    // fixture'ı `bridge_media` çerezi taşır, yani ölçülen şey "anonim" değil
    // "alice" idi. Aşağıda iki ayrı özellik AYRI AYRI doğrulanır.
    const absolute = finalUrl!.startsWith('http') ? finalUrl! : `${BASE_URL}${finalUrl}`;

    // 1) YÜKLEYEN kendi dosyasını okuyabilmeli (önizleme yolu).
    const owner = await request.get(absolute, {
      headers: { Authorization: `Bearer ${tokens.alice}` },
    });
    expect(owner.status(), 'yükleyen kendi dosyasını okuyamıyor').toBe(200);

    // 2) GERÇEKTEN kimliksiz erişim reddedilmeli — çerezsiz temiz bağlam.
    const anonCtx = await pwRequest.newContext({
      baseURL: BASE_URL, storageState: { cookies: [], origins: [] },
    });
    try {
      const anon = await anonCtx.get(absolute);
      expect([401, 403], 'kimliksiz erişim açık').toContain(anon.status());
    } finally { await anonCtx.dispose(); }
  });

  // Önceki test, kaldırılmış REST mesaj-gönderme yoluna istek atıyor
  // ve başarısız isteği / alınmayan olayı da yeşil sayıyordu.
  test('Socket: gerçek file:send bildirimi kanal üyesine message:new olarak ulaşır', async ({ request }) => {
    expect(testChannelId && testServerId, 'yükleme fikstürü eksik').toBeTruthy();
    const bob = await openSocket(tokens.bob);
    const alice = await openSocket(tokens.alice);
    try {
      await joinChannelConfirmed(bob, testChannelId, testServerId);
      const uploadRes = await request.post(`${BASE_URL}/api/upload`, {
        headers: { Authorization: `Bearer ${tokens.alice}` },
        multipart: {
          file: { name: 'notify.png', mimeType: 'image/png', buffer: Buffer.from(TINY_PNG_B64, 'base64') },
          channelId: testChannelId,
        },
      });
      expect(uploadRes.status(), 'PNG yüklemesi başarılı olmalı').toBe(200);
      const { url, fileName, fileType } = await uploadRes.json() as {
        url: string; fileName: string; fileType: string;
      };
      expect(url, 'yükleme URL döndürmedi').toBeTruthy();

      const received = waitForEvent<{ type?: string; fileUrl?: string }>(
        bob, 'message:new', 15_000, event => event?.fileUrl === url,
      );
      await paceSends('alice');
      alice.emit('file:send', {
        channelId: testChannelId, serverId: testServerId, fileName, fileUrl: url, fileType,
      });
      const event = await received;
      expect(event.type).toBe('file');
      expect(event.fileUrl).toBe(url);
    } finally { closeSockets(alice, bob); }
  });

  // ── UI Testleri ──────────────────────────────────────────

  // SEÇİCİLER GÜNCELLENDİ — gerçek besteci (composer) sözleşmesi:
  //   ek butonu : #btn-attach  (aria-label "Dosya ekle")
  //   dosya girişi : #msg-file-input  (görsel olarak gizli — standart desen)
  // Eski spec '#upload-btn' ve '[data-server-id]' arıyordu; ikisi de yok
  // (sunucu düğmeleri erişilebilir ADLA render edilir, veri kimliğiyle değil).

  /** Oturumlu kabuğu aç (storageState alice oturumunu taşır). */
  async function openShell(page: import('@playwright/test').Page) {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await page.locator('#app').waitFor({ state: 'visible', timeout: 20_000 });
  }

  test('UI: ek (attach) butonu bestecide görünür', async ({ page }) => {
    await openShell(page);
    await expect(page.locator('#btn-attach')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('#btn-attach')).toHaveAttribute('aria-label', 'Dosya ekle');
  });

  test('UI: gizli dosya girişi bestecide mevcut', async ({ page }) => {
    await openShell(page);
    const input = page.locator('#msg-file-input');
    await expect(input).toHaveCount(1);
    await expect(input).toHaveAttribute('type', 'file');
  });

  test('UI: dosya seçilince besteci eki sahneler', async ({ page }) => {
    await openShell(page);
    // KULLANICININ ULAŞABİLDİĞİ ÖN KOŞUL (Final21 Faz 19, 19-25): besteci yalnızca bir metin kanalı
    // açıkken GÖRÜNÜR. Test eskiden gizli dosya girişine, açılışta son kanal geri yüklenmeden ÖNCE
    // dosya veriyordu (ölçüldü: +366 ms, kanal yok); kanal açılınca ek, tasarım gereği başka bir
    // hedefe TAŞINMAZ ve düşer. Kullanıcı o pencerede besteciyi göremez/odaklayamaz (20 örnek, 8 açılış).
    await expect(page.locator('#btn-attach')).toBeVisible({ timeout: 15_000 });
    const input = page.locator('#msg-file-input');
    await expect(input).toHaveCount(1);

    const tmpPath = require('path').join(require('os').tmpdir(), `bridge-e2e-ui-${Date.now()}.png`);
    require('fs').writeFileSync(tmpPath, Buffer.from(TINY_PNG_B64, 'base64'));

    // ÜRÜN SÖZLEŞMESİ: dosya seçimi ANINDA yüklemez; besteciye SAHNELER ve
    // gerçek yükleme gönderim anında yapılır (MessageInputPanel.acceptFile).
    // Bu yüzden burada ağ isteği değil, sahnelenen ek göstergesi doğrulanır.
    await input.setInputFiles(tmpPath);
    const chip = page.locator('[data-composer-mode="attach"]');
    await expect(chip).toBeVisible({ timeout: 10_000 });
    await expect(chip).toContainText(require('path').basename(tmpPath));
  });
});
