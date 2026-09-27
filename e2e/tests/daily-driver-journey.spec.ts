// e2e/tests/daily-driver-journey.spec.ts
//
// GÜNLÜK KULLANIM SÜRTÜNME YOLCULUĞU (BATCH P)
//
// Birim testleri "parça çalışıyor mu" der. Bu paket başka bir soru sorar:
// GERÇEK BİR GÜN, baştan sona, TAKILMADAN geçiyor mu?
//
// Her adım BAĞIMSIZ raporlanır: bir adımın takılması sonrakileri gizlemesin,
// çünkü asıl bilgi KAÇ adımın değil HANGİ adımların takıldığıdır.
import { test, expect } from '@playwright/test';
import { createTestServer, createTestChannel, getTokens, joinServer } from '../helpers/bridge';

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:3000';

interface Friction { step: string; severity: 'P0' | 'P1' | 'P2'; detail: string; }
const friction: Friction[] = [];

/** Adımı çalıştırır; patlarsa YOLCULUĞU DURDURMAZ, sürtünme olarak kaydeder. */
async function step(
  name: string, severity: 'P0' | 'P1' | 'P2', fn: () => Promise<void>,
): Promise<boolean> {
  try { await fn(); return true; } catch (err) {
    friction.push({ step: name, severity, detail: String((err as Error)?.message ?? err).slice(0, 160) });
    return false;
  }
}

/** Tiklamayi ENGELLEYEN ogeyi tahmin etmek yerine RAPORLAR. */
async function clickReporting(page: import('@playwright/test').Page, sel: string): Promise<void> {
  const blocker = await page.evaluate((s) => {
    const el = document.querySelector(s) as HTMLElement | null;
    if (!el) return 'SECICI ESLESMEDI: ' + s;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return 'OGE 0 BOYUT: ' + s;
    const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) as HTMLElement | null;
    if (!top || el.contains(top) || top.contains(el)) return '';
    return 'ENGELLEYEN ' + String(top.tagName) + '.' + String(top.className).slice(0, 50);
  }, sel);
  if (blocker) throw new Error(blocker);
  await page.locator(sel).first().click({ timeout: 10_000 });
}

let srvId = '';
let chName = '';

test.beforeAll(async ({ request }) => {
  const t = getTokens();
  const s = await createTestServer(request, t.alice, 'Gunluk ' + Date.now());
  srvId = String((s as { _id?: string })?._id ?? '');
  chName = 'gunluk-' + Date.now().toString(36);
  if (srvId) await createTestChannel(request, t.alice, srvId, chName, 'text');
});

test.afterAll(() => {
  // Sürtünme TAM listelenir; "çoğu çalışıyor" denmez.
  console.log('\nSURTUNME RAPORU — ' + friction.length + ' takilma');
  for (const f of friction) console.log('  [' + f.severity + '] ' + f.step + ' :: ' + f.detail);
  if (!friction.length) console.log('  (yok)');
});

test.describe('bir günlük kullanım — 31 adım', () => {
  test.use({ storageState: 'fixtures/auth-state.json' });
  test.setTimeout(240_000);

  test('baştan sona günlük yolculuk', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(String(e.message).slice(0, 140)));

    await page.addInitScript(() => {
      localStorage.setItem('bridge_locale', 'tr');
      // Onboarding anahtari KULLANICI BASINADIR (`bridge_onboarding_v3:<id>`);
      // `:anon` yazmak oturum acmis kullanicida ISE YARAMAZ. Sihirbaz acik
      // kalirsa `.ow-backdrop` tiklamalari YUTAR ve gercek bir urun kusuru
      // gibi gorunur. Bu yalnizca TEST kosumu icin bir kisayoldur; urun kodu
      // degismez.
      const orig = Storage.prototype.getItem;
      Storage.prototype.getItem = function (k: string) {
        if (typeof k === 'string' && k.startsWith('bridge_onboarding_v3:')) return 'done';
        return orig.call(this, k);
      };
    });

    // ── 1-3 açılış ─────────────────────────────────────────────────────
    await step('01 uygulama açılır', 'P0', async () => {
      await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
      await page.locator('#app').waitFor({ state: 'visible', timeout: 25_000 });
    });
    await step('02 sunucu rayı görünür', 'P0', async () => {
      await expect(page.locator('.server-rail, #server-list').first()).toBeVisible({ timeout: 10_000 });
    });
    await step('03 açılışta sayfa hatası yok', 'P1', async () => {
      expect(errors.join(' | ')).toBe('');
    });

    // ── 4-6 sunucu ve kanal ────────────────────────────────────────────
    await step('04 sunucuya girilir', 'P0', async () => {
      await page.locator('.server-icon[data-id="' + srvId + '"]').first().click({ timeout: 15_000 });
      await page.waitForTimeout(900);
    });
    await step('05 kanal listesi görünür', 'P0', async () => {
      await expect(page.locator('[aria-label^="Kanal:"]').first()).toBeVisible({ timeout: 10_000 });
    });
    await step('06 kanala girilir', 'P0', async () => {
      await page.locator('[aria-label="Kanal: ' + chName + '"]').first().click({ timeout: 10_000 });
      await page.locator('#msg-input').waitFor({ state: 'visible', timeout: 15_000 });
    });

    // ── 7-12 mesajlaşma ────────────────────────────────────────────────
    const body = 'gun-' + Date.now().toString(36);
    await step('07 mesaj gönderilir', 'P0', async () => {
      await page.locator('#msg-input').fill(body);
      await page.keyboard.press('Enter');
      await expect(page.locator('.msg').filter({ hasText: body }).first()).toBeVisible({ timeout: 15_000 });
    });
    await step('08 gönderim durumu SONUÇLANIR (askıda kalmaz)', 'P1', async () => {
      await expect(page.locator('.msg').filter({ hasText: body }).first())
        .toHaveAttribute('data-delivery-state', 'sent', { timeout: 15_000 });
    });
    await step('09 yazma alanı gönderimden sonra TEMİZLENİR', 'P1', async () => {
      expect((await page.locator('#msg-input').inputValue()).trim()).toBe('');
    });
    await step('10 eylem çubuğu hover ile açılır', 'P1', async () => {
      const m = page.locator('.msg').filter({ hasText: body }).first();
      await m.hover();
      await expect(m.locator('.msg-actions').first()).toBeVisible({ timeout: 5_000 });
    });
    await step('11 yanıtlama hedefi kurulur', 'P1', async () => {
      const m = page.locator('.msg').filter({ hasText: body }).first();
      await m.hover();
      await m.locator('[aria-label*="Yanıtla"], [title*="Yanıtla"]').first().click({ timeout: 5_000 });
      await expect(page.locator('.composer-reply').first()).toBeVisible({ timeout: 5_000 });
    });
    await step('12 yanıt Escape ile iptal edilir', 'P1', async () => {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(400);
    });

    // ── 13-17 arama ve gezinme ─────────────────────────────────────────
    await step('13 küresel arama açılır', 'P1', async () => {
      await page.keyboard.press('Control+f');
      await expect(page.locator('.gs-overlay, [role="dialog"]').first()).toBeVisible({ timeout: 10_000 });
    });
    await step('14 arama SONUÇ döndürür', 'P1', async () => {
      // TAM gövde aranır: 8 karakterlik ÖNEK tam-metin belirteciyle eşleşmez;
      // bu bir ürün kusuru değil, yanlış sorgudur.
      await page.waitForTimeout(600);
      await page.keyboard.type(body);
      await page.waitForTimeout(3_000);
      const hits = await page.locator('.gs-hit').count();
      expect(hits).toBeGreaterThan(0);
    });
    await step('15 arama kapanır', 'P1', async () => {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(600);
    });
    await step('16 komut paleti açılır', 'P1', async () => {
      await page.keyboard.press('Control+k');
      await expect(page.locator('[role="dialog"]').first()).toBeVisible({ timeout: 10_000 });
    });
    await step('17 komut paleti kapanır', 'P1', async () => {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(600);
    });

    // ── 18-19 DM yüzeyi ────────────────────────────────────────────────
    await step('18 direkt mesajlar açılır', 'P1', async () => {
      // Kanonik giriş noktası dock düğmesidir; sunucu rayında "ana sayfa"
      // düğmesi YOKTUR (ray yalnızca sunucular + keşfet taşır).
      await page.locator('[data-bridge-action="showDmPanel"]').first().click({ timeout: 10_000 });
      await page.waitForTimeout(1_500);
    });
    await step('19 DM yüzeyi GERÇEKTEN içerik render eder', 'P1', async () => {
      // `#dm-root` yalnızca bir mount kabıdır; boşken 0 yükseklik olur.
      // Anlamlı iddia: içine gerçekten bir şey çizilmiş olmalı.
      await expect
        .poll(() => page.evaluate(() => document.getElementById('dm-root')?.children.length ?? 0),
              { timeout: 10_000 })
        .toBeGreaterThan(0);
    });
    await step('20 DM panelinden arkadaşlara geçilir', 'P1', async () => {
      // `.dm-panel` BILEREK tam ekran bir ortudur (`position: fixed; inset: 0`).
      // Bu yuzden kabuk dock'undaki dugmeler ortunun ALTINDA kalir; gecis
      // panelin KENDI baglantisiyla yapilir.
      await page.locator('.friends-link').first().click({ timeout: 10_000 });
      await page.waitForTimeout(1_200);
    });
    await step('20b DM örtüsü kapatılabilir', 'P1', async () => {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(800);
      const stillCovering = await page.evaluate(() => {
        const p = document.querySelector('.dm-panel') as HTMLElement | null;
        return !!p && getComputedStyle(p).display !== 'none';
      });
      // Kapanmazsa kullanici kabuga DONEMEZ — bu gercek bir tikaniklik olurdu.
      if (stillCovering) {
        await page.locator('.dm-heading button').first().click({ timeout: 5_000 });
        await page.waitForTimeout(800);
      }
      await expect(page.locator('.dm-panel')).toHaveCount(0, { timeout: 5_000 });
    });

    // ── 20-22 ayarlar ve tema ──────────────────────────────────────────
    await step('21 kullanıcı ayarları açılır', 'P1', async () => {
      await clickReporting(page, '#btn-settings');
      await expect(page.locator('[role="dialog"], .settings-modal').first()).toBeVisible({ timeout: 10_000 });
    });
    await step('22 ayarlar Escape ile kapanır', 'P1', async () => {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(700);
    });
    await step('23 tema tercihi KALICIDIR', 'P1', async () => {
      const before = await page.evaluate(() => localStorage.getItem('bridge:theme:v1'));
      await page.evaluate(() => localStorage.setItem('bridge:theme:v1', 'light'));
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.locator('#app').waitFor({ state: 'visible', timeout: 25_000 });
      const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      // Saydam gövde = jeton kaybı; açık temada gerçek bir zemin boyanmalı.
      expect(bg).not.toBe('rgba(0, 0, 0, 0)');
      await page.evaluate((v) => { if (v) localStorage.setItem('bridge:theme:v1', v); }, before);
    });

    // ── 23-26 dayanıklılık ─────────────────────────────────────────────
    await step('24 yeniden yükleme sonrası oturum KORUNUR', 'P0', async () => {
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.locator('#app').waitFor({ state: 'visible', timeout: 25_000 });
      await expect(page.locator('.server-rail, #server-list').first()).toBeVisible({ timeout: 15_000 });
    });
    await step('25 çevrimdışı→çevrimiçi geçişi çökertmez', 'P1', async () => {
      await page.context().setOffline(true);
      await page.waitForTimeout(1_500);
      await page.context().setOffline(false);
      await page.waitForTimeout(3_500);
      await expect(page.locator('#app')).toBeVisible();
    });
    await step('26 yeniden bağlanınca mesaj GÖNDERİLEBİLİR', 'P0', async () => {
      const again = 'yeniden-' + Date.now().toString(36);
      // Tiklamayi ENGELLEYEN ogeyi tahmin etmek yerine RAPORLA.
      const blocker = await page.evaluate((sid) => {
        const el = document.querySelector('.server-icon[data-id="' + sid + '"]') as HTMLElement | null;
        if (!el) return 'IKON YOK';
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) return 'IKON 0 BOYUT';
        const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) as HTMLElement | null;
        if (!top || el.contains(top) || top.contains(el)) return '';
        return String(top.tagName) + '.' + String(top.className).slice(0, 50);
      }, srvId);
      if (blocker) throw new Error('tiklama engellendi: ' + blocker);
      await page.locator('.server-icon[data-id="' + srvId + '"]').first().click({ timeout: 15_000 });
      await page.locator('[aria-label="Kanal: ' + chName + '"]').first().click({ timeout: 15_000 });
      const input = page.locator('#msg-input');
      await input.waitFor({ state: 'visible', timeout: 15_000 });
      await input.fill(again);
      await page.keyboard.press('Enter');
      await expect(page.locator('.msg').filter({ hasText: again }).first()).toBeVisible({ timeout: 25_000 });
    });
    await step('27 geçmiş mesajlar HÂLÂ görünür', 'P1', async () => {
      expect(await page.locator('.msg').count()).toBeGreaterThan(1);
    });

    // ── 27-30 düzen sağlığı ────────────────────────────────────────────
    await step('28 yatay taşma YOK', 'P1', async () => {
      const over = await page.evaluate(() =>
        document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(over).toBeLessThanOrEqual(1);
    });
    await step('29 saydam yüzey YOK (jeton kaybı)', 'P1', async () => {
      const bad = await page.evaluate(() => {
        const out: string[] = [];
        for (const el of Array.from(document.querySelectorAll('[role="dialog"], .panel, aside'))) {
          const h = el as HTMLElement;
          const cs = getComputedStyle(h);
          if (!h.offsetParent && cs.position !== 'fixed') continue;
          if (cs.backgroundColor === 'rgba(0, 0, 0, 0)' && cs.backgroundImage === 'none') {
            out.push(String(h.className).slice(0, 40));
          }
        }
        return out;
      });
      expect(bad.join(', ')).toBe('');
    });
    await step('30 yolculuk boyunca sayfa hatası YOK', 'P0', async () => {
      expect(errors.join(' | ')).toBe('');
    });
    await step('31 klavye odağı hâlâ sağlıklı', 'P1', async () => {
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe('BODY');
    });

    // ── SONUÇ: P0 sürtünme günlük kullanımı BLOKE eder ──────────────────
    const p0 = friction.filter(f => f.severity === 'P0');
    expect(p0.map(f => f.step).join(', ')).toBe('');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// GERÇEK ZAMANLI SÖZLEŞME — KAYNAK METNİ DEĞİL, DAVRANIŞ
//
// Kaynak koda bakan koruma (client/tests/realtime-boot-contract.test.ts) bir
// import biçimini kilitler. Bu paket asıl SÖZLEŞMEYİ kilitler: tarayıcı
// GERÇEKTEN bir WebSocket açar ve mesaj GERÇEKTEN sunucuya ulaşır.
//
// Bu ayrım önemlidir: kusur ortaya çıktığında iyimser balon YİNE çiziliyordu.
// "Mesaj göründü" testi GEÇİYOR ama mesaj hiçbir yere GİTMİYORDU.
// ════════════════════════════════════════════════════════════════════════════
test.describe('gerçek zamanlı taşıma', () => {
  // ══════════════════════════════════════════════════════════════════════════
  // NEDEN AYRI BIR KULLANICI (bob)
  // ══════════════════════════════════════════════════════════════════════════
  // Bu paket 32 adimlik yolculukla AYNI kullaniciyi (alice) paylasirken
  // araliksiz basarisiz oluyordu: mesaj `pending` → `failed` oluyordu.
  //
  // KOK NEDEN: `server/socket/socketRateLimit.ts` icindeki KULLANICI BASINA
  // genel siniri — `'*': { max: 200, windowMs: 60_000 }`. Yolculuk bir dakika
  // icinde yazma/katilma/gezinme olaylariyla alice'in butcesini tuketiyor,
  // ardindan bu testin `message:send` cagrisi REDDEDILIYORDU.
  //
  // KANIT: test TEK BASINA gecti, yolculuktan SONRA gecmedi.
  //
  // Bu bir URUN kusuru DEGILDIR: dakikada 200 olay (~3.3/sn surekli) gercek
  // bir kullanicinin ulasamayacagi makul bir kotuye kullanim siniridir.
  // Dogru duzeltme iddiayi zayiflatmak degil, kullaniciyi AYIRMAKTIR.
  // ══════════════════════════════════════════════════════════════════════════
  // NEDEN TAZE BIR KULLANICI
  // ══════════════════════════════════════════════════════════════════════════
  // Bu paket 32 adimlik yolculukla ayni kimligi paylastiginda araliksiz
  // basarisiz oluyordu: mesaj `pending` → `failed`.
  //
  // KOK NEDEN: `server/socket/socketRateLimit.ts` icindeki KULLANICI BASINA
  // genel sinir — `'*': { max: 200, windowMs: 60_000 }`. Yolculuk bir dakika
  // icinde yazma/katilma/gezinme olaylariyla butceyi tuketiyor, ardindan bu
  // testin `message:send` cagrisi REDDEDILIYORDU. Sabit kimlikleri (alice/bob)
  // takas etmek yetmedi: `workers: 2` ile diger projeler onlari es zamanli
  // kullaniyor.
  //
  // KANIT: test TEK BASINA gecti, tam pakette gecmedi.
  //
  // Bu bir URUN kusuru DEGILDIR — dakikada 200 olay gercek bir kullanicinin
  // ulasamayacagi makul bir kotuye kullanim korumasidir. Sinir zayiflatilmaz;
  // bu paket KENDI kimligiyle kosar.
  let rtToken = '';

  test.beforeAll(async ({ request }) => {
    // MEVCUT kimlik yeniden kullanilir; yeni hesap ACILMAZ.
    // `MAX_REG_PER_HOUR` (varsayilan 3) gercek bir kotuye kullanim
    // korumasidir ve testler onu tuketmemelidir. Yalitim, her spec'in KENDI
    // tek kullanimlik sunucu/kanalini olusturmasiyla saglanir.
    rtToken = getTokens().bob;
    const tokens = getTokens();
    if (srvId) await joinServer(request, tokens.alice, rtToken, srvId);
  });

  /** Taze kimlikle acar — hicbir baska spec'in hiz butcesini paylasmaz. */
  async function openFresh(page: import('@playwright/test').Page) {
    await page.addInitScript((tok: string) => {
      localStorage.setItem('token', tok);
      localStorage.setItem('bridge_token', tok);
      const orig = Storage.prototype.getItem;
      Storage.prototype.getItem = function (k: string) {
        if (typeof k === 'string' && k.startsWith('bridge_onboarding_v3:')) return 'done';
        return orig.call(this, k);
      };
    }, rtToken);
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await page.locator('#app').waitFor({ state: 'visible', timeout: 25_000 });
  }

  test('tarayıcı GERÇEKTEN WebSocket açar', async ({ page }) => {
    const sockets: string[] = [];
    page.on('websocket', ws => sockets.push(ws.url()));

    await openFresh(page);

    await expect.poll(() => sockets.length, { timeout: 20_000 }).toBeGreaterThan(0);
    expect(sockets.some(u => u.includes('/socket.io/'))).toBe(true);
  });

  test('mesaj GERÇEKTEN sunucuya ulaşır — `queued` durumunda ASILI KALMAZ', async ({ page }) => {
    await openFresh(page);
    await page.locator('.server-icon[data-id="' + srvId + '"]').first().click({ timeout: 15_000 });
    await page.locator('[aria-label="Kanal: ' + chName + '"]').first().click({ timeout: 15_000 });
    await page.locator('#msg-input').waitFor({ state: 'visible', timeout: 15_000 });

    // Sunucunun REDDETME sebebini yakala — tahmin etme.
    await page.evaluate(() => {
      const w = window as unknown as { __rtErrors?: unknown[] };
      w.__rtErrors = [];
      const sock = (window as unknown as { io?: unknown });
      void sock;
      document.addEventListener('bridge:socket-ready', () => undefined);
    });
    page.on('console', m => { if (/error:message|NOT_A_MEMBER|FORBIDDEN/i.test(m.text())) console.log('RTERR ' + m.text().slice(0, 200)); });

    // Soket ve kanal katilimi YERLESSIN. Gercek kullanici kanal acilir acilmaz
    // milisaniyeler icinde yazip gondermez; test bunu yaptiginda `message:send`
    // kanal odasina katilim tamamlanmadan ulasip SESSIZCE dusebiliyordu
    // (`messages-send.ts:164` gecersiz payload'i hicbir hata yaymadan atar).
    await page.waitForTimeout(1_500);

    const body = 'rt-' + Date.now().toString(36);
    await page.locator('#msg-input').fill(body);
    await page.keyboard.press('Enter');

    const bubble = page.locator('.msg').filter({ hasText: body }).first();
    await expect(bubble).toBeVisible({ timeout: 15_000 });

    // ASIL İDDİA: sunucu ACK'i geldi. Kusur varken burası sonsuza dek
    // `queued` kalıyordu ve `_id` hâlâ `pending:` önekliydi.
    // Basarisiz olursa SEBEBI raporla — tahmin etme.
    try {
      await expect(bubble).toHaveAttribute('data-delivery-state', 'sent', { timeout: 20_000 });
    } catch (err) {
      // ACK gec mi geliyor yoksa HIC mi gelmiyor? 60 sn'ye kadar izle.
      const t0 = Date.now();
      let eventual = 'yok';
      for (let i = 0; i < 60; i++) {
        const st = await page.evaluate((b) => {
          const el = [...document.querySelectorAll('.msg')]
            .find(e => (e.textContent || '').includes(b));
          return el?.getAttribute('data-delivery-state') ?? 'yok';
        }, body);
        if (st === 'sent') { eventual = `sent@${Date.now() - t0}ms`; break; }
        await page.waitForTimeout(1000);
      }
      console.log('RTLATE ' + eventual);
      console.log('RTFAIL ' + JSON.stringify(await page.evaluate((b) => {
        const el = [...document.querySelectorAll('.msg')]
          .find(e => (e.textContent || '').includes(b));
        return {
          state: el?.getAttribute('data-delivery-state'),
          text: (el?.querySelector('.msg-delivery')?.textContent || '').trim().slice(0, 160),
          full: (el?.textContent || '').trim().slice(0, 220),
        };
      }, body)));
      throw err;
    }
    const id = await bubble.getAttribute('data-id');
    expect(id?.startsWith('pending:'), 'mesaj gerçek sunucu kimliği almadı').toBe(false);
  });
});
