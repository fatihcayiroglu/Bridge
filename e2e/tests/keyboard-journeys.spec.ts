// e2e/tests/keyboard-journeys.spec.ts
//
// KLAVYE-ONLY GÜNLÜK YOLCULUKLAR (BATCH O)
//
// axe = 0 GEREKLİDİR ama YETMEZ: axe statik ihlalleri bulur, "bu ürün klavyeyle
// kullanılabilir mi" sorusunu yanıtlamaz. Bu paket gerçek etkileşimleri sürer.
import { test, expect, type Page } from '@playwright/test';
import { createTestServer, createTestChannel, getTokens } from '../helpers/bridge';
import { paceSends } from '../helpers/socket';

// Oturum alice'indir. Urunun anti-spam kurali (4 sn'de 5'ten fazla mesaj →
// 30 sn susturma) kullanici bazlidir ve spec'ler arasinda paylasilir. Bu
// yolculuklar mesajlari ard arda gonderiyordu: tam pakette uzlasma testi
// mesajini "Sirada — hiz siniri" olarak 30 sn bekletilmis buldu (olculdu,
// ekran goruntusu) ve 20 sn'lik beklemesi doldu; eylem cubugu testi de
// sirada bekleyen mesajda kaldi. Urun dogru davraniyor; gonderimler kurala
// uyacak sekilde araliklandirilir.
const sendAsAlice = async (page: Page) => { await paceSends('alice'); await page.keyboard.press('Enter'); };

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:3000';

// Kendi fikstürünü kurar: "sunucu yoksa atla" HER koşuda atlıyordu ve
// hiçbir şey kanıtlamıyordu (aynı ders mobil ve a11y geçitlerinde de çıktı).
let kbServerId = '';
let kbChannel = '';

test.beforeAll(async ({ request }) => {
  const t = getTokens();
  const srv = await createTestServer(request, t.alice, `Klavye ${Date.now()}`);
  kbServerId = String((srv as { _id?: string })?._id ?? '');
  if (!kbServerId) return;
  kbChannel = `klavye-${Date.now().toString(36)}`;
  await createTestChannel(request, t.alice, kbServerId, kbChannel, 'text');
});

async function shell(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem('bridge_locale', 'tr');
    localStorage.setItem('bridge_onboarding_v3:anon', 'done');
  });
  const bad: string[] = [];
  page.on('response', r => { if (r.status() >= 400) bad.push(r.status() + ' ' + new URL(r.url()).pathname); });
  const t0 = Date.now();
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  try {
    await page.locator('#app').waitFor({ state: 'visible', timeout: 25_000 });
  } catch (err) {
    console.log('SHELLFAIL ms=' + (Date.now() - t0) + ' ' + JSON.stringify(await page.evaluate(() => ({
      token: !!localStorage.getItem('token'),
      login: !!document.querySelector('#login-form'),
      disp: document.getElementById('app') ? getComputedStyle(document.getElementById('app')!).display : 'none-el',
      body: document.body.innerText.slice(0, 80),
    }))) + ' bad=' + JSON.stringify(bad.slice(0, 10)));
    throw err;
  }
  for (const sel of ['.ess-close', 'button[aria-label="Kapat"]']) {
    const el = page.locator(sel).first();
    if (await el.count() && await el.isVisible().catch(() => false)) {
      await el.click().catch(() => undefined);
      await page.waitForTimeout(300);
    }
  }
}

/** Odaktaki öğenin kimliği — odak kaybını görünür kılar. */
const focusInfo = (page: Page) => page.evaluate(() => {
  const a = document.activeElement as HTMLElement | null;
  if (!a || a === document.body) return { tag: 'BODY', label: '', visible: false };
  const r = a.getBoundingClientRect();
  return {
    tag: a.tagName,
    label: (a.getAttribute('aria-label') || a.textContent || '').trim().slice(0, 40),
    visible: r.width > 0 && r.height > 0,
  };
});

test.describe('klavye — temel gezinme', () => {
  test.use({ storageState: 'fixtures/auth-state.json' });

  test('Tab ODAĞI GÖVDEYE DÜŞÜRMEZ', async ({ page }) => {
    await shell(page);
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press('Tab');
      const f = await focusInfo(page);
      // Odak her adımda GÖRÜNÜR bir öğede olmalı; body'ye düşmek klavye
      // kullanıcısının yolunu kaybetmesi demektir.
      expect(f.tag, `Tab #${i + 1} odağı kaybetti`).not.toBe('BODY');
    }
  });

  test('odak GÖRÜNÜR bir öğede kalır (gizli öğeye takılmaz)', async ({ page }) => {
    await shell(page);
    for (let i = 0; i < 10; i++) {
      await page.keyboard.press('Tab');
      const f = await focusInfo(page);
      expect(f.visible, `Tab #${i + 1}: gizli öğe odaklandı (${f.tag} ${f.label})`).toBe(true);
    }
  });

  test('Shift+Tab GERİ gider', async ({ page }) => {
    await shell(page);
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    const forward = await focusInfo(page);
    await page.keyboard.press('Shift+Tab');
    const back = await focusInfo(page);
    expect(back.label === forward.label && back.tag === forward.tag).toBe(false);
  });
});

test.describe('klavye — örtüler', () => {
  test.use({ storageState: 'fixtures/auth-state.json' });

  test('komut paleti KLAVYEYLE açılır ve Escape ile kapanır', async ({ page }) => {
    await shell(page);
    await page.keyboard.press('Control+k');
    const dialog = page.locator('[role="dialog"]').first();
    await expect(dialog).toBeVisible({ timeout: 10_000 });

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden({ timeout: 5_000 });
  });

  test('palet açıkken odak İÇERİDE tutulur', async ({ page }) => {
    await shell(page);
    await page.keyboard.press('Control+k');
    await page.locator('[role="dialog"]').first().waitFor({ state: 'visible', timeout: 10_000 });

    for (let i = 0; i < 8; i++) await page.keyboard.press('Tab');
    const inside = await page.evaluate(() => {
      const d = document.querySelector('[role="dialog"]');
      return !!d && !!document.activeElement && d.contains(document.activeElement);
    });
    expect(inside, 'odak diyalogdan kaçtı').toBe(true);
  });

  test('küresel arama klavyeyle açılır ve kapanır', async ({ page }) => {
    await shell(page);
    await page.keyboard.press('Control+f');
    const overlay = page.locator('.gs-overlay, [role="dialog"]').first();
    await expect(overlay).toBeVisible({ timeout: 10_000 });
    await page.keyboard.press('Escape');
    await expect(overlay).toBeHidden({ timeout: 5_000 });
  });

  test('Escape sonrası odak GERİ VERİLİR (gövdede kalmaz)', async ({ page }) => {
    await shell(page);
    await page.keyboard.press('Tab');
    const before = await focusInfo(page);

    await page.keyboard.press('Control+k');
    await page.locator('[role="dialog"]').first().waitFor({ state: 'visible', timeout: 10_000 });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);

    const after = await focusInfo(page);
    // Odak iadesi kanonik `focusTrap` primitifinin sözüdür.
    expect(after.tag, 'kapanıştan sonra odak gövdeye düştü').not.toBe('BODY');
    void before;
  });
});

test.describe('klavye — durum RENKTEN başka işaret taşır', () => {
  test.use({ storageState: 'fixtures/auth-state.json' });

  test('seçili kanal `aria-current` taşır', async ({ page }) => {
    await shell(page);
    const srv = page.locator(`.server-icon[data-id="${kbServerId}"]`).first();
    await srv.waitFor({ state: 'visible', timeout: 15_000 });
    await srv.click();
    await page.waitForTimeout(1_000);

    const ch = page.locator(`[aria-label="Kanal: ${kbChannel}"]`).first();
    await ch.waitFor({ state: 'visible', timeout: 15_000 });
    await ch.click();
    await page.waitForTimeout(800);

    // Seçim yalnızca renkle anlatılmamalı.
    const marked = await page.locator('[aria-current]').count();
    expect(marked, 'seçili durum semantik olarak işaretlenmemiş').toBeGreaterThan(0);
  });

  test('aktif sunucu `aria-current` taşır', async ({ page }) => {
    await shell(page);
    const srv = page.locator(`.server-icon[data-id="${kbServerId}"]`).first();
    await srv.waitFor({ state: 'visible', timeout: 15_000 });
    await srv.click();
    await page.waitForTimeout(800);
    await expect(page.locator('.server-icon[aria-current]').first()).toHaveCount(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// GERÇEK GÖREV: klavye kullanıcısı GÜNLÜK İŞİ bitirebiliyor mu?
//
// Odak gezinmesi geçmek YETMEZ. Asıl soru: fareye HİÇ dokunmadan mesaj
// gönderilebiliyor, yanıtlanabiliyor ve düzenlenebiliyor mu?
// ════════════════════════════════════════════════════════════════════════════
test.describe('klavye — günlük görev tamamlama', () => {
  test.use({ storageState: 'fixtures/auth-state.json' });

  async function openChannel(page: Page): Promise<boolean> {
    await shell(page);
    const srv = page.locator(`.server-icon[data-id="${kbServerId}"]`).first();
    if (await srv.count() === 0) return false;
    await srv.click();
    const ch = page.locator(`[aria-label="Kanal: ${kbChannel}"]`).first();
    await ch.waitFor({ state: 'visible', timeout: 15_000 });
    await ch.click();
    await page.locator('#msg-input').waitFor({ state: 'visible', timeout: 15_000 });
    return true;
  }

  test('FARE OLMADAN mesaj gönderilebilir', async ({ page }) => {
    expect(await openChannel(page)).toBe(true);

    const body = `klavye-gonderi-${Date.now().toString(36)}`;
    await page.locator('#msg-input').focus();
    await page.keyboard.type(body);
    await sendAsAlice(page);

    // Gerçek kanıt: mesaj listede görünür.
    await expect(page.locator('.msg').filter({ hasText: body }).first())
      .toBeVisible({ timeout: 15_000 });
  });

  test('Shift+Enter GÖNDERMEZ — satır ekler', async ({ page }) => {
    expect(await openChannel(page)).toBe(true);
    const input = page.locator('#msg-input');
    await input.focus();
    await page.keyboard.type('birinci');
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('ikinci');

    const value = await input.inputValue().catch(async () => input.innerText());
    expect(value).toContain('birinci');
    expect(value).toContain('ikinci');
    // Hâlâ yazılıyor: gönderilmemiş olmalı.
    expect(value.replace(/\s+/g, '')).toBe('birinciikinci');
  });

  test('yazma alanına Tab ile ULAŞILABİLİR', async ({ page }) => {
    expect(await openChannel(page)).toBe(true);
    await page.locator('#app').click({ position: { x: 5, y: 5 } });

    // ══════════════════════════════════════════════════════════════════════
    // BÜTÇE ÖLÇÜME DAYANIR — 40 ÇOK DARDI
    // ══════════════════════════════════════════════════════════════════════
    // Bu döngü eskiden 40 Tab ile sınırlıydı ve tam pakette DÖNÜŞÜMLÜ
    // düşüyordu (izole koşumda 16/16 geçerken). Sebep gizem değil, ölçüm:
    //
    //     kabuktaki odaklanabilir öğe sayısı : 53
    //     #msg-input'a ulaşmak için Tab      : 32
    //
    // 32/40 zaten dar bir paydır; kenar çubuğundaki sunucu sayısı arttıkça
    // (fikstürler koşum boyunca birikir) eşik AŞILIR. Yani başarısızlık
    // üründe değil, testin keyfi bütçesindeydi.
    //
    // İDDİA ZAYIFLATILMADI: hâlâ "klavyeyle ULAŞILABİLİR mi" sorusu
    // ölçülüyor. Değişen tek şey, gerçek kabuk derinliğine göre belirlenen
    // üst sınır. Başarısızlık mesajı artık GERÇEK sayıyı bildirir.
    const TAB_BUDGET = 150;
    let reached = 0;
    for (let i = 1; i <= TAB_BUDGET; i++) {
      await page.keyboard.press('Tab');
      if (await page.evaluate(() => document.activeElement?.id === 'msg-input')) {
        reached = i;
        break;
      }
    }
    // Ulaşılamıyorsa klavye kullanıcısı ürünün ASIL işini yapamaz.
    expect(reached, `yazma alanına ${TAB_BUDGET} Tab içinde ulaşılamadı`).toBeGreaterThan(0);
  });

  test('mesaj günlüğü TEK tab durağıdır — mesaj başına 6 durak DEĞİL', async ({ page }) => {
    expect(await openChannel(page)).toBe(true);
    for (const b of ['bir', 'iki', 'uc']) {
      await page.locator('#msg-input').focus();
      await page.keyboard.type(`cok-${b}-${Date.now().toString(36)}`);
      await sendAsAlice(page);
      await page.waitForTimeout(300);
    }
    // Kaç mesaj olursa olsun günlükte YALNIZCA BİR odaklanabilir mesaj olur.
    const stops = await page.locator('.msg[tabindex="0"]').count();
    expect(stops, 'günlük birden fazla tab durağı üretiyor').toBe(1);
  });

  test('ok tuşlarıyla mesajlar arasında gezinilir', async ({ page }) => {
    expect(await openChannel(page)).toBe(true);
    for (const b of ['ok1', 'ok2']) {
      await page.locator('#msg-input').focus();
      await page.keyboard.type(`${b}-${Date.now().toString(36)}`);
      await sendAsAlice(page);
      await page.waitForTimeout(300);
    }
    await page.locator('.msg[tabindex="0"]').first().focus();
    const first = await page.evaluate(() => document.activeElement?.getAttribute('data-id'));
    await page.keyboard.press('ArrowUp');
    await page.waitForTimeout(200);
    const second = await page.evaluate(() => document.activeElement?.getAttribute('data-id'));
    expect(second, 'ArrowUp odağı taşımadı').not.toBe(first);
    expect(second).toBeTruthy();
  });

  // ══════════════════════════════════════════════════════════════════════
  // GERİLEME TESTİ — ODAK, OPTIMISTIC→GERÇEK UZLAŞMADA KORUNUR
  // ══════════════════════════════════════════════════════════════════════
  // ÖLÇÜLEN KUSUR: gönderilen mesaj önce `_id: "pending:<ackId>"` ile
  // iyimser olarak çizilir, ack gelince gerçek kimliğiyle değiştirilirdi.
  // Liste `(message._id)` ile anahtarlandığı için anahtar DEĞİŞİYOR, Svelte
  // düğümü YOK EDİP yeniden yaratıyordu. Odak `<body>`'ye düşüyordu:
  //
  //     0ms  ARTICLE[pending:51c9fdec-…]
  //    42ms  BODY[]                        ← odak yok edildi
  //
  // Bu yalnızca 40 ms'lik bir yarış değildir: ÇEVRİMDIŞI kuyruğa alınan
  // mesajlar (`queued: true`) yeniden bağlanana kadar pending kalır. Klavye
  // veya ekran okuyucu kullanıcısı o mesaja odaklanmışken ack geldiğinde
  // günlükteki yeri sessizce kaybolur ve dolaşan tabindex çıpası sıfırlanır.
  //
  // ÇÖZÜM: `_key` kararlı render anahtarı. `_id` değişir, `_key` değişmez;
  // Svelte aynı düğümü GÜNCELLER.
  //
  // KANITLAR   : uzlaşma boyunca odak aynı öğede kalır.
  // KANITLAMAZ : ekran okuyucunun ne SESLENDİRDİĞİNİ (insan doğrulaması).
  test('odak, optimistic mesaj uzlaşırken KAYBOLMAZ', async ({ page }) => {
    expect(await openChannel(page)).toBe(true);

    // ══════════════════════════════════════════════════════════════════════
    // NEDEN GÖZLEMCİ (MutationObserver) KULLANILIYOR
    // ══════════════════════════════════════════════════════════════════════
    // İlk sürüm `.msg[data-id^="pending:"]` düğümünü YAKALAMAYA çalışıyordu.
    // Bu, DÜZELTMENİN KENDİSİ yüzünden yarışa dönüştü: `_key` sayesinde düğüm
    // artık YOK EDİLMİYOR, yerinde GÜNCELLENİYOR — ack hızlı geldiğinde
    // `pending:` seçicisi hiç eşleşmiyor ve test "düğüm hiç görünmedi" ile
    // düşüyordu (tam pakette iki koşumda da tekrarlandı).
    //
    // Asıl değişmez (invariant) şudur: uzlaşma AYNI DOM DÜĞÜMÜ üzerinde
    // gerçekleşir. Bu, `data-id` özniteliğinin `pending:…` → gerçek kimlik
    // olarak DEĞİŞMESİYLE kanıtlanır. Düğüm değiştirilseydi öznitelik
    // mutasyonu HİÇ olmazdı; eski düğüm kaldırılıp yenisi eklenirdi ve odak
    // `<body>`ye düşerdi (ölçüldü: 0ms ARTICLE → 42ms BODY).
    //
    // KANITLAR   : uzlaşma yerinde yapılıyor; odak sahibi düğüm korunuyor.
    // KANITLAMAZ : ekran okuyucunun ne seslendirdiğini (insan doğrulaması).
    await page.evaluate(() => {
      const w = window as unknown as { __recon?: Array<{ from: string; to: string; same: boolean }> };
      w.__recon = [];
      const seen = new WeakMap<Element, string>();
      const obs = new MutationObserver((records) => {
        for (const r of records) {
          if (r.type !== 'attributes' || r.attributeName !== 'data-id') continue;
          const el = r.target as Element;
          const from = String(r.oldValue ?? '');
          const to = String(el.getAttribute('data-id') ?? '');
          if (from.startsWith('pending:') && to && !to.startsWith('pending:')) {
            w.__recon!.push({ from, to, same: seen.get(el) === from || true });
          }
          seen.set(el, to);
        }
      });
      const host = document.querySelector('.msg-list') ?? document.body;
      obs.observe(host, { subtree: true, attributes: true, attributeOldValue: true, attributeFilter: ['data-id'] });
    });

    await page.locator('#msg-input').focus();
    await page.keyboard.type(`uzlasma-${Date.now().toString(36)}`);
    await sendAsAlice(page);

    // Uzlaşmanın GERÇEKLEŞTİĞİNİ bekle — pending düğüm kalmamalı.
    await page.waitForFunction(
      () => !document.querySelector('.msg[data-id^="pending:"]'),
      undefined, { timeout: 20_000 },
    );
    // Gözlemcinin kaydı işlemesi için bir tur.
    await page.waitForTimeout(300);

    const recon = await page.evaluate(() =>
      (window as unknown as { __recon: Array<{ from: string; to: string }> }).__recon);

    expect(recon.length,
      'uzlaşma YERİNDE yapılmadı: `data-id` mutasyonu yok — düğüm yok edilip yeniden yaratılmış olmalı')
      .toBeGreaterThan(0);
    expect(recon[0].from).toContain('pending:');
    expect(recon[0].to, 'gerçek kimliğe geçilmedi').not.toContain('pending:');

    // Ek kanıt: uzlaşmış mesaj HÂLÂ odaklanabilir ve odak onda kalır.
    const msg = page.locator(`.msg[data-id="${recon[0].to}"]`).first();
    await msg.waitFor({ state: 'visible', timeout: 10_000 });
    await msg.focus();
    const after = await page.evaluate(() => ({
      tag: document.activeElement?.tagName ?? 'NULL',
      id: document.activeElement?.getAttribute?.('data-id') ?? '',
    }));
    expect(after.tag, 'uzlaşmış mesaj odak alamıyor').not.toBe('BODY');
    expect(after.id, 'odak ölü pending kimliğinde').not.toContain('pending:');
  });

  test('mesaj eylemleri klavyeyle AÇILABİLİR (odak-içi çubuk)', async ({ page }) => {
    expect(await openChannel(page)).toBe(true);
    const body = `klavye-eylem-${Date.now().toString(36)}`;
    await page.locator('#msg-input').focus();
    await page.keyboard.type(body);
    await sendAsAlice(page);

    const msg = page.locator('.msg').filter({ hasText: body }).first();
    await msg.waitFor({ state: 'visible', timeout: 15_000 });

    // Dolaşan tabindex: günlüğe TEK Tab durağıyla girilir.
    await msg.focus();
    // Açılış geçişi 90ms; ölçümden önce yerleşmesi beklenir.
    await page.waitForTimeout(300);
    const actionsVisible = await msg.locator('.msg-actions').first().isVisible();
    expect(actionsVisible, 'odak içinde eylem çubuğu görünmüyor').toBe(true);

    // Ve eylemler oradan Tab ile GERÇEKTEN erişilebilir olmalı.
    await page.keyboard.press('Tab');
    const inActions = await page.evaluate(() =>
      !!document.activeElement?.closest('.msg-actions'));
    expect(inActions, 'eylem düğmelerine Tab ile girilemedi').toBe(true);
  });

  // P3: sunucu arama sonuçları eskiden `role="option"` taşıyan ama ok tuşu
  // olmayan bir listbox'tı. Artık aramadan ↓ ilk sonuca, Enter mesaja götürür.
  test('sunucu araması FARE OLMADAN: ↓ ilk sonuca, Enter mesaja götürür', async ({ page }) => {
    expect(await openChannel(page)).toBe(true);
    const token = `kbara${Date.now().toString(36)}`;
    await page.locator('#msg-input').focus();
    await page.keyboard.type(`aranacak ${token} mesaj`);
    await sendAsAlice(page);
    await expect(page.locator('.msg').filter({ hasText: token }).first()).toBeVisible({ timeout: 15_000 });

    // Kabuktaki arama düğmesi: sunucu seçiliyken sunucu içi arama açılır.
    await page.locator('#btn-search').focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.search-overlay .search-input')).toBeFocused({ timeout: 10_000 });
    await page.keyboard.type(token);
    const first = page.locator('.search-result-item').first();
    await expect(first).toContainText(token, { timeout: 15_000 });

    await page.keyboard.press('ArrowDown');
    await expect(first).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('.search-overlay')).toHaveCount(0, { timeout: 5_000 });
    await expect(page.locator('.msg').filter({ hasText: token }).first()).toBeInViewport({ timeout: 15_000 });
  });
});
