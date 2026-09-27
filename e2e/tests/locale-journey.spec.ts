// e2e/tests/locale-journey.spec.ts
//
// FAZ 4 — İNGİLİZCE VE TÜRKÇE ÜRÜN YOLCULUKLARI
//
// ════════════════════════════════════════════════════════════════════════════
// BU SUITE NEYİ KANITLAR
// ════════════════════════════════════════════════════════════════════════════
// Birim testleri çeviri tablolarının bütünlüğünü ve `t()` sarmalayıcısının
// reaktifliğini doğrular. Burada sorulan soru daha basit ve daha sert:
//
//     GERÇEK TARAYICIDA dili değiştiren bir kullanıcı, arayüzün gerçekten
//     değiştiğini görüyor mu?
//
// ── NEDEN BU SORU ÖNEMLİYDİ ───────────────────────────────────────────────
// Kapanış programı sırasında bulunan kusur şuydu: `i18n/index.ts` içindeki
// `t()` modül düzeyinde düz bir tablo okur ve Svelte 5'te bu HİÇBİR reaktif
// bağımlılık kurmaz. `i18n-dom.ts` de yalnızca `index.html` içindeki
// `data-i18n` düğümlerini günceller. Yani 10 dillik çeviri altyapısı ve
// çalışan bir dil seçici vardı — ama seçim, EKRANDA DURAN Svelte
// bileşenlerine YANSIMIYORDU. Kullanıcı için özellik sessizce ölüydü.
//
// Bu yolculuklar o kusurun geri gelmesini engeller.

import { test, expect } from '../helpers/apiTest';
import type { Page } from '@playwright/test';

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:3000';

/** Dili localStorage üzerinden sabitle ve taze yükle. */
async function loadWithLocale(page: Page, locale: 'tr' | 'en'): Promise<void> {
  await page.goto(BASE_URL);
  await page.evaluate((loc) => {
    try { localStorage.setItem('bridge_locale', loc); } catch { /* yok say */ }
  }, locale);
  await page.reload();
  // Çeviri tablosu asenkron yüklenir; <html lang> güncellenince hazırdır.
  await page.waitForFunction(
    (loc) => document.documentElement.getAttribute('lang') === loc,
    locale,
    { timeout: 15_000 },
  );
}

test.describe('dil yolculukları', () => {
  test('TÜRKÇE: <html lang> ve arayüz Türkçe', async ({ page }) => {
    await loadWithLocale(page, 'tr');
    await expect(page.locator('html')).toHaveAttribute('lang', 'tr');

    // Türkçe'ye özgü karakterler sayfada görünür olmalı.
    const text = await page.evaluate(() => document.body.innerText);
    expect(text.length).toBeGreaterThan(20);
    expect(/[çğıöşüÇĞİÖŞÜ]/.test(text)).toBe(true);
  });

  test('İNGİLİZCE: <html lang> ve arayüz İngilizce', async ({ page }) => {
    await loadWithLocale(page, 'en');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');

    const text = await page.evaluate(() => document.body.innerText);
    expect(text.length).toBeGreaterThan(20);
  });

  test('İNGİLİZCE arayüzde TÜRKÇE metin KALMAZ', async ({ page }) => {
    // ── BU IDDIA ARTIK ANLAMLI ────────────────────────────────────────────
    // Goc oncesi arayuzun ~%66'si sabit Turkce oldugu icin boyle bir iddia
    // her zaman duserdi ve yazilamazdi. Goc tamamlandiktan sonra (0 sabit
    // kodlu kullaniciya gorunur Turkce dize) Ingilizce arayuzde Turkce'ye
    // OZGU harflerin bulunmamasi gercek bir kalite olcusudur.
    //
    // KULLANICI ICERIGI haric tutulamadigi icin esik sifir degil, DUSUK
    // tutulur: fikstur kullanicilarinin adlari (ornegin "Alice E2E") Turkce
    // harf tasimaz, ama sunucu/kanal adlari testler arasinda degisebilir.
    await loadWithLocale(page, 'en');
    const text = await page.evaluate(() => document.body.innerText);
    // Final21 Faz 19: ü/ö/Ü/Ö EKSİKTİ — "Üyeler" (üye paneli başlığı) İngilizce arayüzde
    // görünürken bu iddia yeşildi.
    const turkishChars = (text.match(/[çğışöüÇŞĞİÖÜ]/g) ?? []).length;
    expect({ turkishChars }).toEqual({ turkishChars: 0 });
  });

  test('İNGİLİZCE: AÇILIŞTA monte edilen bileşenler ve kabuk erişilebilir adları İngilizce', async ({ page }) => {
    // Final21 Faz 19 — ÜRETİM PAKETİNDE `t()` REAKTİF DEĞİLDİ. `reactive.svelte.ts` içindeki
    // çıplak `_tick;` okuması derleme sırasında siliniyordu; açılışta (tablo yüklenmeden)
    // monte edilen bileşenler Türkçe yedekte kalıyordu: üye paneli "Topluluk / Üyeler",
    // keşfet ipucu, sunucu menüsü. Birim testleri geliştirme derlemesini koştuğu için
    // göremedi. Ekran okuyucunun okuduğu `aria-label` / ipuçları `innerText`te görünmez;
    // ayrıca ölçülür.
    await loadWithLocale(page, 'en');
    await expect(page.locator('.member-panel h2')).toHaveText('Members', { timeout: 15_000 });
    await expect(page.locator('.member-panel-eyebrow')).toHaveText('Community');
    const accessible = await page.evaluate(() => [...document.querySelectorAll('[aria-label], [data-tip]')]
      .flatMap((el) => [el.getAttribute('aria-label'), el.getAttribute('data-tip')])
      .filter((v): v is string => !!v && /[çğışöüÇŞĞİÖÜ]/.test(v)));
    expect({ turkishAccessibleNames: accessible }).toEqual({ turkishAccessibleNames: [] });
  });

  // ── KALDIRILAN TEST VE NEDENI ────────────────────────────────────────────
  // Burada "Ingilizce modda goc edilmis yuzeyler Turkce kalmiyor" diye bir
  // test vardi. IKI kez yanlis davrandi:
  //
  //   1. Ilk hali paketlenmis uygulamadan modul ice aktarmaya calisiyordu;
  //      import her zaman basarisiz oluyor, iddia HIC CALISMIYOR ve test BOS
  //      bir yesil uretiyordu.
  //   2. DOM tabanli ikinci hali ise, aradigi metinlerin o oturumda ekranda
  //      OLUP OLMADIGINA bagliydi. Fikstur kullanicisinin sunuculari oldugu
  //      icin bos-durum ekrani hic render edilmiyor; "Turkce degil" iddiasi
  //      YANLIS SEBEPLE geciyordu. Karsi kontrol bunu yakaladi.
  //
  // Hangi yuzeyin ekranda oldugu tesadufi oldugu icin bu test ya bos yesil ya
  // da kirilgan kirmizi uretiyor. Gercek kanit zaten baska yerde ve daha
  // saglam bicimde var:
  //   • Tablo kalitesi/paritesi  → client/tests/i18n-locale-parity.test.ts
  //   • DOM'un gercekten yenilenmesi → asagidaki CANLI DEGISIM testi
  //     (gercek tarayici, gercek ayarlar arayuzu)

  test('HAM ANAHTAR sızıntısı yok (her iki dilde)', async ({ page }) => {
    // En görünür i18n hatası budur: kullanıcıya `msg_edited` gibi ham bir
    // anahtar gösterilmesi. Çeviri eksikse Türkçe yedek görünmelidir.
    for (const loc of ['tr', 'en'] as const) {
      await loadWithLocale(page, loc);
      const text = await page.evaluate(() => document.body.innerText);
      // `snake_case` görünümlü, boşluksuz uzun belirteçler şüphelidir.
      const leaked = text.match(/\b(msg|gdm|start|vc)_[a-z_]{3,}\b/g) ?? [];
      expect({ loc, leaked }).toEqual({ loc, leaked: [] });
    }
  });

  test('CANLI DEĞİŞİM: GERÇEK arayüzden dil değişir (yenileme yok)', async ({ page }) => {
    // ASIL GERİLEME TESTİ. Kusur tam olarak buradaydı: dil değişiyordu ama
    // ekranda duran Svelte bileşenleri eski dilde kalıyordu.
    //
    // Modül içe aktarma İLE DEĞİL, kullanıcının gerçekten yaptığı şeyle
    // sürülür: Ayarlar → Görünüm → dil seçici. Uygulama paketlenmiş olarak
    // sunulduğu için içe aktarılabilir bir modül yolu YOKTUR; ayrıca gerçek
    // yolculuk zaten budur.
    await loadWithLocale(page, 'tr');

    // Oturum fikstürden gelir; ayarlar düğmesi görünür olmalı.
    const settingsBtn = page.locator('#btn-settings, [data-bridge-action="openSettingsModal"]').first();
    await settingsBtn.waitFor({ state: 'visible', timeout: 20_000 });
    await settingsBtn.click();

    // Görünüm sekmesine geç. Sekmeler role="tab" ve kararlı `#tab-<id>`
    // kimliği taşır (settings/SettingsModal.svelte) — üretilmiş sınıf adına
    // ya da çeviriye bağlı etikete DEĞİL, o kimliğe bağlanılır.
    const appearanceTab = page.locator('#tab-appearance');
    await appearanceTab.waitFor({ state: 'visible', timeout: 20_000 });
    await appearanceTab.click();

    const select = page.locator('#locale-select');
    await select.waitFor({ state: 'visible', timeout: 20_000 });

    await select.selectOption('en');

    // 1) Ürün dili gerçekten değişti.
    await expect(page.locator('html')).toHaveAttribute('lang', 'en', { timeout: 15_000 });

    // 2) VE ekrandaki metin yenilendi — sayfa YENİLENMEDEN.
    //    Seçicinin kendi etiketleri dahil, çevrilmiş bir yüzey İngilizce olmalı.
    await expect
      .poll(async () => {
        const txt = await page.evaluate(() => document.body.innerText);
        // Türkçe'ye özgü karakter yoğunluğu belirgin biçimde düşmeli.
        return (txt.match(/[çğışŞĞİ]/g) ?? []).length;
      }, { timeout: 15_000 })
      .toBeLessThan(40);

    // 3) KESİN ölçü (Final21 Faz 19): AYARLARDAN ÖNCE, açılışta monte edilmiş bir bileşen de
    //    değişmeli. "40'tan az Türkçe harf" eşiği, üretim paketinde `t()` reaktif değilken de
    //    geçiyordu (değişen yalnızca yeni monte edilen ayarlar penceresiydi).
    await expect(page.locator('.member-panel h2')).toHaveText('Members', { timeout: 15_000 });
  });
});
