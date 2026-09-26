// e2e/tests/security-tab-live.spec.ts
//
// ════════════════════════════════════════════════════════════════════════════
// GUVENLIK TABI GERCEK UYGULAMADA ULASILABILIR VE CANLI DURUMU GOSTERIR
// ════════════════════════════════════════════════════════════════════════════
// Birim testleri tabin davranisini sahte `apiFetch` ile olcer. Bu dosya
// ASIL ENTEGRASYON RISKINI olcer: sekme uretim paketinde GERCEKTEN var mi ve
// GERCEK sunucudan durum okuyabiliyor mu?
//
// Bu risk kurgusal degil — bu programda bulunan kusurun ta kendisi buydu:
// sunucu 2FA'yi tam destekliyordu, `js/twoFactor.ts` de vardi, ama HICBIR
// giris noktasindan import edilmedigi icin kullanicinin 2FA'yi acmasinin
// hicbir yolu yoktu. Birim testleri boyle bir boslugu ASLA yakalayamaz.
//
// TOTP uretimi burada YAPILMAZ: etkinlestirmenin tam dongusu sunucu API
// testleriyle (`tests/2fa.spec.ts`) zaten kapsanir. Buradaki soru
// "ulasilabilir mi ve canli konusuyor mu" sorusudur.

import { test, expect } from '@playwright/test';

const ORIGIN = `http://${process.env.E2E_HOST || 'localhost'}:${process.env.E2E_PORT || '3000'}`;

test.describe('Guvenlik sekmesi — canli ulasilabilirlik', () => {
  test('ayarlar icinde Guvenlik sekmesi vardir ve sunucudan durum okur', async ({ page }) => {
    test.setTimeout(90_000);

    const istekler: string[] = [];
    page.on('request', (r) => {
      if (r.url().includes('/api/2fa')) istekler.push(`${r.method()} ${r.url().replace(ORIGIN, '')}`);
    });

    await page.goto(`${ORIGIN}/`);

    // ── GERCEK KULLANICI YOLU ────────────────────────────────────────────
    // `BridgeRegistry` bilerek `window`a KOYULMAZ (kayit deseninin amaci
    // budur), bu yuzden testi ona baglamak yanlis olurdu. Bunun yerine
    // kabuktaki gercek denetim tiklanir — kullanicinin yaptigi sey.
    const acKontrol = page.locator('[data-bridge-action="openSettingsModal"]').first();
    await expect(acKontrol, 'kabukta ayarlar denetimi bulunmali').toHaveCount(1, { timeout: 15_000 });
    await acKontrol.click();

    // Sekme dugmesi gorunur olmali.
    const sekme = page.locator('#tab-security');
    await expect(sekme, 'Guvenlik sekmesi kabukta bulunmali').toHaveCount(1, { timeout: 15_000 });
    await sekme.click();

    // Panel icerigi basilmali.
    const panel = page.locator('[data-testid="security-tab"]');
    await expect(panel).toBeVisible({ timeout: 15_000 });

    // GERCEK sunucuya durum sorulmus olmali — sahte veri degil.
    await expect
      .poll(() => istekler.filter((u) => u.includes('/api/2fa/status')).length, { timeout: 15_000 })
      .toBeGreaterThan(0);

    // Yukleme durumunda takili kalmamali: ya durum ya da hata gosterilmeli.
    await expect
      .poll(async () => {
        const durum = await page.locator('[data-testid="sec-state"]').count();
        const hata  = await page.locator('[data-testid="sec-error"]').count();
        return durum + hata;
      }, { timeout: 15_000 })
      .toBeGreaterThan(0);
  });
});
