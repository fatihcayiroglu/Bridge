// e2e/tests/cross-browser-product.spec.ts
//
// ÇAPRAZ TARAYICI — ÜRÜN YÜZEYİ (GERÇEK ETKİLEŞİMLE)
//
// ════════════════════════════════════════════════════════════════════════════
// NEDEN BU DOSYA FINAL21'DE EKLENDİ
// ════════════════════════════════════════════════════════════════════════════
// Çapraz tarayıcı kapsamı iki dosyadan ibaretti:
//   · cross-browser-core.spec.ts      — kabuk yükleniyor mu, taşma var mı
//   · cross-browser-journeys.spec.ts  — oturum, REST yolculukları, depolama
//
// İkisi de GERÇEKTİR ama ikisi de ÜRÜNÜ PARMAKLA KULLANMAZ. Firefox'un
// "birinci sınıf desteklendiği" iddiası için asıl soru şudur: kullanıcının
// fiilen yaptığı işler — kanala girmek, mesaj yazmak, yanıtlamak, düzenlemek,
// tepki vermek, silmek, arama/ayar/gelen kutusu/DM yüzeylerini açmak, bağlantı
// koptuğunda toparlanmak — Chromium DIŞINDAKİ motorlarda da yürüyor mu?
//
// Motor farkı tam olarak buralarda ortaya çıkar: odak modeli (Firefox ve WebKit
// `:focus-visible` sezgisi farklıdır), hover/pointer olayları (`.msg-actions`
// yalnızca `:hover`/`:focus-within` ile görünür), `input` olay sırası,
// `beforeunload`/soket yeniden bağlanma, CSS `:has()` desteği.
//
// ── YÖNTEM ────────────────────────────────────────────────────────────────
// Fikstür (sunucu + kanal) REST ile hazırlanır — deterministik ve hızlı.
// ETKİLEŞİMİN TAMAMI ARAYÜZDEN yapılır. Böylece ölçülen şey ürünün kendisidir,
// API'si değil.
//
// ── DÜRÜSTLÜK ─────────────────────────────────────────────────────────────
// · Playwright WebKit GERÇEK Safari DEĞİLDİR; bilgilendirici bir sinyaldir.
// · Fikstür kurulamazsa testler açıkça BAŞARISIZ olur; skip ile gizlenmez.
// · Medya/WebRTC iddiası BURADA yapılmaz (motorlar arası yetenek farkı);
//   o yüzey `voice-media` projesine aittir.

import { test, expect } from '../helpers/apiTest';
import path from 'path';
import { deflateSync } from 'zlib';
import type { Page } from '@playwright/test';
import { getTokens, createTestServer, createTestChannel } from '../helpers/bridge';

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:3000';

let token = '';
let serverId = '';
let channelName = '';

test.beforeAll(async ({ request }) => {
  token = getTokens().alice;
  const stamp = Date.now().toString(36);
  const srv = await createTestServer(request, token, `XBP ${stamp}`);
  serverId = srv?._id || srv?.id || '';
  expect(serverId, 'Cross-browser: sunucu fixture oluşturulamadı').toBeTruthy();
  // Kanal adı KOŞUMA ÖZGÜdür: `[aria-label="Kanal: ..."]` seçicisi böylece
  // önceki koşumların bıraktığı kanallarla çakışmaz.
  channelName = `urun-${stamp}`;
  const ch = await createTestChannel(request, token, serverId, channelName, 'text');
  expect(ch?._id || ch?.id, 'Cross-browser: kanal fixture oluşturulamadı').toBeTruthy();
});

/**
 * Kabuğu açar, fikstür sunucusuna girer, fikstür kanalını açar.
 *
 * Ürünün GERÇEK gezinme sözleşmesi kullanılır (daily-driver-journey.spec.ts ile
 * aynı): sunucu rayında `.server-icon[data-id=...]`, kanal listesinde
 * `[aria-label="Kanal: <ad>"]`. Kanal öğeleri gerçek `<button>`dır.
 */
async function enterChannel(page: Page): Promise<void> {
  expect(serverId && channelName, 'Sunucu/kanal fixture kurulamadı').toBeTruthy();
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#app')).toBeVisible({ timeout: 30_000 });
  await page.locator(`.server-icon[data-id="${serverId}"]`).first().click({ timeout: 25_000 });
  await page.locator(`[aria-label="Kanal: ${channelName}"]`).first().click({ timeout: 20_000 });
  await page.locator('#msg-input').waitFor({ state: 'visible', timeout: 20_000 });
}

/** Composer'dan mesaj gönderir ve listede belirmesini bekler. */
async function sendFromComposer(page: Page, body: string): Promise<void> {
  const composer = page.locator('#msg-input');
  await composer.click();
  await composer.fill(body);
  await composer.press('Enter');
  await expect(page.locator('.msg', { hasText: body }).first()).toBeVisible({ timeout: 20_000 });
}

/**
 * Mesajın üzerine gelip eylem çubuğundaki düğmeyi tıklar.
 *
 * `.msg-actions` temel durumda `opacity:0; visibility:hidden` ve YALNIZCA
 * `.msg:hover` / `.msg:focus-within` ile görünür olur. Bu, üç motorda da
 * pointer olaylarının doğru çalıştığının fiilî sınamasıdır.
 */
async function messageAction(page: Page, body: string, label: string): Promise<void> {
  const msg = page.locator('.msg', { hasText: body }).first();
  await msg.hover();
  const button = msg.locator(`.msg-actions button[aria-label="${label}"]`).first();
  await expect(button).toBeVisible({ timeout: 10_000 });
  await button.click();
}

/**
 * Ürünün anti-spam politikası kullanıcı bazlıdır (4 sn'de 5 mesaj) ve eşiği
 * aşan kullanıcı 30 SANİYE susturulur. Bu paket tek kimlikle koşar; gönderimler
 * arasına kasıtlı bir aralık konur. Politika ÜRÜN SINIRIDIR ve gevşetilmez.
 */
async function pace(page: Page): Promise<void> {
  await page.waitForTimeout(1100);
}

test.describe('çapraz tarayıcı — ürün yüzeyi', () => {
  // ── Gezinme ────────────────────────────────────────────────────────────
  test('sunucu ve kanal arayüzden gezilir, composer açılır', async ({ page }) => {
    await enterChannel(page);
    await expect(page.locator('#channel-list')).toBeVisible();
    await expect(page.locator('#msg-input')).toBeVisible();
    await expect(page.locator('#ch-h-name')).toContainText(channelName, { timeout: 10_000 });
  });

  // ── Mesaj gönderme ─────────────────────────────────────────────────────
  test('mesaj arayüzden gönderilir ve composer TEMİZLENİR', async ({ page }) => {
    await enterChannel(page);
    const body = `xb-send-${Date.now().toString(36)}`;
    await sendFromComposer(page, body);
    // Firefox/WebKit'te `keydown` işleyicisi ile değerin temizlenmesi farklı
    // sırada gerçekleşebilir; ürün sözleşmesi "Enter'dan sonra composer boş".
    await expect.poll(
      () => page.locator('#msg-input').inputValue(),
      { timeout: 5_000, message: 'Enter sonrası composer temizlenmedi' },
    ).toBe('');
  });

  // ── Yanıtlama ──────────────────────────────────────────────────────────
  test('YANITLA composer’ı yanıt kipine alır', async ({ page }) => {
    await enterChannel(page);
    const body = `xb-reply-${Date.now().toString(36)}`;
    await sendFromComposer(page, body);
    await pace(page);
    await messageAction(page, body, 'Yanıtla');
    const banner = page.locator('[data-composer-mode="reply"]');
    await expect(banner).toBeVisible({ timeout: 10_000 });
    await expect(banner).toContainText(body);
  });

  // ── Düzenleme ──────────────────────────────────────────────────────────
  test('DÜZENLE composer’ı doldurur ve içerik güncellenir', async ({ page }) => {
    await enterChannel(page);
    const body = `xb-edit-${Date.now().toString(36)}`;
    await sendFromComposer(page, body);
    await pace(page);
    await messageAction(page, body, 'Düzenle');

    await expect(page.locator('[data-composer-mode="edit"]')).toBeVisible({ timeout: 10_000 });
    // Düzenleme kipinde composer, mesajın MEVCUT içeriğini taşımalıdır.
    await expect.poll(() => page.locator('#msg-input').inputValue(), { timeout: 5_000 }).toBe(body);

    const edited = `${body}-duzenli`;
    await page.locator('#msg-input').fill(edited);
    await page.locator('#msg-input').press('Enter');

    const msg = page.locator('.msg', { hasText: edited }).first();
    await expect(msg).toBeVisible({ timeout: 20_000 });
    // Ürün düzenlenen mesajı GÖRÜNÜR biçimde işaretler.
    await expect(msg.locator('.msg-edited').first()).toBeVisible({ timeout: 10_000 });
  });

  // ── Tepki ──────────────────────────────────────────────────────────────
  test('TEPKİ eklenir ve sayaç rozeti belirir', async ({ page }) => {
    await enterChannel(page);
    const body = `xb-react-${Date.now().toString(36)}`;
    await sendFromComposer(page, body);
    await pace(page);
    await messageAction(page, body, 'Tepki ekle');

    const msg = page.locator('.msg', { hasText: body }).first();
    const row = msg.locator('.msg-emoji-row');
    await expect(row).toBeVisible({ timeout: 10_000 });
    await row.locator('button').first().click();

    await expect(msg.locator('.msg-reactions .msg-reaction').first())
      .toBeVisible({ timeout: 20_000 });
  });

  // ── Silme ──────────────────────────────────────────────────────────────
  test('SİL mesajı listeden kaldırır', async ({ page }) => {
    await enterChannel(page);
    const body = `xb-del-${Date.now().toString(36)}`;
    await sendFromComposer(page, body);
    await pace(page);
    await messageAction(page, body, 'Sil');
    await expect(page.locator('.msg', { hasText: body })).toHaveCount(0, { timeout: 20_000 });
  });

  // ── Arama ──────────────────────────────────────────────────────────────
  test('ARAMA paneli açılır ve sorgu girdisi yazılabilir', async ({ page }) => {
    await enterChannel(page);
    await page.locator('#btn-search').click({ timeout: 15_000 });
    const panel = page.locator('.search-panel');
    await expect(panel).toBeVisible({ timeout: 15_000 });
    const input = panel.locator('input').first();
    await input.fill('bridge');
    await expect(input).toHaveValue('bridge');
    // Kaçış tuşu paneli kapatır — motorlar arası klavye sözleşmesi.
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden({ timeout: 10_000 });
  });

  // ── Ayarlar ────────────────────────────────────────────────────────────
  test('AYARLAR kalıcı penceresi açılır ve sekme listesi gezilebilir', async ({ page }) => {
    await enterChannel(page);
    await page.locator('#btn-settings').click({ timeout: 15_000 });
    const modal = page.locator('#settings-modal-content');
    await expect(modal).toBeVisible({ timeout: 15_000 });
    await expect(modal).toHaveAttribute('role', 'dialog');
    await expect(modal.locator('[role="tablist"]').first()).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(modal).toBeHidden({ timeout: 10_000 });
  });

  // ── Gelen kutusu ───────────────────────────────────────────────────────
  test('GELEN KUTUSU açılır', async ({ page }) => {
    await enterChannel(page);
    await page.locator('[data-bridge-action="showInbox"]').first().click({ timeout: 15_000 });
    const panel = page.locator('.inbox-panel');
    await expect(panel).toBeVisible({ timeout: 15_000 });
    await expect(panel.locator('.inbox-filters')).toBeVisible();
    await page.keyboard.press('Escape');
  });

  // ── Direkt mesajlar ────────────────────────────────────────────────────
  test('DM paneli açılır', async ({ page }) => {
    await enterChannel(page);
    await page.locator('[data-bridge-action="showDmPanel"]').first().click({ timeout: 15_000 });
    await expect(page.locator('.dm-panel')).toBeVisible({ timeout: 15_000 });
    await page.keyboard.press('Escape');
  });

  // ── Klavye ─────────────────────────────────────────────────────────────
  test('kanal listesine Tab ile ULAŞILIR ve odak GÖRÜNÜRDÜR', async ({ page }) => {
    await enterChannel(page);
    // Programatik `.focus()` YETMEZ: ürünün odak halkası `:focus-visible`
    // kuralıdır ve bu, tarayıcı sezgiseline bağlıdır. Gerçek Tab kullanılır.
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    let reached = '';
    for (let i = 0; i < 80 && !reached.startsWith('Kanal: '); i++) {
      await page.keyboard.press('Tab');
      reached = await page.evaluate(() =>
        document.activeElement?.getAttribute('aria-label') ?? '');
    }
    expect(reached, 'kanal butonuna Tab ile ULAŞILAMADI').toContain('Kanal: ');

    const indicator = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el) return null;
      const s = getComputedStyle(el);
      return { outline: s.outlineStyle, width: s.outlineWidth, shadow: s.boxShadow };
    });
    expect(indicator, 'odaklı öğe okunamadı').not.toBeNull();
    const visible = indicator !== null
      && ((indicator.outline !== 'none' && parseFloat(indicator.width) > 0)
        || indicator.shadow !== 'none');
    expect(visible, 'odaklanan kanal butonunda GÖRÜNÜR odak göstergesi yok').toBe(true);
  });

  // ── Yeniden bağlanma ───────────────────────────────────────────────────
  test('bağlantı KESİLİP döndükten sonra mesaj gönderimi yeniden çalışır', async ({ page, context }) => {
    await enterChannel(page);

    await context.setOffline(true);
    await page.waitForTimeout(2_000);
    await context.setOffline(false);

    // Soket yeniden bağlanana kadar bekle: ürün sözleşmesi "kullanıcı
    // hiçbir şey yapmadan devam edebilir"dir, elle yenileme GEREKMEZ.
    const body = `xb-recon-${Date.now().toString(36)}`;
    const composer = page.locator('#msg-input');
    await composer.waitFor({ state: 'visible', timeout: 30_000 });
    await expect(async () => {
      await composer.click();
      await composer.fill(body);
      await composer.press('Enter');
      await expect(page.locator('.msg', { hasText: body }).first())
        .toBeVisible({ timeout: 8_000 });
    }).toPass({ timeout: 60_000, intervals: [2_000, 3_000, 5_000] });
  });

  // ── Duyarlı düzen ──────────────────────────────────────────────────────
  test('DAR görünümde yatay taşma yok ve alt gezinme görünür', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#app')).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(800);

    const overflow = await page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, 'dar görünümde yatay taşma var').toBeLessThanOrEqual(1);
    await expect(page.locator('#mobile-nav')).toBeVisible({ timeout: 10_000 });
  });

  // ── Konsol sağlığı ─────────────────────────────────────────────────────
  test('gezinme ve etkileşim boyunca SAYFA HATASI yok', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(String(err)));
    await enterChannel(page);
    await page.locator('#btn-search').click({ timeout: 15_000 }).catch(() => undefined);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(800);
    expect(errors.join(' | '), 'sayfada yakalanmamış istisna').toBe('');
  });
});

// ── Kayıp avatar dosyası — gerçek motorlarda yedek avatar ─────────────────
//
// Final21 Faz 8 (F21-8-02) `MessageRenderer.svelte`e `<img onerror>` yedeği
// ekledi: mesaj avatarı yazarın o anki avatarının ANLIK GÖRÜNTÜSÜdür ve dosya
// meşru biçimde yok olabilir (kullanıcı avatarını AÇIKÇA kaldırır → dosya
// silinir). O değişiklik yalnızca jsdom'da doğrulanmıştı; jsdom resim YÜKLEMEZ,
// `error` olayı elle tetiklendi. Asıl soru motor davranışıdır: Svelte 5'in
// `onerror` dinleyicisi, gerçek bir 404'ten ÖNCE bağlanıyor mu — üç motorda da?
//
// PASS/FAIL (koşumdan önce tanımlandı):
//   · Pozitif kontrol: avatar yüklüyken mesaj satırında `<img>` var ve resim
//     GERÇEKTEN yüklendi (`naturalWidth > 0`).
//   · Sunucu gerçeği: avatar kaldırılınca aynı URL 404 döner.
//   · PASS: TAZE bir bağlamda (HTTP önbelleği yok) aynı mesaj satırında `<img>`
//     YOK ve `.msg-avatar` renk arka planı taşıyor. FAIL: kırık `<img>` duruyor.
//
// Ağ yakalama (page.route) KULLANILMAZ: 404'ü ürünün kendi silme yolu üretir.
test.describe('çapraz tarayıcı — kayıp avatar dosyası', () => {
  // A valid 1x1 RGBA PNG with computed chunk CRCs; Firefox decodes it as well.
  // Avoid opaque base64 fixtures whose CRC can be accepted by upload but rejected by browsers.
  function pngChunk(type: string, data: Buffer): Buffer {
    const payload = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    let crc = 0xffffffff;
    for (const byte of payload) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    const size = Buffer.alloc(4);
    size.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([size, payload, checksum]);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 6;
  const PNG = Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(Buffer.from([0, 255, 0, 0, 255]))),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);

  test('avatar dosyası silinince geçmiş mesaj kırık resim değil RENK AVATARI gösterir', async ({ page, request, browser }, testInfo) => {
    const traceStartedAt = Date.now();
    const phase = (label: string): void => {
      console.log(`[avatar-fallback][${testInfo.project.name}] +${Date.now() - traceStartedAt}ms ${label}`);
    };
    phase('start');
    expect(serverId, 'Sunucu fixture kurulamadı').toBeTruthy();
    // Gruplanmış takip mesajı avatar ÇİZMEZ; bu yüzden mesaj KENDİ kanalında ilk mesajdır.
    const avatarChannel = `avatar-${Date.now().toString(36)}`;
    const ch = await createTestChannel(request, token, serverId, avatarChannel, 'text');
    expect(ch?._id || ch?.id, 'Avatar kanalı fixture kurulamadı').toBeTruthy();
    phase('channel-created');

    const up = await request.post(`${BASE_URL}/api/me/avatar`, {
      headers: { Authorization: `Bearer ${token}` },
      multipart: { avatar: { name: 'xb-avatar.png', mimeType: 'image/png', buffer: PNG } },
    });
    expect(up.status(), 'avatar yüklenemedi').toBe(200);
    const avatarUrl = String((await up.json()).avatarUrl ?? '');
    expect(avatarUrl).toMatch(/^\/uploads\/avatars\//);
    phase('real-avatar-uploaded');

    let removed = false;
    try {
      const body = `xb-avatar-${Date.now().toString(36)}`;
      await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
      await expect(page.locator('#app')).toBeVisible({ timeout: 30_000 });
      await page.locator(`.server-icon[data-id="${serverId}"]`).first().click({ timeout: 25_000 });
      await page.locator(`[aria-label="Kanal: ${avatarChannel}"]`).first().click({ timeout: 20_000 });
      await page.locator('#msg-input').waitFor({ state: 'visible', timeout: 20_000 });
      await sendFromComposer(page, body);
      phase('message-sent-and-visible');

      // Pozitif kontrol: resim gerçekten çizildi.
      const liveImg = page.locator('.msg', { hasText: body }).first().locator('.msg-avatar img');
      await expect(liveImg).toHaveCount(1, { timeout: 15_000 });
      await expect(liveImg, 'pozitif kontrol: avatar resmi yüklenmedi').toHaveJSProperty('complete', true, { timeout: 15_000 });
      await expect.poll(() => liveImg.getAttribute('src'), { timeout: 15_000 }).toBe(avatarUrl);
      await expect(liveImg, 'pozitif kontrol: avatar resmi boş veya kırık').not.toHaveJSProperty('naturalWidth', 0, { timeout: 15_000 });
      phase('positive-image-render-confirmed');

      const del = await request.delete(`${BASE_URL}/api/me/avatar`, { headers: { Authorization: `Bearer ${token}` } });
      expect(del.status(), 'avatar kaldırılamadı').toBe(200);
      removed = true;
      const gone = await request.get(`${BASE_URL}${avatarUrl}`);
      expect(gone.status(), 'sunucu gerçeği: kaldırılan avatar dosyası hâlâ sunuluyor').toBe(404);
      phase('avatar-deleted-and-404-confirmed');

      // Taze bağlam: önceki yüklemenin HTTP önbelleği ölçümü kirletemez.
      const fresh = await browser.newContext({
        baseURL: BASE_URL,
        // Proje `storageState`i yapılandırma dizinine GÖRELİdir; yeni bağlam bunu kendisi çözmez.
        storageState: path.resolve(path.dirname(testInfo.config.configFile ?? ''), String(testInfo.project.use.storageState)),
      });
      try {
        const p2 = await fresh.newPage();
        phase('fresh-context-page-created');
        await p2.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
        await expect(p2.locator('#app')).toBeVisible({ timeout: 30_000 });
        await p2.locator(`.server-icon[data-id="${serverId}"]`).first().click({ timeout: 25_000 });
        await p2.locator(`[aria-label="Kanal: ${avatarChannel}"]`).first().click({ timeout: 20_000 });
        const row = p2.locator('.msg', { hasText: body }).first();
        await expect(row).toBeVisible({ timeout: 20_000 });
        phase('fresh-context-message-visible');

        // Mesaj anlık görüntüsü hâlâ eski URL'yi taşır — test ölçtüğünü sandığı şeyi ölçüyor mu?
        const history = await request.get(`${BASE_URL}/api/channels/${ch._id || ch.id}/messages?limit=5`,
          { headers: { Authorization: `Bearer ${token}` } });
        expect(history.status()).toBe(200);
        const raw = await history.json();
        const list: Array<{ content?: string; avatarUrl?: string | null }> = Array.isArray(raw) ? raw : (raw.messages ?? []);
        expect(list.find((m) => m.content === body)?.avatarUrl, 'mesaj anlık görüntüsü avatar URL taşımıyor — ölçüm anlamsız')
          .toBe(avatarUrl);
        phase('historical-avatar-url-confirmed');

        await expect(row.locator('.msg-avatar img'), 'kırık avatar resmi hâlâ çiziliyor').toHaveCount(0, { timeout: 15_000 });
        phase('broken-image-absent');
        // Aynı iddia (satır içi arka plan dolu), yeniden deneyen yardımcı dünyada okunur.
        // P3 gecelik koşu: Firefox'ta taze bağlamda ana dünya `locator.evaluate`
        // 10 sn yanıtsız kaldı — hemen önceki `toHaveCount(0)` geçmiş, öğe görünür
        // çözülmüştü; yeniden koşu ve Chromium/WebKit geçti. Ürün durumu değil,
        // okuma yolu takılıyordu.
        await expect(row.locator('.msg-avatar').first(), 'yedek renk avatarı arka planı yok')
          .toHaveAttribute('style', /background\s*:\s*\S/, { timeout: 15_000 });
        phase('fallback-background-verified');
      } finally {
        phase('fresh-context-closing');
        await fresh.close();
        phase('fresh-context-closed');
      }
    } finally {
      if (!removed) {
        await request.delete(`${BASE_URL}/api/me/avatar`, { headers: { Authorization: `Bearer ${token}` } }).catch(() => undefined);
      }
    }
  });
});
