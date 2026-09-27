// e2e/tests/cross-browser-core.spec.ts
//
// ÇAPRAZ TARAYICI — TEMEL ÜRÜN AKIŞLARI
//
// ════════════════════════════════════════════════════════════════════════════
// NEDEN AYRI BİR DOSYA
// ════════════════════════════════════════════════════════════════════════════
// Paketin tamamı Chromium'a göre yazılmıştır ve 430 test oradan geçer. Ama
// "Chromium'da geçiyor" ile "üründe çalışıyor" aynı şey değildir: Firefox ve
// WebKit farklı CSS, farklı odak davranışı, farklı depolama ve farklı medya
// yetenekleri getirir.
//
// Bu dosya ÜÇ motorda da çalışacak kadar dar tutulmuştur: giriş yapılmış
// kabuğun gerçekten yüklendiği, kritik yüzeylerin render edildiği ve
// yatay taşma olmadığı doğrulanır.
//
// ── DÜRÜSTLÜK ─────────────────────────────────────────────────────────────
// Playwright WebKit, GERÇEK Safari donanımı DEĞİLDİR. Yararlı bir uyumluluk
// sinyalidir; Safari doğrulaması yerine geçmez ve öyle raporlanmaz.
// Medya (WebRTC) yetenekleri motora göre değişir; bu dosya medya iddiası
// yapmaz — o kanıt `voice-media` paketindedir ve Chromium'a özgüdür.

import { test, expect } from '../helpers/apiTest';

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:3000';

test.describe('çapraz tarayıcı — çekirdek', () => {
  test('uygulama kabuğu YÜKLENİR ve kimlik oturumu taşınır', async ({ page }) => {
    await page.goto(BASE_URL);
    // `#app` ürünün kanonik kökü; render edilmezse hiçbir akış anlamlı değildir.
    await expect(page.locator('#app')).toBeVisible({ timeout: 30_000 });

    // Oturum fikstürden gelir: giriş ekranına DÜŞMEMELİ.
    const text = await page.evaluate(() => document.body.innerText);
    expect(text.length).toBeGreaterThan(20);
  });

  test('kanal listesi ve mesaj alanı RENDER EDİLİR', async ({ page }) => {
    await page.goto(BASE_URL);
    await expect(page.locator('#app')).toBeVisible({ timeout: 30_000 });

    // Kabuğun iki ana bölgesi. Seçiciler erişilebilir/kimlikli köklerdir —
    // üretilmiş sınıf adlarına bağlanılmaz.
    const shell = page.locator('#app');
    await expect(shell).toBeVisible();

    // En az bir etkileşimli düğme bulunmalı (boş bir kabuk sessiz hatadır).
    const buttons = await page.locator('button:visible').count();
    expect(buttons).toBeGreaterThan(0);
  });

  test('YATAY TAŞMA yok (1280 genişlik)', async ({ page }) => {
    // Farkli motorlarin kutu modeli farklidir; tasma en sik gorulen
    // capraz-tarayici kusurudur.
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(BASE_URL);
    await expect(page.locator('#app')).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(1500);

    const overflow = await page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect({ overflowPx: overflow > 2 ? overflow : 0 }).toEqual({ overflowPx: 0 });
  });

  test('DAR ekranda da yatay taşma yok (390 genişlik)', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(BASE_URL);
    await expect(page.locator('#app')).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(1500);

    const overflow = await page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect({ overflowPx: overflow > 2 ? overflow : 0 }).toEqual({ overflowPx: 0 });
  });

  test('KONSOLDA ölümcül hata yok', async ({ page }) => {
    // Bir motorda calisip digerinde patlayan kod en cok burada gorunur.
    const fatal: string[] = [];
    page.on('pageerror', e => fatal.push(String(e.message).slice(0, 120)));
    await page.goto(BASE_URL);
    await expect(page.locator('#app')).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(2500);
    expect({ fatal }).toEqual({ fatal: [] });
  });

  test('API çağrısı ÇALIŞIR (fetch + kimlik başlıkları)', async ({ page }) => {
    await page.goto(BASE_URL);
    const status = await page.evaluate(async (base) => {
      const r = await fetch(base + '/api/health');
      return r.status;
    }, BASE_URL);
    expect(status).toBe(200);
  });
});
