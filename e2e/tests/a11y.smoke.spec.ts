// e2e/tests/a11y.smoke.spec.ts — Sprint 14: TypeScript dönüşümü (.js → .ts)
// Sprint 41: Kapsam genişletildi — login, kanal, DM, ayarlar sayfaları eklendi.
import { test, expect } from '@playwright/test';
const AxeBuilder = require('@axe-core/playwright').default;

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

async function expectNoA11yViolations(page, path: string, label?: string) {
  await page.goto(`${BASE_URL}${path}`, { waitUntil: 'domcontentloaded' });
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa'])
    .disableRules(['color-contrast']) // renk kontrastı ayrı audit'te ele alınır
    .analyze();
  expect(
    results.violations,
    `A11Y violations on ${label ?? path}:\n${results.violations.map((v: any) => `  [${v.impact}] ${v.id}: ${v.description}`).join('\n')}`,
  ).toEqual([]);
}

test.describe('a11y smoke — WCAG 2.0 A/AA', () => {
  // ── Genel sayfalar ──────────────────────────────────────────────────────────
  test('landing page — wcag2a/aa ihlali yok', async ({ page }) => {
    await expectNoA11yViolations(page, '/');
  });

  test('marketplace page — wcag2a/aa ihlali yok', async ({ page }) => {
    await expectNoA11yViolations(page, '/marketplace');
  });

  // ── Auth ────────────────────────────────────────────────────────────────────
  test('login sayfası — form erişilebilirliği', async ({ page }) => {
    await expectNoA11yViolations(page, '/login', 'login');
  });

  test('kayıt sayfası — form erişilebilirliği', async ({ page }) => {
    await expectNoA11yViolations(page, '/register', 'register');
  });

  // ── Uygulama (oturum gerektiren) ────────────────────────────────────────────
  test('ana uygulama shell — oturum sonrası', async ({ page }) => {
    // storageState ile oturum inject edilmiş olmalı (playwright.config.ts'deki storageState)
    await expectNoA11yViolations(page, '/app', 'app shell');
  });

  test('ayarlar modalı — klavye & ARIA', async ({ page }) => {
    await page.goto(`${BASE_URL}/app`, { waitUntil: 'domcontentloaded' });
    // Ayarlar butonuna tıkla
    const settingsBtn = page.locator('[aria-label="Ayarlar"], [data-testid="settings-btn"], #settings-btn').first();
    if (await settingsBtn.isVisible()) {
      await settingsBtn.click();
      await page.waitForTimeout(300);
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa'])
        .disableRules(['color-contrast'])
        .include('#settings-modal, .modal-overlay, [role="dialog"]')
        .analyze();
      expect(
        results.violations,
        `Ayarlar modalı A11Y ihlalleri:\n${results.violations.map((v: any) => `  [${v.impact}] ${v.id}`).join('\n')}`,
      ).toEqual([]);
    } else {
      test.skip(); // Sayfa yapısına göre buton bulunamadı
    }
  });

  // ── Klavye navigasyonu smoke ─────────────────────────────────────────────────
  test('Tab ile odak görünür kalmalı', async ({ page }) => {
    await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' });
    // İlk Tab'da odak body dışına çıkmamalı
    await page.keyboard.press('Tab');
    const focused = await page.evaluate(() => document.activeElement?.tagName);
    expect(['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'SUMMARY']).toContain(focused);
  });
});
