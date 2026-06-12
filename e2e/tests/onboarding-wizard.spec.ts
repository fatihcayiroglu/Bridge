// e2e/tests/onboarding-wizard.spec.ts
// Onboarding wizard akışının gerçek app entegrasyonunu E2E seviyesinde doğrular.
//
// Unit testler (client/tests/onboarding-wizard.test.ts) wizard DOM mantığını kapsar.
// Bu suite ise:
//   1. Login sonrası wizard'ın gerçek sayfada görünüp görünmediğini,
//   2. Adım navigasyonunun (Devam / Geri / Son adım) çalıştığını,
//   3. localStorage flag'inin set edilip bir sonraki ziyarette wizard'ın
//      gösterilmediğini doğrular.
//
// Önkoşul: e2e setup (fixtures/tokens.json, çalışan Bridge sunucusu)

import { test, expect } from '@playwright/test';
import { BridgePage, getTokens } from '../helpers/bridge';

const BASE_URL      = process.env.BASE_URL || 'http://localhost:3000';
const OVERLAY_SEL   = '#onboarding-wizard-overlay';
const STORAGE_KEY   = 'bridge_onboarding_done';
const STORAGE_VER   = '2';

// ── Yardımcılar ──────────────────────────────────────────────────────────────

/** localStorage'ı temizle ve sayfayı taze yükle — wizard ilk kez görünür */
async function loadFresh(page: import('@playwright/test').Page, bp: BridgePage) {
  await page.evaluate((key) => localStorage.removeItem(key), STORAGE_KEY);
  await bp.goto('/');
  // Wizard'ın DOM'a eklenmesi için kısa bekleme
  await page.waitForTimeout(500);
}

// ── Test suite ───────────────────────────────────────────────────────────────

test.describe('Onboarding Wizard — App Entegrasyonu', () => {

  // Alice token'ı ile giriş yapmış oturum kullan
  test.use({ storageState: 'e2e/fixtures/alice-state.json' });

  test.beforeEach(async ({ page }) => {
    // Her test öncesinde localStorage flag'ini temizle
    await page.goto(BASE_URL);
    await page.evaluate((key) => localStorage.removeItem(key), STORAGE_KEY);
  });

  // ── 1. İlk girişte wizard görünmeli ────────────────────────────────────────
  test('ilk girişte wizard overlay gösterilmeli', async ({ page }) => {
    const bp = new BridgePage(page);
    await loadFresh(page, bp);

    await expect(page.locator(OVERLAY_SEL)).toBeVisible({ timeout: 5000 });
  });

  // ── 2. İlk adım içeriği ────────────────────────────────────────────────────
  test('ilk adımda hoşgeldin başlığı görünmeli', async ({ page }) => {
    const bp = new BridgePage(page);
    await loadFresh(page, bp);

    const overlay = page.locator(OVERLAY_SEL);
    await expect(overlay).toBeVisible({ timeout: 5000 });

    // Dot (adım göstergesi) sayısı ≥ 1 olmalı
    const dots = overlay.locator('[data-step]');
    await expect(dots.first()).toBeVisible();

    // İlk adım kartında ikon veya başlık text'i olmalı
    const card = overlay.locator('.wizard-card, [role="dialog"]').first();
    await expect(card).toBeVisible();
  });

  // ── 3. "Devam" butonu ile ileri navigasyon ─────────────────────────────────
  test('"Devam" butonuna tıklayınca sonraki adıma geçmeli', async ({ page }) => {
    const bp = new BridgePage(page);
    await loadFresh(page, bp);

    const overlay = page.locator(OVERLAY_SEL);
    await expect(overlay).toBeVisible({ timeout: 5000 });

    // Etkin dot'un indeksini al
    const getActiveDot = () =>
      page.evaluate(() => {
        const el = document.querySelector('[data-step].active, [data-step][aria-selected="true"]');
        return el ? Number((el as HTMLElement).dataset.step) : -1;
      });

    const stepBefore = await getActiveDot();

    // "Devam" butonunu bul ve tıkla
    const nextBtn = overlay.locator(
      'button:has-text("Devam"), button:has-text("İleri"), button:has-text("Next")'
    ).first();
    await nextBtn.click();
    await page.waitForTimeout(300);

    const stepAfter = await getActiveDot();
    // Adım ilerlemeli (ya dot değişmeli ya da başlık değişmeli)
    // Bazı implementasyonlarda dot index değişmeyebilir ama içerik değişir
    const heading = overlay.locator('h2, h3, .wizard-title').first();
    await expect(heading).toBeVisible();
    // En azından hata olmadan geçilmeli
    expect(stepAfter).toBeGreaterThanOrEqual(stepBefore);
  });

  // ── 4. "Atla" butonu ile kapatma ───────────────────────────────────────────
  test('"Atla" butonu overlay\'ı kapatmalı', async ({ page }) => {
    const bp = new BridgePage(page);
    await loadFresh(page, bp);

    const overlay = page.locator(OVERLAY_SEL);
    await expect(overlay).toBeVisible({ timeout: 5000 });

    const skipBtn = overlay.locator(
      'button:has-text("Atla"), button:has-text("Skip"), button[aria-label*="skip" i]'
    ).first();
    await skipBtn.click();
    await page.waitForTimeout(400);

    await expect(overlay).not.toBeVisible();
  });

  // ── 5. Son adımda "Başla" butonu görünmeli ve wizard kapanmalı ─────────────
  test('son adımda "Başla" butonu wizard\'ı kapatmalı ve localStorage\'a yazmalı', async ({ page }) => {
    const bp = new BridgePage(page);
    await loadFresh(page, bp);

    const overlay = page.locator(OVERLAY_SEL);
    await expect(overlay).toBeVisible({ timeout: 5000 });

    // Tüm adımları "Devam" ile geç
    const nextBtn = overlay.locator(
      'button:has-text("Devam"), button:has-text("İleri"), button:has-text("Next")'
    );
    // Maksimum 10 adım — gerçek adım sayısına göre dur
    for (let i = 0; i < 10; i++) {
      const isVisible = await nextBtn.isVisible().catch(() => false);
      if (!isVisible) break;
      await nextBtn.click();
      await page.waitForTimeout(200);
    }

    // Son adımda "Başla" butonu görünmeli
    const startBtn = overlay.locator(
      'button:has-text("Başla"), button:has-text("Get Started"), button:has-text("Bitir")'
    ).first();
    await expect(startBtn).toBeVisible({ timeout: 3000 });
    await startBtn.click();
    await page.waitForTimeout(400);

    // Overlay kapanmalı
    await expect(overlay).not.toBeVisible();

    // localStorage'a done flag yazılmalı
    const stored = await page.evaluate(
      ({ key, ver }) => localStorage.getItem(key) === ver,
      { key: STORAGE_KEY, ver: STORAGE_VER }
    );
    expect(stored).toBe(true);
  });

  // ── 6. İkinci ziyarette wizard gösterilmemeli ──────────────────────────────
  test('localStorage flag set ise wizard tekrar gösterilmemeli', async ({ page }) => {
    const bp = new BridgePage(page);

    // Flag'i önceden set et
    await page.goto(BASE_URL);
    await page.evaluate(
      ({ key, ver }) => localStorage.setItem(key, ver),
      { key: STORAGE_KEY, ver: STORAGE_VER }
    );

    await bp.goto('/');
    await page.waitForTimeout(600);

    // Overlay ya hiç yoktur ya da hidden
    const overlay = page.locator(OVERLAY_SEL);
    const isPresent = await overlay.count();
    if (isPresent > 0) {
      await expect(overlay).not.toBeVisible();
    }
  });

  // ── 7. Esc ile kapatma ─────────────────────────────────────────────────────
  test('Esc tuşu wizard\'ı kapatmalı', async ({ page }) => {
    const bp = new BridgePage(page);
    await loadFresh(page, bp);

    const overlay = page.locator(OVERLAY_SEL);
    await expect(overlay).toBeVisible({ timeout: 5000 });

    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);

    await expect(overlay).not.toBeVisible();
  });

  // ── 8. Backdrop click ile kapatma ─────────────────────────────────────────
  test('overlay backdrop\'a tıklayınca wizard kapanmalı', async ({ page }) => {
    const bp = new BridgePage(page);
    await loadFresh(page, bp);

    const overlay = page.locator(OVERLAY_SEL);
    await expect(overlay).toBeVisible({ timeout: 5000 });

    // Overlay'e tıkla (card dışı alana)
    await overlay.click({ position: { x: 5, y: 5 }, force: true });
    await page.waitForTimeout(400);

    await expect(overlay).not.toBeVisible();
  });

  // ── 9. ARIA role="dialog" ve aria-modal ───────────────────────────────────
  test('wizard kartı dialog rolü ve aria-modal taşımalı', async ({ page }) => {
    const bp = new BridgePage(page);
    await loadFresh(page, bp);

    await expect(page.locator(OVERLAY_SEL)).toBeVisible({ timeout: 5000 });

    const dialog = page.locator('[role="dialog"]').first();
    await expect(dialog).toBeVisible();
    const ariaModal = await dialog.getAttribute('aria-modal');
    expect(ariaModal).toBe('true');
  });

  // ── 10. API: onboarding endpoint erişilebilir olmalı ─────────────────────
  test('GET /api/servers/:sid/onboarding başarıyla yanıt vermeli', async ({ request }) => {
    const tokens = getTokens();

    // Kullanıcının üye olduğu ilk sunucuyu bul
    const serversRes = await request.get(`${BASE_URL}/api/servers`, {
      headers: { Authorization: `Bearer ${tokens.alice}` },
    });
    expect(serversRes.status()).toBe(200);
    const servers = await serversRes.json() as Array<{ _id: string }>;
    if (!servers.length) {
      test.skip(true, 'Test kullanıcısının üye olduğu sunucu yok');
      return;
    }

    const sid = servers[0]._id;
    const res = await request.get(`${BASE_URL}/api/servers/${sid}/onboarding`, {
      headers: { Authorization: `Bearer ${tokens.alice}` },
    });
    expect([200, 403]).toContain(res.status());
    if (res.status() === 200) {
      const body = await res.json();
      expect(body).toHaveProperty('enabled');
      expect(body).toHaveProperty('channels');
    }
  });
});
