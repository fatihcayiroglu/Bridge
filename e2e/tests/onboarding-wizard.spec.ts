// e2e/tests/onboarding-wizard.spec.ts
// Onboarding wizard akışının gerçek app entegrasyonunu E2E seviyesinde doğrular.
//
// SEÇİCİLER GÜNCELLENDİ — eski spec artık var olmayan bir sözleşmeye bakıyordu:
//   • `#onboarding-wizard-overlay`  → YOK. Bileşen `.ow-backdrop` kökünü
//     role="dialog" + aria-modal="true" + aria-label="Onboarding sihirbazı"
//     ile render eder (client/js/core/OnboardingWizard.svelte).
//     Erişilebilir rol/ad tercih edilir; üretilmiş sınıf adına bağlanılmaz.
//   • `bridge_onboarding_done` → YOK. Kalıcılık anahtarı KULLANICI KAPSAMLIDIR:
//     `bridge_onboarding_v3:<userId>` (görülmemişse `:anon`).
//   • Sihirbaz, auth-success sonrası ~800 ms gecikmeyle açılır.
//
// Unit testler (client/tests/onboarding-wizard.test.ts) DOM mantığını kapsar;
// bu suite gerçek uygulamada görünürlük ve adım navigasyonunu doğrular.

import { test, expect } from '../helpers/apiTest';
import type { Page } from '@playwright/test';

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:3000';
const STORAGE_PREFIX = 'bridge_onboarding_v3';

/** Sihirbazın kanonik kökü: rol + erişilebilir ad. */
const wizard = (page: Page) => page.getByRole('dialog', { name: 'Onboarding sihirbazı' });

/**
 * Giriş animasyonu bitene kadar bekle. Kart CSS ile içeri kayarak açılır ve
 * adım geçişleri 180 ms sürer; animasyon sırasında Playwright öğeyi "kararsız"
 * bulup tıklamayı reddediyordu.
 */
async function settle(page: Page): Promise<void> {
  await page.waitForFunction(
    () => document.getAnimations().every((a) => a.playState !== 'running'),
    undefined,
    { timeout: 5_000 },
  ).catch(() => { /* animasyon API'si yoksa kısa beklemeye düş */ });
  await page.waitForTimeout(250);
}

/** Kullanıcı kapsamlı "görüldü" anahtarlarını temizle ve sayfayı taze yükle. */
async function loadFresh(page: Page): Promise<void> {
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await page.evaluate((prefix) => {
    for (const k of Object.keys(localStorage)) {
      if (k.startsWith(prefix)) localStorage.removeItem(k);
    }
  }, STORAGE_PREFIX);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForAppShell(page);
}

/**
 * Uygulama kabuğunu bekle; ilk denemede açılmazsa BİR KEZ yeniden yükle.
 * SPA oturumu geri yüklerken ara sıra ilk boot'u kaçırıyor (art arda açılan
 * çok sayıda bağlamda görüldü); bu ürün hatası değil, ortam kaynaklı yarıştır.
 */
async function waitForAppShell(page: Page): Promise<void> {
  try {
    await page.locator('#app').waitFor({ state: 'visible', timeout: 12_000 });
  } catch {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForAppShell(page);
  }
}

test.describe('Onboarding Wizard — App Entegrasyonu', () => {
  test.use({ storageState: 'fixtures/alice-state.json' });

  // Sıfır sunuculu kullanıcıya "Empty Server Start" ekranı açılır
  // (.empty-server-backdrop, z-index 10000) ve onboarding sihirbazının
  // (.ow-backdrop, z-index 9999) ÜSTÜNE oturarak tıklamaları yutar.
  // Sihirbazın kapsamı sunucu/kanal turudur; gerçekçi bağlam en az bir
  // sunucuya üye olmaktır. Fixture bu bağlamı kurar.
  test.beforeAll(async ({ request }) => {
    const { getTokens, createTestServer } = await import('../helpers/bridge');
    const tokens = getTokens();
    const existing = await request.get(`${BASE_URL}/api/servers`, {
      headers: { Authorization: `Bearer ${tokens.alice}` },
    });
    const body = await existing.json();
    const servers = Array.isArray(body) ? body : (body.servers ?? []);
    if (servers.length === 0) {
      const created = await createTestServer(request, tokens.alice, `Onboarding ${Date.now()}`);
      expect(created, 'onboarding bağlamı için sunucu oluşturulamadı').toBeTruthy();
    }
  });

  test('ilk girişte wizard gösterilmeli', async ({ page }) => {
    await loadFresh(page);
    await expect(wizard(page)).toBeVisible({ timeout: 15_000 });
  });

  test('wizard dialog rolü ve aria-modal taşımalı', async ({ page }) => {
    await loadFresh(page);
    const w = wizard(page);
    await expect(w).toBeVisible({ timeout: 15_000 });
    await settle(page);
    await expect(w).toHaveAttribute('aria-modal', 'true');
  });

  test('"Devam" ile sonraki adıma geçilir', async ({ page }) => {
    await loadFresh(page);
    const w = wizard(page);
    await expect(w).toBeVisible({ timeout: 15_000 });
    await settle(page);

    // İlk adımda ikincil buton "Atla"dır; sonraki adımlarda "← Geri" olur.
    await expect(w.getByRole('button', { name: "Onboarding'i atla" })).toBeVisible();
    await w.getByRole('button', { name: 'Sonraki adım' }).click();
    await settle(page);
    await expect(w.getByRole('button', { name: 'Önceki adım' })).toBeVisible();
  });

  test('"Atla" wizard\'ı kapatır', async ({ page }) => {
    await loadFresh(page);
    const w = wizard(page);
    await expect(w).toBeVisible({ timeout: 15_000 });
    await settle(page);
    await w.getByRole('button', { name: "Onboarding'i atla" }).click();
    await expect(w).toBeHidden();
  });

  test('Esc tuşu wizard\'ı kapatır', async ({ page }) => {
    await loadFresh(page);
    const w = wizard(page);
    await expect(w).toBeVisible({ timeout: 15_000 });
    await settle(page);
    await page.keyboard.press('Escape');
    await expect(w).toBeHidden();
  });

  test('Kapat butonu wizard\'ı kapatır', async ({ page }) => {
    await loadFresh(page);
    const w = wizard(page);
    await expect(w).toBeVisible({ timeout: 15_000 });
    await settle(page);
    await w.getByRole('button', { name: 'Kapat' }).click();
    await expect(w).toBeHidden();
  });

  test('son adımda "Başla" kapatır ve kullanıcı kapsamlı flag yazar', async ({ page }) => {
    await loadFresh(page);
    const w = wizard(page);
    await expect(w).toBeVisible({ timeout: 15_000 });
    await settle(page);

    // Son adıma kadar ilerle: birincil buton son adımda 'Tamamla' adını alır.
    for (let i = 0; i < 12; i++) {
      const done = w.getByRole('button', { name: 'Tamamla' });
      if (await done.count() > 0) { await done.click(); break; }
      await w.getByRole('button', { name: 'Sonraki adım' }).click();
      await settle(page);
    }
    await expect(w).toBeHidden();

    const flagged = await page.evaluate((prefix) =>
      Object.keys(localStorage).some((k) => k.startsWith(prefix)), STORAGE_PREFIX);
    expect(flagged, 'tamamlama sonrası kalıcı flag yazılmadı').toBe(true);
  });

  test('kullanıcı kapsamlı flag set ise wizard AÇILMAZ', async ({ page, request }) => {
    // Sözleşme: `bridge_onboarding_v3:<userId>` yazılıysa otomatik açılma iptal.
    // Bayrak, sayfa scriptleri çalışmadan ÖNCE addInitScript ile yazılır; böylece
    // fazladan goto→evaluate→reload turu gerekmez (bu tur ara sıra oturumu
    // düşürüp uygulama kabuğunun hiç açılmamasına yol açıyordu).
    const { getTokens } = await import('../helpers/bridge');
    const tokens = getTokens();
    const meRes = await request.get(`${BASE_URL}/api/me`, {
      headers: { Authorization: `Bearer ${tokens.alice}` },
    });
    expect(meRes.status()).toBe(200);
    const me = await meRes.json();
    const userId = me._id || me.id;

    await page.addInitScript(({ prefix, uid }) => {
      try {
        localStorage.setItem(`${prefix}:${uid}`, 'done');
        localStorage.setItem(`${prefix}:anon`, 'done');
      } catch { /* storage kapalıysa test zaten anlamlı değil */ }
    }, { prefix: STORAGE_PREFIX, uid: userId });

    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await waitForAppShell(page);
    // Otomatik açılma gecikmesi 800 ms — fazlasıyla bekle.
    await page.waitForTimeout(2_500);
    await expect(wizard(page)).toBeHidden();
  });

  test('GET /api/servers/:sid/onboarding yanıt verir', async ({ request }) => {
    const { getTokens } = await import('../helpers/bridge');
    const tokens = getTokens();
    const serversRes = await request.get(`${BASE_URL}/api/servers`, {
      headers: { Authorization: `Bearer ${tokens.alice}` },
    });
    expect(serversRes.status()).toBe(200);
    const body = await serversRes.json();
    const servers = Array.isArray(body) ? body : (body.servers ?? []);
    test.skip(servers.length === 0, 'Kullanıcının sunucusu yok — onboarding ucu denenemez');

    const sid = servers[0]._id || servers[0].id;
    const res = await request.get(`${BASE_URL}/api/servers/${sid}/onboarding`, {
      headers: { Authorization: `Bearer ${tokens.alice}` },
    });
    // Final21 Faz 22 (19-37): uç her üye için 200 döner — kayıt yoksa varsayılan yapılandırma
    // (`enabled:false`, karşılama metni) gelir (ölçüldü). 404 artık kabul edilmez.
    expect(res.status()).toBe(200);
    expect(typeof (await res.json()).enabled).toBe('boolean');
  });
});
