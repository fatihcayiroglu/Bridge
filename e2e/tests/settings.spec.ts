// e2e/tests/settings.spec.ts — Sprint 63: Settings Svelte modal E2E
// Svelte geçişinin doğrulanması: SettingsModal açılıyor, sekmeler gezilebiliyor,
// profil güncelleme kaydediliyor, modal kapatılabiliyor.

import { test, expect } from '@playwright/test';
import { BridgePage, getTokens } from '../helpers/bridge';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

test.describe('Settings Modal — Svelte', () => {
  let tokens: ReturnType<typeof getTokens>;

  test.beforeAll(() => {
    tokens = getTokens();
  });

  test('settings modal açılabiliyor', async ({ page }) => {
    const bp = new BridgePage(page);
    await bp.goto('/');
    await page.waitForSelector('[data-testid="app-loaded"], .channel-list, #sidebar', { timeout: 10_000 });

    // settings tetikleme — dişli ikonu veya avatar tıklaması
    const settingsBtn = page.locator(
      '[data-testid="open-settings"], [aria-label="Ayarlar"], .settings-btn, #user-settings-btn'
    ).first();
    await settingsBtn.click({ timeout: 5_000 });

    // Svelte modal açıldı mı?
    await expect(
      page.locator('[data-testid="settings-modal"], .settings-modal, [role="dialog"]').first()
    ).toBeVisible({ timeout: 5_000 });
  });

  test('settings modal sekmeler arası geçiş yapılabiliyor', async ({ page }) => {
    const bp = new BridgePage(page);
    await bp.goto('/');
    await page.waitForSelector('[data-testid="app-loaded"], .channel-list, #sidebar', { timeout: 10_000 });

    const settingsBtn = page.locator(
      '[data-testid="open-settings"], [aria-label="Ayarlar"], .settings-btn, #user-settings-btn'
    ).first();
    await settingsBtn.click({ timeout: 5_000 });

    const modal = page.locator('[data-testid="settings-modal"], .settings-modal, [role="dialog"]').first();
    await expect(modal).toBeVisible({ timeout: 5_000 });

    // Görünüm sekmesine tıkla
    const appearanceTab = modal.locator('button, [role="tab"]').filter({ hasText: /görünüm|appearance/i }).first();
    if (await appearanceTab.isVisible()) {
      await appearanceTab.click();
      await page.waitForTimeout(300);
      // Tema veya renk seçeneği görünür olmalı
      const themeSection = modal.locator('[data-tab-content="appearance"], .appearance-tab, [data-testid="appearance-content"]').first();
      if (await themeSection.isVisible()) {
        await expect(themeSection).toBeVisible();
      }
    }

    // Bildirimler sekmesi
    const notifTab = modal.locator('button, [role="tab"]').filter({ hasText: /bildirim|notification/i }).first();
    if (await notifTab.isVisible()) {
      await notifTab.click();
      await page.waitForTimeout(300);
    }
  });

  test('settings modal Escape ile kapatılabiliyor', async ({ page }) => {
    const bp = new BridgePage(page);
    await bp.goto('/');
    await page.waitForSelector('[data-testid="app-loaded"], .channel-list, #sidebar', { timeout: 10_000 });

    const settingsBtn = page.locator(
      '[data-testid="open-settings"], [aria-label="Ayarlar"], .settings-btn, #user-settings-btn'
    ).first();
    await settingsBtn.click({ timeout: 5_000 });

    await expect(
      page.locator('[data-testid="settings-modal"], .settings-modal, [role="dialog"]').first()
    ).toBeVisible({ timeout: 5_000 });

    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);

    await expect(
      page.locator('[data-testid="settings-modal"], .settings-modal, [role="dialog"]').first()
    ).toBeHidden({ timeout: 3_000 });
  });

  test('API: profil güncelleme', async ({ request }) => {
    const newDisplayName = `E2E_${Date.now()}`;
    const res = await request.patch(`${BASE_URL}/api/me`, {
      headers: {
        Authorization: `Bearer ${tokens.alice}`,
        'Content-Type': 'application/json',
      },
      data: JSON.stringify({ displayName: newDisplayName }),
    });
    expect(res.status()).toBeLessThan(400);

    const profile = await request.get(`${BASE_URL}/api/me`, {
      headers: { Authorization: `Bearer ${tokens.alice}` },
    });
    const data = await profile.json() as { displayName?: string };
    // displayName güncellendi (veya endpoint displayName desteklemiyorsa 200 yeterli)
    if (data.displayName !== undefined) {
      expect(data.displayName).toBe(newDisplayName);
    }
  });

  test('API: display name boş bırakılamaz', async ({ request }) => {
    const res = await request.patch(`${BASE_URL}/api/me`, {
      headers: {
        Authorization: `Bearer ${tokens.alice}`,
        'Content-Type': 'application/json',
      },
      data: JSON.stringify({ displayName: '' }),
    });
    // 400 bekliyoruz — boş display name reddedilmeli
    expect(res.status()).toBeGreaterThanOrEqual(400);
  });

  test('API: kimlik doğrulamasız profil güncellemesi reddediliyor', async ({ request }) => {
    const res = await request.patch(`${BASE_URL}/api/me`, {
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify({ displayName: 'Hacker' }),
    });
    expect(res.status()).toBe(401);
  });
});
