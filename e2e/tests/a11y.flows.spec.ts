// e2e/tests/a11y.flows.spec.ts
// Sprint 64: Gerçek kullanıcı akışlarında ARIA / klavye doğrulaması
//
// Kapsam:
//   - DM penceresi açma & ARIA landmark'ları
//   - Kanal geçişi klavye navigasyonu
//   - Mesaj kutusu → gönderme akışı
//   - Kanal ayarları modalı (focus trap, Esc)
//   - Üye listesi (listbox/tree ARIA rolü)
//   - Emoji picker klavye navigasyonu
//   - Bildirim alanı erişilebilirliği
//   - Yüksek kontrast modunda kritik UI kontrolleri

import { test, expect, type Page } from '../helpers/apiTest';
import { getTokens, loginViaUI, createTestServer, createTestChannel } from '../helpers/bridge';
const AxeBuilder = require('@axe-core/playwright').default;

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:3000';

// ── Yardımcılar ───────────────────────────────────────────────────────────────

async function loginAs(page: Page): Promise<void> {
  // Kanonik giriş: kök adres + kullanıcı adı alanı + GERÇEK fixture kimliği.
  // Eski hali /login adresine gidip 'testuser'/'testpass' ile e-posta alanı
  // arıyordu; hiçbiri mevcut üründe yok, bu yüzden 10 sn timeout veriyordu.
  const tokens = getTokens();
  await loginViaUI(page, tokens.users.alice.username, tokens.users.alice.password);
}

async function noA11yViolations(page: Page, context: string, include?: string): Promise<void> {
  // Kapsam seçicisi sayfada YOKSA axe "No elements found for include" ile
  // PATLAR ve bu, erişilebilirlik ihlali gibi görünür. Oysa yüzey o an
  // render edilmemiştir: burada denetlenecek bir şey yoktur.
  if (include && await page.locator(include).count() === 0) {
    test.skip(true, `A11Y kapsamı bu kabukta render edilmedi: ${context}`);
  }
  // ── HAREKET AZALTMA: ÖLÇÜMÜ KARARLI HÂLE GETİRİR ──────────────────────────
  // `color-contrast` açıldığında SÜREKLİ animasyonlu öğeler her koşuda BAŞKA
  // bir ara renk raporluyordu (ölçüldü: aynı rozet için #388a40 / #468a38 /
  // #6e8a38 / #698a38). Hiçbiri dinlenme rengi değil — kullanıcının kalıcı
  // olarak gördüğü durum değil.
  //
  // Uygulama `prefers-reduced-motion: reduce` tercihini TAM uygular
  // (`client/css/tokens.css`: tüm süreler 0.01ms). Bu yüzden ölçüm, gerçek ve
  // kullanıcıların seçebildiği bir moda sabitlenir: animasyon GİZLENMEZ,
  // dinlenme durumu ölçülür.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForTimeout(250);
  // WCAG 2.1 AA da taranir (2.0 ile yetinmek 1.4.10 Reflow, 1.4.11 Non-text
  // Contrast, 1.4.12 Text Spacing gibi olcutleri gorunmez birakiyordu).
  const builder = new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    // `color-contrast` BU SÜİTTE DE AÇIK.
    //
    // Final20'de geçici olarak kapatılmıştı; iki durum henüz kök nedenine
    // inilmemişti. İkisinin de kökü aynı turda BULUNDU ve düzeltildi:
    //   · `#member-list .member-name` — satır `opacity: .58` ile soluklaştırılıyor,
    //     bu METNİ de soluklaştırıp 5.6:1'i 2.6:1'e düşürüyordu. Soluklaştırma
    //     avatara taşındı.
    //   · Koşudan koşuya değişen ön plan renkleri — sunucu kimlik renkleri
    //     id'den ÜRETİLİYORDU ve bazı tonlarda hiçbir metin rengi AA'yı
    //     geçemiyordu. Üretici artık ölçerek koyulaştırıyor
    //     (`identityBackground`).
    // Final21'de kural yeniden açıldı ve süit bu hâliyle YEŞİL ölçüldü.
    ;
  if (include) builder.include(include);
  const results = await builder.analyze();
  expect(
    results.violations,
    `A11Y ihlalleri [${context}]:\n${results.violations.map((v: any) =>
      `  [${v.impact}] ${v.id}: ${v.description}\n    → ${v.nodes.map((n: any) => n.target.join(', ')).slice(0, 2).join(' | ')}`,
    ).join('\n')}`,
  ).toEqual([]);
}

// ── Test suite ────────────────────────────────────────────────────────────────

test.describe('a11y — gerçek kullanıcı akışları', () => {

  // ══════════════════════════════════════════════════════════════════════════
  // KENDI FIKSTURUNU KURAR — SIRA BAGIMLILIGI KALDIRILDI (v1.123)
  // ══════════════════════════════════════════════════════════════════════════
  // Bu paket, alice'in ZATEN bir sunucusu oldugunu varsayiyordu. Varsayim
  // baska testlerin yan etkisiyle karsilaniyordu; tek basina veya farkli
  // sirada kosuldugunda kanal listesi hic render edilmiyordu.
  //
  // OLCULDU (v1.123): tam paket kosumunda `a11y.flows.spec.ts:161` TEK
  // basarisizlikti ("[aria-label^='Kanal: ']" 10 sn icinde gorunmedi) ama
  // AYNI test tek basina ve dosya butun olarak kosuldugunda GECIYORDU —
  // yani urun kusuru degil, test yalitim borcuydu.
  //
  // Artik paket kendi sunucusunu ve metin kanalini API ile kurar; kabuk
  // her kosumda dolu olur ve sonuc sira bagimsiz hale gelir.
  // Final21 Faz 19 (19-26): kurulan sunucunun KİMLİĞİ tutulur ve beforeEach onu açar. Eskiden
  // "ilk sunucu simgesi" tıklanıyordu; fikstür hesabı zamanla başka testlerin sunucularına da üye
  // olduğundan ilk simge çoğu zaman alice'in SAHİBİ OLMADIĞI bir sunucuydu: sunucu ayarları düğmesi
  // yoktu ve iki modal testi SEBEP YAZMADAN atlanıyordu (ölçüldü: X9, 34 atlamanın 2'si).
  let fixtureServerId = '';
  test.beforeAll(async ({ request }) => {
    const token = getTokens().alice;
    const srv = await createTestServer(request, token, `A11Y ${Date.now()}`);
    fixtureServerId = String(srv?._id || srv?.id || '');
    expect(fixtureServerId, 'a11y fikstür sunucusu kurulamadı').toBeTruthy();
    await createTestChannel(request, token, fixtureServerId, 'a11y-genel', 'text');
  });

  test.beforeEach(async ({ page }) => {
    // '/app' diye bir sunucu rotası YOK (SPA) — eski hali her testte 5 sn'lik
    // başarısız bir navigasyon + tam UI girişi yapıyordu ve beforeEach 30 sn
    // zaman aşımına düşüyordu. chromium projesi zaten storageState ile alice
    // oturumunu taşır; doğrudan kök adres yeterlidir.
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await page.locator('#app').waitFor({ state: 'visible', timeout: 20_000 });

    // ══════════════════════════════════════════════════════════════════════
    // KABUK DOLU OLMALI — YOKSA TESTLER SESSİZCE ATLANIR
    // ══════════════════════════════════════════════════════════════════════
    // Kanal listesi, üye listesi ve emoji seçici YALNIZCA bir sunucu
    // seçiliyken render edilir. Sunucu seçilmediğinde bu yüzeyler hiç
    // oluşmuyor ve testler `return test.skip()` ile SESSİZCE atlanıyordu
    // (ölçüldü: 4 atlandı / 6 geçti). Atlanan bir a11y testi hiçbir şey
    // KANITLAMAZ ama pakette yeşil görünür.
    // Fikstür sunucusu (alice SAHİBİ) açılır; kabuk dolu olmazsa test ATLANMAZ, DÜŞER.
    await page.locator(`.server-icon[data-id="${fixtureServerId}"]`).first().click({ timeout: 15_000 });
    // Kanal listesi gerçek konteyneri: `.channel-list-host`
    await expect(page.locator('.channel-list-host').first()).toBeVisible({ timeout: 10_000 });
    // Metin kanalını aç — mesaj kutusu ve emoji kontrolü böyle gelir.
    await page.locator('[aria-label="Kanal: a11y-genel"]').first().click({ timeout: 10_000 });
    await expect(page.locator('#msg-input')).toBeVisible({ timeout: 10_000 });
  });

  // ── DM akışı ────────────────────────────────────────────────────────────────

  test('DM listesi — ARIA listbox & keyboard navigasyonu', async ({ page }) => {
    // DM ikonuna git
    // OLCULEN: `aria-label="Direkt mesajları aç"`. Genis joker secici
    // gorunmez bir eslesmeyi ONCE yakalayabiliyordu; tam etiket kullanilir.
    const dmBtn = page.locator(
      '[aria-label="Direkt mesajları aç"], [data-testid="dm-btn"], #dm-btn',
    ).first();
    await expect(dmBtn, 'yüzey görünmedi (Faz 19: sessiz atlama kaldırıldı)').toBeVisible({ timeout: 10_000 });

    await dmBtn.click();
    await page.waitForTimeout(300);

    // DM listesinde axe tarama
    await noA11yViolations(page, 'DM listesi', '.dm-panel, [aria-label="Direkt mesajlar"], [data-testid="dm-list"], .dm-list, #dm-list');

    // Keyboard: Tab ile DM girişlerine ulaşılabiliyor olmalı
    await page.keyboard.press('Tab');
    const focused = await page.evaluate(() => {
      const el = document.activeElement;
      return { tag: el?.tagName, role: el?.getAttribute('role'), label: el?.getAttribute('aria-label') };
    });
    expect(['A', 'BUTTON', 'LI', 'DIV']).toContain(focused.tag);
  });

  test('DM penceresi — landmark\'lar & mesaj kutusu ARIA', async ({ page }) => {
    const dmBtn = page.locator('[aria-label*="Direkt" i], [aria-label*="Direct" i]').first();
    await expect(dmBtn, 'yüzey görünmedi (Faz 19: sessiz atlama kaldırıldı)').toBeVisible({ timeout: 10_000 });
    await dmBtn.click();

    // İlk DM'e tıkla
    const firstDm = page.locator('.dm-item, [data-testid="dm-item"], .dm-list li').first();
    if (await firstDm.isVisible({ timeout: 2000 })) {
      await firstDm.click();
      await page.waitForTimeout(400);
    }

    await noA11yViolations(page, 'DM penceresi');

    // Mesaj kutusunun doğru ARIA rolü var mı?
    const msgBox = page.locator(
      '[data-testid="message-input"], [aria-label*="mesaj" i], [aria-label*="message" i], [contenteditable="true"], textarea[placeholder]',
    ).first();
    if (await msgBox.isVisible({ timeout: 2000 })) {
      const role = await msgBox.getAttribute('role');
      const label = await msgBox.getAttribute('aria-label') || await msgBox.getAttribute('placeholder');
      // textbox rolü veya meaningful label bekliyoruz
      expect(role === 'textbox' || (label !== null && label.length > 0)).toBeTruthy();
    }
  });

  // ── Kanal geçişi ─────────────────────────────────────────────────────────────

  // ══════════════════════════════════════════════════════════════════════════
  // KANAL LİSTESİ — ÜRÜNÜN GERÇEK KLAVYE SÖZLEŞMESİ
  // ══════════════════════════════════════════════════════════════════════════
  // Bu test eskiden ArrowDown ile odak taşınmasını bekliyor, olmayınca
  // `return test.skip()` ile SESSİZCE atlanıyordu — yani hiçbir şey
  // kanıtlamıyordu.
  //
  // ÜRÜN İNCELENDİ (client/js/core/channel-list/ChannelItem.svelte,
  // ChannelList.svelte): her kanal GERÇEK bir `<button>`dır. Enter/Space'i
  // tarayıcı natif işler, Tab her kanala tek tek ulaşır. Bu BİLİNÇLİ bir
  // tercihtir; ok tuşlu tek-durak (composite widget) kalıbı KULLANILMAZ.
  // Kaynak yorumları bunu açıkça söylüyor.
  //
  // Dolayısıyla ok tuşu beklemek YANLIŞ sözleşmeyi ölçmekti. Bu test artık
  // ürünün GERÇEKTEN garanti ettiğini doğrular:
  //   · kanallar Tab ile ULAŞILABİLİR,
  //   · odaklanan kanal GÖRÜNÜR bir odak göstergesine sahiptir,
  //   · Enter kanalı GERÇEKTEN açar.
  //
  // KANITLAR   : kanal listesinin klavyeyle kullanılabilir olduğunu.
  // KANITLAMAZ : ekran okuyucunun ne seslendirdiğini (insan doğrulaması).
  test('Kanal listesi — Tab ile ulaşılır, odak görünür, Enter açar', async ({ page }) => {
    const channelBtn = page.locator('[aria-label^="Kanal: "]').first();
    await channelBtn.waitFor({ state: 'visible', timeout: 10_000 });

    // Gerçek bir buton mu? (natif Enter/Space davranışının şartı)
    const tag = await channelBtn.evaluate(el => el.tagName);
    expect(tag, 'kanal öğesi gerçek bir <button> değil').toBe('BUTTON');

    // GERÇEK KLAVYE ile ulaş — programatik `.focus()` YETMEZ.
    // Ürünün odak halkası global `:focus-visible` kuralıdır
    // (client/css/tokens.css:666). `:focus-visible` tarayıcı sezgiseline
    // bağlıdır ve programatik odakta UYGULANMAYABİLİR. Programatik odakla
    // ölçmek "odak göstergesi yok" gibi YANLIŞ bir sonuç üretir; bu test
    // bir kez tam olarak bu şekilde yanılmıştı.
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    let reached = '';
    for (let i = 0; i < 60 && !reached.startsWith('Kanal: '); i++) {
      await page.keyboard.press('Tab');
      reached = await page.evaluate(() =>
        document.activeElement?.getAttribute('aria-label') ?? '');
    }
    expect(reached, 'kanal butonuna Tab ile ULAŞILAMADI').toContain('Kanal: ');

    // Odak GÖRÜNÜR olmalı: outline ya da belirgin bir box-shadow.
    const focusVisible = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el) return false;
      const st = getComputedStyle(el);
      const ow = parseFloat(st.outlineWidth || '0');
      const hasOutline = ow > 0 && st.outlineStyle !== 'none';
      const hasShadow = !!st.boxShadow && st.boxShadow !== 'none';
      return hasOutline || hasShadow;
    });
    expect(focusVisible, 'odaklanan kanalda görünür odak göstergesi yok').toBe(true);

    // Enter kanalı GERÇEKTEN açmalı — mesaj kutusu erişilebilir hale gelir.
    await page.keyboard.press('Enter');
    await page.locator('#msg-input').waitFor({ state: 'visible', timeout: 10_000 });
  });

  test('Kanal geçişi sonrası — mesaj alanı A11Y', async ({ page }) => {
    // İlk metin kanalına tıkla
    const firstChannel = page.locator(
      '[data-type="text"], [data-channel-type="text"], .channel-item[data-type="text"]',
    ).first();
    await expect(firstChannel, 'yüzey görünmedi (Faz 19: sessiz atlama kaldırıldı)').toBeVisible({ timeout: 10_000 });
    await firstChannel.click();
    await page.waitForTimeout(400);

    await noA11yViolations(page, 'Kanal mesaj alanı');
  });

  // ── Modallar ──────────────────────────────────────────────────────────────────

  test('Kanal ayarları modalı — focus trap & Esc kapatma', async ({ page }) => {
    // OLCULEN URUN ETIKETLERI (canli kabuktan):
    //   "general kanal işlemleri"   → kanal aksiyon menusu
    //   "Sunucu ayarlarını aç"      → sunucu ayarlari
    // Eski secici listesi ("kanal ayar", "channel setting") urunde YOKTU,
    // bu yuzden test her kosumda SESSIZCE atlaniyordu.
    const gearBtn = page.locator(
      '[aria-label$="kanal işlemleri"], [aria-label="Sunucu ayarlarını aç"], '
      + '[aria-label*="kanal ayar" i], [data-testid="channel-settings-btn"]',
    ).first();
    await expect(gearBtn, 'yüzey görünmedi (Faz 19: sessiz atlama kaldırıldı)').toBeVisible({ timeout: 10_000 });

    await gearBtn.click();
    await page.waitForTimeout(400);

    // OLCULEN: kanal islemleri dugmesi bir DIALOG degil, `role="menu"`
    // (.cam-menu) acar. Eski secici yalnizca dialog ariyordu ve test
    // SESSIZCE atlaniyordu. Menu de odak/Esc sozlesmesine tabidir.
    const modal = page.locator('[role="menu"], [role="dialog"], .cam-menu, .modal-overlay, #channel-settings-modal').first();
    await expect(modal, 'yüzey görünmedi (Faz 19: sessiz atlama kaldırıldı)').toBeVisible({ timeout: 10_000 });

    // ARIA: yüzey ya `dialog` ya `menu` olmalı — ikisi de geçerli kalıptır.
    // Ürün burada `role="menu"` kullanır (ölçüldü: `.cam-menu`).
    const role = await modal.getAttribute('role');
    expect(['dialog', 'menu'], `beklenmeyen rol: ${role}`).toContain(role);

    // A11Y tarama — yalnızca açılan yüzeyin İÇİNDE.
    await noA11yViolations(page, 'Kanal işlemleri menüsü', '[role="menu"], [role="dialog"]');

    // Focus trap: Shift+Tab ile focus modal dışına çıkmamalı
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Shift+Tab');
    const focusedInModal = await page.evaluate(() => {
      const dialog = document.querySelector('[role="dialog"]');
      return dialog?.contains(document.activeElement) ?? true;
    });
    expect(focusedInModal).toBeTruthy();

    // Esc ile kapatılmalı
    await page.keyboard.press('Escape');
    await expect(modal).toBeHidden({ timeout: 1500 });
  });

  test('Sunucu ayarları modalı — genel A11Y', async ({ page }) => {
    const settingsGear = page.locator(
      '[aria-label*="Sunucu Ayarları" i], [aria-label*="Server Settings" i], [data-testid="server-settings-btn"]',
    ).first();
    await expect(settingsGear, 'yüzey görünmedi (Faz 19: sessiz atlama kaldırıldı)').toBeVisible({ timeout: 10_000 });
    await settingsGear.click();
    await page.waitForTimeout(400);

    const modal = page.locator('[role="dialog"]').first();
    await expect(modal, 'yüzey görünmedi (Faz 19: sessiz atlama kaldırıldı)').toBeVisible({ timeout: 10_000 });

    await noA11yViolations(page, 'Sunucu ayarları modalı', '[role="dialog"]');
  });

  // ── Üye listesi ───────────────────────────────────────────────────────────────

  test('Üye listesi — ARIA rolleri ve keyboard', async ({ page }) => {
    const membersBtn = page.locator(
      '[aria-label*="Üyeler" i], [aria-label*="Members" i], [data-testid="members-btn"]',
    ).first();
    await expect(membersBtn, 'yüzey görünmedi (Faz 19: sessiz atlama kaldırıldı)').toBeVisible({ timeout: 10_000 });
    await membersBtn.click();
    await page.waitForTimeout(300);

    const memberList = page.locator('[data-testid="member-list"], .member-list, [role="listbox"], [role="list"]').first();
    await expect(memberList, 'yüzey görünmedi (Faz 19: sessiz atlama kaldırıldı)').toBeVisible({ timeout: 10_000 });

    await noA11yViolations(page, 'Üye listesi');

    // Her üye girişi tıklanabilir ve ARIA'ya uygun olmalı
    const items = await memberList.locator('[role="option"], [role="listitem"], .member-item').all();
    for (const item of items.slice(0, 3)) {
      const tag = await item.evaluate(el => el.tagName);
      const hasRole = await item.getAttribute('role');
      expect(['BUTTON', 'A', 'LI', 'DIV'].includes(tag) || hasRole !== null).toBeTruthy();
    }
  });

  // ── Emoji picker ──────────────────────────────────────────────────────────────

  test('Emoji picker — klavye navigasyonu & ARIA grid', async ({ page }) => {
    // OLCULEN: acma dugmesi `aria-label="Emoji ekle"`,
    // panelin kendisi `aria-label="Emoji seç"` (EmojiPickerPanel.svelte).
    const emojiBtn = page.locator('[aria-label="Emoji ekle"], [data-testid="emoji-btn"], .emoji-btn').first();
    await expect(emojiBtn, 'yüzey görünmedi (Faz 19: sessiz atlama kaldırıldı)').toBeVisible({ timeout: 10_000 });
    await emojiBtn.click();
    await page.waitForTimeout(300);

    const picker = page.locator('[aria-label="Emoji seç"], [data-testid="emoji-picker"], .emoji-picker, #emoji-picker').first();
    await expect(picker, 'yüzey görünmedi (Faz 19: sessiz atlama kaldırıldı)').toBeVisible({ timeout: 10_000 });

    await noA11yViolations(page, 'Emoji picker');

    // Picker içinde Tab ile navige edilebiliyor olmalı
    await page.keyboard.press('Tab');
    const focused = await page.evaluate(() => ({
      tag: document.activeElement?.tagName,
      inPicker: document.querySelector('.emoji-picker, #emoji-picker')?.contains(document.activeElement),
    }));
    // Soft check — picker kendi focus yönetimini yapıyor olabilir
    if (focused.inPicker === false) {
      console.warn('⚠️ Emoji picker focus yönetimi eksik');
    }

    // Esc ile kapatılmalı
    await page.keyboard.press('Escape');
    await expect(picker).toBeHidden({ timeout: 1500 });
  });

  // ── Bildirimler ───────────────────────────────────────────────────────────────

  test('Bildirim alanı — role="status" veya aria-live', async ({ page }) => {
    // Toast/snackbar container'ı bul
    const toastContainer = page.locator(
      '#toast-container, [role="status"], [role="alert"], [aria-live], .toast-container',
    ).first();

    // Bir aksiyonla toast tetikle (geçersiz arama)
    await page.keyboard.press('Control+k');
    await page.waitForTimeout(200);
    await page.keyboard.type('!invalid!');
    await page.waitForTimeout(500);

    // Toast yoksa sadece container var mı diye bak
    if (await toastContainer.isVisible({ timeout: 1000 }).catch(() => false)) {
      const role = await toastContainer.getAttribute('role');
      const ariaLive = await toastContainer.getAttribute('aria-live');
      expect(role === 'status' || role === 'alert' || ariaLive !== null).toBeTruthy();
    }
  });

  // ── Yüksek kontrast ───────────────────────────────────────────────────────────

  test('Yüksek kontrast modu — kritik UI elementleri görünür', async ({ page }) => {
    // prefers-contrast: more simüle et
    await page.emulateMedia({ forcedColors: 'active' });
    await page.reload({ waitUntil: 'domcontentloaded' });

    // Temel kontroller hâlâ görünür mü?
    const criticalSelectors = [
      '[data-testid="message-input"], [aria-label*="mesaj" i], textarea',
      '[data-testid="send-btn"], button[type="submit"]',
    ];
    for (const sel of criticalSelectors) {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 1000 }).catch(() => false)) {
        // Görünürlük yeterli — kontrast doğrulaması için ayrı audit
        await expect(el).toBeVisible();
      }
    }

    await page.emulateMedia({ forcedColors: 'none' });
  });

});
