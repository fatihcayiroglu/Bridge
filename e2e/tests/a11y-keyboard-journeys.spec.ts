// e2e/tests/a11y-keyboard-journeys.spec.ts
//
// ════════════════════════════════════════════════════════════════════════════
// KLAVYE-YALNIZ YOLCULUKLAR — "axe temiz" ile "klavyeyle KULLANILABILIR" AYNI DEGILDIR
// ════════════════════════════════════════════════════════════════════════════
//
// `a11y.smoke.spec.ts` axe ile WCAG ihlali TARAR ve bu degerlidir. Ama axe
// statik bir anlik goruntuye bakar; su sorulari CEVAPLAYAMAZ:
//
//   · Bir diyalogu Escape ile kapatinca odak, onu ACAN denetime GERI DONUYOR mu?
//     Donmezse klavye kullanicisi sayfanin basina firlar ve yerini kaybeder.
//     Bu, axe'in ASLA yakalayamayacagi bir kusurdur — DOM her iki durumda da
//     "gecerli"dir.
//   · Odak diyalogun ICINDE tutuluyor mu (focus trap)? Tutulmuyorsa kullanici
//     gorunmeyen arka plan denetimlerine sekmeyle gider.
//   · Mesaj yalnizca klavyeyle gonderilebiliyor mu?
//   · %200 yakinlastirmada yatay tasma oluyor mu? (WCAG 1.4.10 Reflow)
//   · `prefers-reduced-motion` gercekten dinleniyor mu?
//
// Bu dosya bunlari GERCEK tarayicida, GERCEK klavye olaylariyla olcer.

import { test, expect, type Page } from '@playwright/test';
import { getTokens, createTestServer, createTestChannel } from '../helpers/bridge';

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:3000';

/** O an odakli ogeyi tanimlayan kisa bir imza dondurur. */
async function focusSignature(page: Page): Promise<string> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return 'BODY';
    const id = el.id ? `#${el.id}` : '';
    const label = el.getAttribute('aria-label') || '';
    const cls = typeof el.className === 'string' && el.className
      ? '.' + el.className.trim().split(/\s+/)[0] : '';
    return `${el.tagName}${id}${cls}${label ? `[${label}]` : ''}`;
  });
}

async function dismissOverlays(page: Page): Promise<void> {
  for (const name of ['Onboarding sihirbazı', 'Bridge başlangıç ekranı']) {
    const dialog = page.getByRole('dialog', { name });
    if (await dialog.count() && await dialog.first().isVisible().catch(() => false)) {
      await page.keyboard.press('Escape');
      await dialog.first().waitFor({ state: 'hidden', timeout: 8_000 }).catch(() => undefined);
    }
  }
}

async function openApp(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem('bridge_locale', 'tr');
    localStorage.setItem('bridge_onboarding_v3:anon', 'done');
  });
  await page.goto(BASE_URL);
  await page.locator('#app').waitFor({ state: 'visible', timeout: 30_000 });
  await dismissOverlays(page);
}

// ══════════════════════════════════════════════════════════════════════════
// FIKSTUR — "ÖLÇÜLEMEDI" YERINE "ÖLÇÜLDÜ"
// ══════════════════════════════════════════════════════════════════════════
// "mesaj yalnizca klavyeyle gonderilebilir" testi, gorunur bir kanal yoksa
// `test.skip(...)` ile atlaniyordu. Atlama DURUSTTU (sessizce gecmiyordu) ama
// bir sey de KANITLAMIYORDU: klavye-yalniz gonderim, erisilebilirligin en
// kritik yolculuklarindan biri ve surekli atlanan bir test, olmayan bir test
// kadar degerlidir.
//
// Kanal artik REST ile TOHUMLANIR; boylece yolculuk her kosumda GERCEKTEN
// olculur. Atlama yolu kaldirilmadi — fikstur kurulamazsa test yine acik bir
// gerekce ile atlanir; fark, artik normal kosumda atlanmamasidir.
let seededServerId = '';
let seededChannelName = '';

test.beforeAll(async ({ request }) => {
  const token = getTokens().alice;
  const stamp = Date.now().toString(36);
  const server = await createTestServer(request, token, `A11Y KB ${stamp}`);
  seededServerId = server?._id || server?.id || '';
  if (!seededServerId) return;
  seededChannelName = `kb-${stamp}`;
  const channel = await createTestChannel(request, token, seededServerId, seededChannelName, 'text');
  if (!(channel?._id || channel?.id)) seededChannelName = '';
});

/** Tohumlanan sunucuya girer; kanal listesi gorunur hale gelir. */
async function openSeededServer(page: Page): Promise<void> {
  if (!seededServerId) return;
  const icon = page.locator(`.server-icon[data-id="${seededServerId}"]`).first();
  if (await icon.count()) {
    await icon.click({ timeout: 20_000 }).catch(() => undefined);
    await page.locator('[aria-label^="Kanal:"]').first()
      .waitFor({ state: 'visible', timeout: 15_000 }).catch(() => undefined);
  }
}

test.describe('keyboard-only journeys', () => {
  test('global search returns focus to where the user was when dismissed', async ({ page }) => {
    await openApp(page);

    // Kullanicinin BASLADIGI yer kaydedilir.
    await page.locator('body').press('Tab');
    const before = await focusSignature(page);

    await page.keyboard.press('Control+f');
    const overlay = page.locator('.gs-overlay, [role="dialog"]').first();
    await overlay.waitFor({ state: 'visible', timeout: 15_000 });

    // Odak paneli ICINDE olmali — aksi halde klavye kullanicisi acilan
    // panelin icine hic giremez.
    const insideDialog = await page.evaluate(() => {
      const dialog = document.querySelector('.gs-overlay, [role="dialog"]');
      return !!dialog && !!document.activeElement && dialog.contains(document.activeElement);
    });
    expect(insideDialog, 'panel acilinca odak icine tasinmali').toBe(true);

    await page.keyboard.press('Escape');
    await overlay.waitFor({ state: 'hidden', timeout: 10_000 });

    // ASIL IDDIA: odak KAYBOLMAMALI. `BODY`ye dusmek, klavye kullanicisinin
    // sayfanin en basina firlamasi demektir.
    const after = await focusSignature(page);
    expect(after, 'Escape sonrasi odak BODY\'ye dusmemeli').not.toBe('BODY');
    expect(after).toBe(before);
  });

  test('command palette traps focus and restores it on close', async ({ page }) => {
    await openApp(page);
    await page.locator('body').press('Tab');
    const before = await focusSignature(page);

    await page.keyboard.press('Control+k');
    const palette = page.locator('.cp-overlay, [role="dialog"]').first();
    await palette.waitFor({ state: 'visible', timeout: 15_000 });

    // Ic tuzak: bircok kez Tab'a basildiginda odak HALA diyalogun icinde olmali.
    for (let i = 0; i < 12; i += 1) await page.keyboard.press('Tab');
    const stillInside = await page.evaluate(() => {
      const dialog = document.querySelector('.cp-overlay, [role="dialog"]');
      return !!dialog && !!document.activeElement && dialog.contains(document.activeElement);
    });
    expect(stillInside, '12 Tab sonrasi odak diyalogun disina kacmamali').toBe(true);

    await page.keyboard.press('Escape');
    await palette.waitFor({ state: 'hidden', timeout: 10_000 });
    expect(await focusSignature(page)).toBe(before);
  });

  test('a message can be sent with the keyboard alone', async ({ page }) => {
    await openApp(page);
    await openSeededServer(page);
    const channel = page.locator('[aria-label^="Kanal:"]').first();
    // Fikstur kuruldugu icin bu yola normalde DUSULMEZ; yalnizca tohumlama
    // basarisiz olursa atlanir ve gerekce acikca yazilir.
    if (!(await channel.count())) test.skip(true, 'kanal fikstürü kurulamadı — ölçülemiyor');
    await channel.click();
    const composer = page.locator('#msg-input');
    await composer.waitFor({ state: 'visible', timeout: 20_000 });

    // Fare KULLANILMAZ: composer'a klavyeyle odaklanilir.
    await composer.focus();
    const text = `kbd-${Date.now()}`;
    await page.keyboard.type(text);
    await page.keyboard.press('Enter');

    await expect(page.locator('.msg-list').getByText(text, { exact: false }).first())
      .toBeVisible({ timeout: 20_000 });
    // Gonderimden sonra odak composer'da KALMALI ki kullanici yazmaya devam etsin.
    expect(await focusSignature(page)).toContain('msg-input');
  });

  test('settings dialog is escapable and restores focus', async ({ page }) => {
    await openApp(page);
    const trigger = page.locator('#btn-settings');
    if (!(await trigger.count())) test.skip(true, 'ayarlar dugmesi yok');
    await trigger.focus();
    const before = await focusSignature(page);
    await page.keyboard.press('Enter');

    const dialog = page.locator('[role="dialog"]').first();
    await dialog.waitFor({ state: 'visible', timeout: 15_000 });
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden', timeout: 10_000 });

    expect(await focusSignature(page)).toBe(before);
  });
});

test.describe('reflow and motion preferences', () => {
  // WCAG 2.1 SC 1.4.10 (Reflow): 320 CSS px genisligine denk gelen
  // yakinlastirmada YATAY kaydirma olusmamalidir. Yatay kaydirma, buyutme
  // kullanan kisiler icin her satirda iki yonlu kaydirma demektir.
  for (const zoom of [1.25, 1.5, 2] as const) {
    test(`no horizontal overflow at ${Math.round(zoom * 100)}% zoom`, async ({ page }) => {
      // Yakinlastirma, viewport'u kucultmeye denktir (CSS px cinsinden).
      await page.setViewportSize({ width: Math.round(1280 / zoom), height: Math.round(900 / zoom) });
      await openApp(page);

      const overflow = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      // Yuvarlama paylari icin 2 px tolerans.
      expect(overflow.scrollWidth,
        `%${Math.round(1 / 1 * 100)} yakinlastirmada belge yatay tasiyor`)
        .toBeLessThanOrEqual(overflow.clientWidth + 2);
    });
  }

  test('honours prefers-reduced-motion', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openApp(page);

    // Azaltilmis hareket istendiginde uzun sureli animasyon/gecis KALMAMALI.
    // Esik cömerttir (120 ms): amac dekoratif uzun animasyonlari yakalamak,
    // mikro gecisleri yasaklamak degil.
    const longAnimations = await page.evaluate(() => {
      const offenders: string[] = [];
      for (const el of Array.from(document.querySelectorAll('*')).slice(0, 3000)) {
        const cs = getComputedStyle(el);
        const dur = (v: string) => Math.max(0, ...v.split(',').map(x => {
          const n = parseFloat(x);
          return x.includes('ms') ? n : n * 1000;
        }).filter(n => Number.isFinite(n)));
        const worst = Math.max(dur(cs.animationDuration || '0s'), dur(cs.transitionDuration || '0s'));
        if (worst > 120) {
          offenders.push(`${el.tagName}.${String((el as HTMLElement).className).slice(0, 30)}=${worst}ms`);
        }
      }
      return offenders.slice(0, 10);
    });
    expect(longAnimations, 'reduced-motion altinda uzun animasyon kalmamali').toEqual([]);
  });
});
