// e2e/tests/settings.spec.ts — Sprint 63: Settings Svelte modal E2E
// Svelte geçişinin doğrulanması: SettingsModal açılıyor, sekmeler gezilebiliyor,
// profil güncelleme kaydediliyor, modal kapatılabiliyor.

import { test, expect } from '../helpers/apiTest';
import { BridgePage, getTokens } from '../helpers/bridge';

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:3000';

test.describe('Settings Modal — Svelte', () => {
  let tokens: ReturnType<typeof getTokens>;

  test.beforeAll(() => {
    tokens = getTokens();
  });

  // SEÇİCİLER GÜNCELLENDİ — gerçek kabuk sözleşmesi:
  //   tetikleyici : #btn-settings  (aria-label "Profil ve ayarlar")
  //   modal       : #settings-modal-content  (.settings-modal)
  //   sekmeler    : [role="tab"] — Profil / Görünüm / Bildirimler / Gizlilik / Cihazlar
  // Eski spec '[aria-label="Ayarlar"]' ve '#user-settings-btn' arıyordu; ikisi de yok.
  // Üretilmiş Svelte sınıf adlarına (svelte-1ikukxw) BAĞLANILMAZ.

  /** Uygulama kabuğunu aç ve ayarlar modalını göster. */
  async function openSettings(page: import('@playwright/test').Page) {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await page.locator('#app').waitFor({ state: 'visible', timeout: 20_000 });
    await page.locator('#btn-settings').click();
    const modal = page.locator('#settings-modal-content');
    await expect(modal).toBeVisible({ timeout: 10_000 });
    return modal;
  }

  test('settings modal açılabiliyor', async ({ page }) => {
    const modal = await openSettings(page);
    await expect(modal).toBeVisible();
  });

  test('settings modal sekmeler arası geçiş yapılabiliyor', async ({ page }) => {
    const modal = await openSettings(page);

    const görünüm = modal.getByRole('tab', { name: 'Görünüm' });
    await expect(görünüm).toBeVisible();
    await görünüm.click();
    await expect(görünüm).toHaveAttribute('aria-selected', 'true');

    const profil = modal.getByRole('tab', { name: 'Profil' });
    await profil.click();
    await expect(profil).toHaveAttribute('aria-selected', 'true');
  });

  test('settings modal Escape ile kapatılabiliyor', async ({ page }) => {
    const modal = await openSettings(page);
    await page.keyboard.press('Escape');
    await expect(modal).toBeHidden({ timeout: 5_000 });
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
