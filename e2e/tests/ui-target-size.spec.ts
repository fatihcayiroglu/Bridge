// e2e/tests/ui-target-size.spec.ts
//
// DOKUNMA HEDEFİ BOYUTU — WCAG 2.2 SC 2.5.8 (GERİLEME KİLİDİ)
//
// ════════════════════════════════════════════════════════════════════════════
// NEDEN BU DOSYA VAR
// ════════════════════════════════════════════════════════════════════════════
// UI/UX alanı bu programa kadar "sistematik olarak denetlenmedi" diye DÜŞÜK
// güvenle puanlanmıştı. Gerçek render'da 7 genişlik × 2 dil ölçülünce
// 182 ihlal çıktı:
//
//   .ow-dot      8×8  ve 10×10   → onboarding adım gezinme (role="tab", onclick)
//   .ch-open     yükseklik 21px  → KANAL AÇMA (uygulamanın birincil gezinmesi)
//   .cat-toggle  yükseklik 17px  → kategori aç/kapa
//
// Üçü de dekoratif değil, GERÇEK tıklanabilir kontroldü. İnce motor kontrolü
// kısıtlı kullanıcılar ve dokunmatik kullanıcılar için isabet ettirilemezdi.
//
// Düzeltme SALT CSS'tir ve görsel tasarımı korur: `.ow-dot` görsel olarak
// 8px nokta kalır, ::before ile 24×24 şeffaf hedefe oturur.
//
// ── BU TESTİN ROLÜ ──────────────────────────────────────────────────────────
// Düzeltmeyi kilitler. Biri bir kontrolü tekrar 24px altına indirirse burada
// yakalanır — statik CSS okumasıyla değil, GERÇEK render ölçümüyle.
//
// ── DÜRÜSTLÜK NOTU ──────────────────────────────────────────────────────────
// Aynı denetim `.member-panel` için 112 "viewport dışı" ölçümü de üretmişti.
// ETKİLEŞİMLİ doğrulama (e2e/_memberpanel.cjs) bunun KASITLI bir off-canvas
// çekmece olduğunu gösterdi: mobilde iki görünür kontrol paneli açıyor
// (left 406 → 91). O ölçüm YANLIŞ POZİTİFTİ ve kusur olarak sayılmadı.

import { test, expect } from '../helpers/apiTest';

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:3000';

/** WCAG 2.2 SC 2.5.8 — Hedef Boyutu (Minimum). */
const MIN_TARGET = 24;

const SELECTOR = 'button, a[href], input:not([type="hidden"]), select, textarea, [role="button"], [role="tab"]';

async function tooSmall(page: import('@playwright/test').Page) {
  return page.evaluate(({ sel, min }) => {
    const out: { el: string; w: number; h: number }[] = [];
    for (const el of Array.from(document.querySelectorAll(sel))) {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      // Yalnizca GERCEKTEN gorunur ve etkilesimli olanlar.
      if (r.width === 0 || r.height === 0) continue;
      if (cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0') continue;
      if ((el as HTMLButtonElement).disabled) continue;
      // Viewport disindaki (kapali cekmece) elemanlar bu testin konusu degil.
      if (r.right <= 0 || r.left >= document.documentElement.clientWidth) continue;

      if (r.width < min || r.height < min) {
        const id = el.id ? '#' + el.id : '';
        const cls = typeof el.className === 'string' && el.className
          ? '.' + el.className.trim().split(/\s+/)[0] : '';
        out.push({ el: (el.tagName.toLowerCase() + id + cls).slice(0, 60),
                   w: Math.round(r.width), h: Math.round(r.height) });
      }
    }
    return out;
  }, { sel: SELECTOR, min: MIN_TARGET });
}

for (const width of [360, 390, 430]) {
  test(`dokunma hedefleri ${width}px genişlikte 24×24 minimumunu karşılar`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(BASE_URL);
    await expect(page.locator('#app')).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(2000);

    expect({ width, ihlal: await tooSmall(page) }).toEqual({ width, ihlal: [] });
  });
}

test('masaüstü genişlikte de ihlal yok (1280)', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(BASE_URL);
  await expect(page.locator('#app')).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(2000);

  expect({ ihlal: await tooSmall(page) }).toEqual({ ihlal: [] });
});

// ── POZİTİF KONTROL ─────────────────────────────────────────────────────────
// Ölçüm mantığı gerçekten çalışıyor mu? Kasıtlı olarak küçük bir düğme
// enjekte edilir ve YAKALANMASI beklenir. Bu olmadan yukarıdaki dört test,
// seçici hiçbir şey eşleştirmese de yeşil kalırdı.
test('POZİTİF KONTROL: ölçüm gerçekten küçük hedefi yakalar', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(BASE_URL);
  await expect(page.locator('#app')).toBeVisible({ timeout: 30_000 });

  await page.evaluate(() => {
    const b = document.createElement('button');
    b.id = 'wcag-negatif-kontrol';
    b.style.cssText = 'width:10px;height:10px;position:fixed;left:5px;top:5px;z-index:1';
    document.body.appendChild(b);
  });

  const ihlal = await tooSmall(page);
  expect({ yakalandi: ihlal.some(x => x.el.includes('wcag-negatif-kontrol')) })
    .toEqual({ yakalandi: true });

  await page.evaluate(() => document.getElementById('wcag-negatif-kontrol')?.remove());
});
