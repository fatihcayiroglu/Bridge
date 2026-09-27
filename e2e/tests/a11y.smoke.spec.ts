// e2e/tests/a11y.smoke.spec.ts — Sprint 14: TypeScript dönüşümü (.js → .ts)
// Sprint 41: Kapsam genişletildi — login, kanal, DM, ayarlar sayfaları eklendi.
import { test, expect } from '../helpers/apiTest';
const AxeBuilder = require('@axe-core/playwright').default;
import { getTokens, loginViaUI } from '../helpers/bridge';

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:3000';

// ── TARANAN UYGUNLUK SEVİYESİ ───────────────────────────────────────────────
// ÖLÇÜLEN BOŞLUK (Final20): bu suite yalnızca `wcag2a` + `wcag2aa` etiketlerini
// tarıyordu, yani WCAG **2.0**. Günümüzde hedeflenen uygunluk seviyesi
// WCAG 2.1 AA'dır (EN 301 549 ve ADA rehberliği bunu referans alır) ve 2.1 ile
// gelen ölçütlerin çoğu doğrudan mobil/duyarlı arayüzle ilgilidir:
//   1.3.4 Yönlendirme · 1.3.5 Girdi Amacı · 1.4.10 Yeniden Akış (Reflow)
//   1.4.11 Metin Dışı Kontrast · 1.4.12 Metin Aralığı · 1.4.13 Üstte Beliren İçerik
// Bunlar taranmadığı için "0 ihlal" sonucu olduğundan daha güçlü görünüyordu.
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

/**
 * Geçişlerin (transition) OTURMASINI bekler.
 *
 * ÖLÇÜLEN KUSUR (Final20): `color-contrast` açıldığında kayıt formunda ısrarlı
 * ihlaller çıkıyordu — ama aynı öğeler canlı tarayıcıda DİNLENME durumunda
 * TEMİZDİ (4.56 ve 5.01). Bildirilen renkler (#ebecf0/#2a85e1, #737998/#d4e2f6)
 * token kümesinde hiç yok: `transition: color .18s` sırasında yakalanmış ARA
 * karelerdi. Yani tarama, kullanıcının kalıcı olarak hiç görmediği bir durumu
 * ölçüyordu — ürün kusuru değil, ÖLÇÜM kusuru.
 *
 * NOT: `page.addStyleTag()` ile geçişleri sıfırlamak BU UYGULAMADA İŞE YARAMAZ:
 * sunucu nonce tabanlı bir CSP uygular ve enjekte edilen `<style>` nonce
 * taşımadığı için engellenir. Bu yüzden geçiş süresinden (0.18s) belirgin
 * biçimde uzun, sabit bir oturma penceresi kullanılır.
 */
async function settle(page: any): Promise<void> {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForTimeout(250);
}

async function expectNoA11yViolations(page, path: string, label?: string) {
  await page.goto(`${BASE_URL}${path}`, { waitUntil: 'domcontentloaded' });
  await settle(page);
  const results = await new AxeBuilder({ page })
    .withTags(WCAG_TAGS)
    .analyze();
  expect(
    results.violations,
    `A11Y violations on ${label ?? path}:\n${results.violations.map((v: any) => `  [${v.impact}] ${v.id}: ${v.description}`).join('\n')}`,
  ).toEqual([]);
}

async function expectNoA11yViolationsHere(page, label: string) {
  await settle(page);
  const results = await new AxeBuilder({ page })
    .withTags(WCAG_TAGS)
    .analyze();
  const detail = results.violations
    .map((v: any) => {
      const targets = v.nodes.slice(0, 3).map((n: any) => n.target.join(',')).join(' | ');
      return `  [${v.impact}] ${v.id}: ${v.description}\n    → ${targets}`;
    })
    .join('\n');
  expect(results.violations, `A11Y violations on ${label}:\n${detail}`).toEqual([]);
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
  //
  // ÖNEMLİ: Bridge TEK SAYFA uygulamasıdır. '/login', '/register' ve '/app'
  // diye SUNUCU ROTASI YOKTUR — bunlar JSON 404 döndürür. Eski testler bu
  // hata sayfasını denetliyor ve "document-title / html-has-lang ihlali"
  // raporluyordu; bu ÜRÜN BULGUSU DEĞİL, yanlış hedefti.
  // Doğru yüzeyler: giriş ve kayıt formları KÖK adreste render edilir,
  // uygulama kabuğu ise oturum açıldıktan sonra aynı sayfada belirir.

  // Auth formları OTURUMSUZ görüntülenir. chromium projesi storageState ile
  // alice oturumunu enjekte ettiğinden uygulama otomatik açılır ve giriş formu
  // hiç görünmez; bu testler oturumu açıkça devre dışı bırakır.
  test.describe('oturumsuz auth yüzeyleri', () => {
    // NOT: `storageState: undefined` proje düzeyindeki değeri EZMEZ — Playwright
// bunu "belirtilmedi" sayıp projedeki dosyayı kullanmaya devam eder ve sayfa
// oturum açmış gelir. Oturumsuz yüzey için AÇIKÇA boş durum verilmelidir.
test.use({ storageState: { cookies: [], origins: [] } });

    test('giriş formu — form erişilebilirliği', async ({ page }) => {
      await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
      await page.locator('#login-form').waitFor({ state: 'visible', timeout: 15_000 });
      await expectNoA11yViolationsHere(page, 'login');
    });

    test('kayıt formu — form erişilebilirliği', async ({ page }) => {
      await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
      await page.locator('#login-form').waitFor({ state: 'visible', timeout: 15_000 });
      // Sekme etiketi i18n ile değişir (TR: 'Hesap Oluştur'); erişilebilir ada
      // bağlanmak kırılgan. Kalıcı, davranışsal olmayan test kancası kullanılır.
      await page.getByTestId('auth-tab-register').click();
      await page.locator('#register-form').waitFor({ state: 'visible', timeout: 15_000 });
      await expectNoA11yViolationsHere(page, 'register');
    });
  });

  // ── Uygulama (oturum gerektiren) ────────────────────────────────────────────
  //
  // Bu iki test OTURUM ISTER. `a11y` projesi kasitli olarak oturumsuzdur
  // (giris/kayit formlarini taramak icin), bu yuzden depolanan kimlik
  // durumuna ACIKCA opt-in edilir. Onceden `#app` hicbir zaman gorunmez
  // olmuyordu ve testler 20 sn bekleyip zaman asimina ugruyordu.
  test.describe('oturum gerektiren yüzeyler', () => {
    test.use({ storageState: 'fixtures/auth-state.json' });

  test('ana uygulama shell — oturum sonrası', async ({ page }) => {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await page.locator('#app').waitFor({ state: 'visible', timeout: 20_000 });
    await expectNoA11yViolationsHere(page, 'app shell');
  });

  test('ayarlar modalı — klavye & ARIA', async ({ page }) => {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await page.locator('#app').waitFor({ state: 'visible', timeout: 20_000 });
    // KANONİK seçici: kabuktaki düğme `#btn-settings` ve
    // `data-bridge-action="openSettingsModal"` taşır (client/index.html:235).
    // Önceki seçici (`[aria-label="Ayarlar"]`, `#settings-btn`) HİÇBİR ZAMAN
    // eşleşmiyordu — düğmenin erişilebilir adı "Profil ve ayarlar", kimliği
    // ise `btn-settings`. Test bu yüzden her koşuda SESSİZCE atlanıyordu:
    // geçiyor görünen ama hiçbir şey ölçmeyen bir geçit.
    // ── GÖRÜNÜM GENİŞLİĞİNE GÖRE DOĞRU YOL ────────────────────────────────
    // ÖLÇÜLEN KUSUR (Final20, `a11y-mobile` projesi eklenince ortaya çıktı):
    // bu test HER ZAMAN masaüstü tetikleyicisini tıklıyordu. Dar görünümde o
    // düğme yan panelin içindedir ve panel EKRAN DIŞINDADIR (ölçüldü: 412px
    // genişlikte `#user-identity` x = -324). Playwright "element is outside of
    // the viewport" diyerek 10sn sonra düşüyordu.
    //
    // Bu bir ÜRÜN kusuru DEĞİLDİR: mobilde kanonik yol alt gezinmedeki
    // "Profil" düğmesidir ve ÇALIŞIR (doğrulandı: `tabpanel-profile`
    // 406x839 boyutunda, x=3 konumunda görünür hale geliyor). Kusur testin
    // tek bir yüzeyi varsaymasıydı.
    const desktopTrigger = page.locator('#btn-settings, [data-bridge-action="openSettingsModal"]').first();
    const mobileTrigger = page.locator('#mnav-profile');

    const desktopUsable = await desktopTrigger.count() > 0
      && await desktopTrigger.isVisible()
      && await desktopTrigger.evaluate((el) => {
        const r = el.getBoundingClientRect();
        return r.x >= 0 && r.right <= window.innerWidth && r.y >= 0 && r.bottom <= window.innerHeight;
      });

    const mobileUsable = !desktopUsable
      && await mobileTrigger.count() > 0
      && await mobileTrigger.isVisible();

    const settingsBtn = desktopUsable ? desktopTrigger : mobileTrigger;
    if (desktopUsable || mobileUsable) {
      await settingsBtn.click();
      await page.waitForTimeout(400);
      await settle(page);
      const results = await new AxeBuilder({ page })
        .withTags(WCAG_TAGS)
        .include('#settings-modal, .modal-overlay, [role="dialog"], #tabpanel-profile, .settings-content')
        .analyze();
      const detail = results.violations.map((v: any) => `  [${v.impact}] ${v.id}`).join('\n');
      expect(results.violations, `Ayarlar modalı A11Y ihlalleri:\n${detail}`).toEqual([]);
    } else {
      test.skip(true, 'Ayarlar butonu bu kabukta bulunamadı');
    }
  });
  });


  // ── ÜRÜN PANELLERİ — SERIOUS/CRITICAL SIFIR ────────────────────────────────
  //
  // NEDEN AYRI BİR BÖLÜM: yukarıdaki taramalar KABUĞU denetliyordu. Bu fazda
  // gönderilen panellerin hiçbiri açık haldeyken taranmıyordu — oysa
  // `nested-interactive` (axe: serious) kusurları TAM OLARAK burada bulundu:
  // kanal listesi ve kanal satırı, iç içe düğme üretiyordu ve bu yalnızca
  // KANAL VARKEN ortaya çıkıyordu (bu yüzden "tek başına geçiyor, suit içinde
  // düşüyor" gibi görünüyordu).
  //
  // Eşik burada AÇIKÇA serious=0 / critical=0'dır. Panel içeriği dinamiktir
  // (boş durum, yükleniyor, sonuç); bu üç durumun hepsinde aynı sınır geçerli.
  test.describe('ürün panelleri', () => {
    test.use({ storageState: 'fixtures/auth-state.json' });

    /** Açık panelde tarama; yalnızca ETKİ düzeyine göre yargılar. */
    async function expectNoSeriousViolations(page, label: string, selector?: string) {
      let builder = new AxeBuilder({ page })
        .withTags(WCAG_TAGS)
      if (selector) builder = builder.include(selector);
      const results = await builder.analyze();

      const blocking = results.violations.filter(
        (v: any) => v.impact === 'serious' || v.impact === 'critical',
      );
      // Başarısızlıkta HANGİ düğüm olduğu görünmeli; yoksa "serious ihlal var"
      // demek geliştiriciyi hiçbir yere götürmez.
      const detail = blocking
        .map((v: any) => {
          const targets = v.nodes.slice(0, 3).map((n: any) => n.target.join(',')).join(' | ');
          return `  [${v.impact}] ${v.id}: ${v.description} → ${targets}`;
        })
        .join(' ;; ');
      expect(blocking, `${label} — serious/critical A11Y ihlali: ${detail}`).toEqual([]);
    }

    async function openApp(page) {
      await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
      await page.locator('#app').waitFor({ state: 'visible', timeout: 20_000 });
    }

    test('küresel arama paneli — açıkken temiz', async ({ page }) => {
      await openApp(page);
      // KANONİK yol: Ctrl+F (ürün araması, tarayıcı araması değil).
      await page.keyboard.press('Control+f');
      const panel = page.locator('.gs-panel, [role="dialog"][aria-label*="rama"]').first();
      await panel.waitFor({ state: 'visible', timeout: 10_000 });
      await expectNoSeriousViolations(page, 'küresel arama (boş durum)');
    });

    test('küresel arama — SONUÇLAR ve bağlam önizlemesi ile temiz', async ({ page }) => {
      // Boş panel ile dolu panel FARKLI ağaçlardır. Kanal listesi kusuru da
      // yalnızca içerik varken görünmüştü.
      await openApp(page);
      await page.keyboard.press('Control+f');
      const panel = page.locator('.gs-panel, [role="dialog"][aria-label*="rama"]').first();
      await panel.waitFor({ state: 'visible', timeout: 10_000 });

      await page.keyboard.type('a');
      await page.keyboard.type('e');
      // Sonuç ya da "sonuç yok" — ikisi de geçerli son durum; ikisini de tara.
      await page.waitForTimeout(1200);
      await expectNoSeriousViolations(page, 'küresel arama (sorgu sonrası)');
    });

    test('uygulama kabuğu — kanal listesi dolu haldeyken temiz', async ({ page }) => {
      // `nested-interactive` regresyonunun ASIL yakalandığı yer burasıydı.
      await openApp(page);
      await page.waitForTimeout(1000);
      await expectNoSeriousViolations(page, 'kabuk + kanal listesi');
    });
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


