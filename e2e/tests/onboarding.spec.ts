// e2e/tests/onboarding.spec.ts
//
// İLK ÇALIŞTIRMA — TANITIM TURU KABUĞU BLOKLAMAZ
//
// ════════════════════════════════════════════════════════════════════════════
// NEDEN VAR
// ════════════════════════════════════════════════════════════════════════════
// Otomasyon sırasında "onboarding arkaplanı tüm tıklamaları yutuyor" bulgusu
// çıktı. İncelemede modalin KENDİSİ doğru kurulmuş olduğu görüldü: kapatma
// düğmesi, "Atla", Escape, arkaplan tıklaması, odak tuzağı ve odak iadesi
// hepsi mevcut. Yani tıklamaları engellemesi DOĞRU modal davranışıdır.
//
// Gerçek kusurlar başkaydı ve ikisi de burada kilitlenir:
//
//   1. TUR, DEVAM EDEN ETKİLEŞİMİ ÇALIYORDU. Kimlik doğrulamadan 800 ms
//      SONRA açılıyordu; kabuk o an zaten etkileşime hazırdır. Kullanıcı bir
//      kanala tıklamaya başlamışsa tam ekran modal önüne atlar.
//
//   2. KAPATILDIKTAN SONRA GERİ AÇILAMIYORDU. `showOnboardingWizard`
//      kayıtlıydı ama istemcinin tamamında TEK bir çağıranı yoktu — öğretici
//      bir yüzey için bu, özelliğin yok olması demektir.

import { test, expect, type Page, type Browser } from '@playwright/test';
import fs from 'fs';
import path from 'path';

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:3000';
const WIZARD = '[aria-label="Onboarding sihirbazı"]';

function aliceToken(): string {
  const raw = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'tokens.json'), 'utf8'),
  );
  return raw.alice as string;
}

/**
 * Rakip ilk-çalıştırma yüzeyini (boş sunucu ekranı) kapatır.
 *
 * Sunucusu olmayan bir kullanıcıda o ekran MEŞRU biçimde açılır ve tur
 * sırasını bekler. Turun kendi davranışını ölçmek için sahne temizlenir.
 */
async function clearCompetingModal(page: Page): Promise<void> {
  // O ekran kimlik doğrulamadan ~800 ms SONRA açılır; hemen bakmak erken
  // olur. Gerçek kullanıcı sırası da budur: önce onu kapatır, sonra tur gelir.
  const other = page.locator('.empty-server-backdrop');
  try {
    await other.waitFor({ state: 'visible', timeout: 4_000 });
  } catch {
    return;                       // bu kullanıcının sunucusu var — rakip yok
  }
  await page.locator('.ess-close').first().click();
  await expect(other).toBeHidden();
}

/** Turu HİÇ görmemiş bir kullanıcı: onboarding anahtarı YAZILMAZ. */
async function freshUser(browser: Browser): Promise<{ page: Page; close: () => Promise<void> }> {
  const ctx = await browser.newContext({
    storageState: {
      cookies: [],
      origins: [{
        origin: BASE_URL,
        localStorage: [
          { name: 'token', value: aliceToken() },
          { name: 'bridge_token', value: aliceToken() },
        ],
      }],
    },
  });
  const page = await ctx.newPage();
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await page.locator('#app').waitFor({ state: 'visible', timeout: 25_000 });
  await clearCompetingModal(page);
  return { page, close: () => ctx.close() };
}

test.describe('ilk çalıştırma — tanıtım turu', () => {
  test('tur ilk açılışta KENDİLİĞİNDEN görünür', async ({ browser }) => {
    const { page, close } = await freshUser(browser);
    try {
      // Kullanıcı hiçbir şey yapmazsa tur açılmalıdır — öğretici yüzeyin
      // var olma sebebi budur.
      await expect(page.locator(WIZARD)).toBeVisible({ timeout: 15_000 });
    } finally { await close(); }
  });

  test('KAPATMA düğmesi turu kapatır ve kabuk hemen kullanılabilir', async ({ browser }) => {
    const { page, close } = await freshUser(browser);
    try {
      const wizard = page.locator(WIZARD);
      await expect(wizard).toBeVisible({ timeout: 15_000 });

      await page.locator('button[aria-label="Kapat"]').first().click();
      await expect(wizard).toBeHidden();

      // Görünmez bir arkaplan KALMAMALI. `toBeHidden` tek başına yetmez:
      // kalıntı bir overlay hâlâ pointer olaylarını yutabilirdi. Bu yüzden
      // kabuktaki gerçek bir kontrolün konumunda HANGİ elemanın olduğu
      // sorulur — sihirbaza ait bir düğüm çıkarsa kalıntı var demektir.
      //
      // NOT: doğrudan tıklamak DOĞRU kontrol değildi. Sunucusu olmayan bir
      // kullanıcıda `EmptyServerStart` meşru biçimde açık kalır ve kabuğu
      // kapatır; o zaman tıklama sihirbazdan değil, BAŞKA bir yüzeyden
      // engellenir. Aranan şey sihirbazın kalıntısıdır.
      const leftover = await page.evaluate(() => {
        const btn = document.querySelector('#btn-settings');
        if (!btn) return false;
        const r = btn.getBoundingClientRect();
        const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return !!at?.closest('[aria-label="Onboarding sihirbazı"]');
      });
      expect(leftover, 'sihirbazdan kalıntı bir overlay duruyor').toBe(false);
    } finally { await close(); }
  });

  test('"Atla" turu kapatır', async ({ browser }) => {
    const { page, close } = await freshUser(browser);
    try {
      await expect(page.locator(WIZARD)).toBeVisible({ timeout: 15_000 });
      await page.getByRole('button', { name: 'Onboarding\'i atla' }).click();
      await expect(page.locator(WIZARD)).toBeHidden();
    } finally { await close(); }
  });

  test('KLAVYE: Escape turu kapatır', async ({ browser }) => {
    const { page, close } = await freshUser(browser);
    try {
      await expect(page.locator(WIZARD)).toBeVisible({ timeout: 15_000 });
      await page.keyboard.press('Escape');
      await expect(page.locator(WIZARD)).toBeHidden();
    } finally { await close(); }
  });

  test('ODAK tur içinde tutulur', async ({ browser }) => {
    const { page, close } = await freshUser(browser);
    try {
      await expect(page.locator(WIZARD)).toBeVisible({ timeout: 15_000 });
      // Birkaç Tab sonrasında odak HÂLÂ diyaloğun içinde olmalıdır.
      for (let i = 0; i < 6; i++) await page.keyboard.press('Tab');
      const inside = await page.evaluate((sel) => {
        const dialog = document.querySelector(sel);
        return !!dialog && !!document.activeElement && dialog.contains(document.activeElement);
      }, WIZARD);
      expect(inside, 'odak diyaloğun dışına kaçtı').toBe(true);
    } finally { await close(); }
  });

  test('kapatıldıktan sonra YENİDEN YÜKLEMEDE geri açılmaz', async ({ browser }) => {
    const { page, close } = await freshUser(browser);
    try {
      await expect(page.locator(WIZARD)).toBeVisible({ timeout: 15_000 });
      await page.keyboard.press('Escape');
      await expect(page.locator(WIZARD)).toBeHidden();

      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.locator('#app').waitFor({ state: 'visible', timeout: 25_000 });
      // Tamamlanma durumu kullanıcı bazlı saklanır; tekrar açılması
      // kullanıcıyı her yüklemede rahatsız ederdi.
      await expect(page.locator(WIZARD)).toBeHidden({ timeout: 8_000 });
    } finally { await close(); }
  });

  test('kullanıcı ZATEN etkileşime başladıysa tur araya GİRMEZ', async ({ browser }) => {
    // Asıl kusur buydu: 800 ms gecikmeyle açılan modal, kullanıcının
    // başlattığı tıklamayı çalıyordu.
    const { page, close } = await freshUser(browser);
    try {
      // Kabuk görünür görünmez kullanıcı gibi davran.
      await page.mouse.move(200, 200);
      await page.mouse.down();
      await page.mouse.up();

      await expect(page.locator(WIZARD)).toBeHidden({ timeout: 6_000 });
    } finally { await close(); }
  });

  test('tur KOMUT PALETİNDEN geri açılabilir', async ({ browser }) => {
    // Kapatıldıktan sonra geri dönüş yolu OLMALI; aksi halde öğretici yüzey
    // ilk kapatmada kalıcı olarak kaybolur.
    const { page, close } = await freshUser(browser);
    try {
      await expect(page.locator(WIZARD)).toBeVisible({ timeout: 15_000 });
      await page.keyboard.press('Escape');
      await expect(page.locator(WIZARD)).toBeHidden();

      await page.keyboard.press('Control+k');
      const palette = page.locator('[role="dialog"]').first();
      await palette.waitFor({ state: 'visible', timeout: 10_000 });
      await page.keyboard.type('tanıtım');

      const entry = page.getByText('Tanıtım Turunu Göster').first();
      await expect(entry, 'palette girdisi bulunamadı').toBeVisible({ timeout: 8_000 });
      await entry.click();

      await expect(page.locator(WIZARD)).toBeVisible({ timeout: 8_000 });
    } finally { await close(); }
  });
});
