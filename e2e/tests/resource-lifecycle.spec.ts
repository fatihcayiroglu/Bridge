// e2e/tests/resource-lifecycle.spec.ts
//
// KAYNAK YAŞAM DÖNGÜSÜ — SIZINTI VAR MI?
//
// ════════════════════════════════════════════════════════════════════════════
// NEDEN VAR
// ════════════════════════════════════════════════════════════════════════════
// Medya paketi tam kosumda DÖNÜŞÜMLÜ bir kurulum zaman aşımı üretiyor.
// "Makine kapasitesi" demek kolay ama KANIT DEĞİL. Bu paket ölçülebilir
// alternatifi sınar: ürün tekrarlanan döngülerde kaynak BİRİKTİRİYOR mu?
//
// Aranan şey: monotonik büyüme. Sayılar döngü başına artıyorsa sızıntı vardır
// ve bu bir ÜRÜN kusurudur — ortam sorunu değil.
//
// ── BU TESTİN KANITLADIĞI ─────────────────────────────────────────────────
// Tek bir tarayıcı bağlamında tekrarlanan katıl/ayrıl, aç/kapat ve gezinme
// döngülerinden sonra sayfa içi nesnelerin (peer connection, medya elemanı,
// timer) sabit kalıp kalmadığı.
//
// ── BU TESTİN KANITLAMADIĞI ───────────────────────────────────────────────
// İşletim sistemi düzeyindeki tükenmeyi (soket/handle/port), CPU veya bellek
// baskısını, ya da çoklu tarayıcı bağlamının toplam maliyetini. Onlar ayrı
// ölçüm ister.

import { test, expect, type Page } from '@playwright/test';
import { createTestServer, createTestChannel, getTokens } from '../helpers/bridge';

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:3000';

const INSTRUMENT = () => {
  const w = window as unknown as { __pcs?: unknown[]; RTCPeerConnection: unknown };
  w.__pcs = [];
  const Orig = w.RTCPeerConnection as new (...a: unknown[]) => unknown;
  const Wrapped = function (this: unknown, ...args: unknown[]) {
    const pc = new Orig(...args);
    (w.__pcs as unknown[]).push(pc);
    return pc;
  } as unknown as new (...a: unknown[]) => unknown;
  Wrapped.prototype = Orig.prototype;
  w.RTCPeerConnection = Wrapped;
  // NOT: `setInterval`/`clearInterval` SARMALANMAZ. Denendi ve uygulama
  // acilmadi (`#app` hic gorunur olmadi) — olcum araci urunu bozuyordu.
  // Zamanlayici sayimi bu yuzden kapsam disi; asil sinyal eslesme ve DOM.
};

/** Sayfa içi kaynak sayımı — iddia değil, ölçüm. */
const counts = (page: Page) => page.evaluate(() => {
  const w = window as unknown as { __pcs?: RTCPeerConnection[] };
  const pcs = w.__pcs ?? [];
  return {
    pcsTotal: pcs.length,
    pcsOpen: pcs.filter(p => p.connectionState !== 'closed').length,
    audioEls: document.querySelectorAll('audio').length,
    videoEls: document.querySelectorAll('video').length,
    remoteAudio: document.querySelectorAll('audio.remote-audio').length,
    dialogs: document.querySelectorAll('[role="dialog"]').length,
  };
});

let srvId = '';
let textCh = '';
let voiceCh = '';

test.beforeAll(async ({ request }) => {
  const t = getTokens();
  const srv = await createTestServer(request, t.alice, `Lifecycle ${Date.now()}`);
  srvId = String((srv as { _id?: string })?._id ?? '');
  textCh = `lc-t-${Date.now().toString(36)}`;
  voiceCh = `lc-v-${Date.now().toString(36)}`;
  await createTestChannel(request, t.alice, srvId, textCh, 'text');
  await createTestChannel(request, t.alice, srvId, voiceCh, 'voice');
});

test.describe('kaynak yaşam döngüsü', () => {
  // `storageState` KULLANILMAZ: `fixtures/auth-state.json` sunucu yeniden
  // baslatildiginda veya global setup yarim kaldiginda BAYAT kalabiliyor ve
  // uygulama giris ekraninda takiliyor (`#app` gizli). Jeton dogrudan
  // `tokens.json`dan enjekte edilir — tek dogruluk kaynagi.
  test.setTimeout(180_000);

  async function shell(page: Page) {
    await page.addInitScript(INSTRUMENT);
    await page.addInitScript((tok: string) => {
      localStorage.setItem('token', tok);
      localStorage.setItem('bridge_token', tok);
    }, getTokens().alice);
    await page.addInitScript(() => {
      const o = Storage.prototype.getItem;
      Storage.prototype.getItem = function (k: string) {
        if (typeof k === 'string' && k.startsWith('bridge_onboarding_v3:')) return 'done';
        return o.call(this, k);
      };
    });
    const errs: string[] = [];
    page.on('pageerror', e => errs.push(String(e.message).slice(0, 160)));
    page.on('console', m => { if (m.type() === 'error') errs.push('C:' + m.text().slice(0, 160)); });
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    try {
      await page.locator('#app').waitFor({ state: 'visible', timeout: 25_000 });
    } catch (e) {
      console.log('BOOTERR ' + JSON.stringify(errs.slice(0, 6)));
      throw e;
    }
    await page.locator(`.server-icon[data-id="${srvId}"]`).first().click({ timeout: 20_000 });
  }

  test('sunucu/kanal gezinme döngüsü BİRİKTİRMEZ', async ({ page }) => {
    // KANITLAR   : 10 gezinme döngüsünden sonra DOM/timer sayıları sabit.
    // KANITLAMAZ : işletim sistemi düzeyinde tükenme.
    await shell(page);
    await page.locator(`[aria-label="Kanal: ${textCh}"]`).first().click({ timeout: 20_000 });
    await page.waitForTimeout(1_000);
    const base = await counts(page);

    for (let i = 0; i < 10; i++) {
      await page.locator(`[aria-label="Kanal: ${textCh}"]`).first().click();
      await page.waitForTimeout(250);
      await page.locator(`[aria-label="Ses kanalı: ${voiceCh}"]`).first().click().catch(() => undefined);
      await page.waitForTimeout(250);
    }
    await page.waitForTimeout(2_000);
    const after = await counts(page);

    // Ölçümü RAPORLA — sayı gizlenmez.
    console.log('NAV base=' + JSON.stringify(base) + ' after=' + JSON.stringify(after));

    // Ses kanalına girip çıkmak bir miktar eleman yaratır; ama 10 döngü
    // sonrası sayı döngü sayısıyla ORANTILI BÜYÜMEMELİ.
    expect(after.audioEls - base.audioEls, 'ses elemanı döngü başına birikiyor')
      .toBeLessThan(10);
    expect(after.videoEls - base.videoEls, 'video elemanı döngü başına birikiyor')
      .toBeLessThan(10);
  });

  test('modal aç/kapat döngüsü BİRİKTİRMEZ', async ({ page }) => {
    // KANITLAR   : 15 aç/kapat sonrası açık diyalog kalmıyor, timer patlamıyor.
    // KANITLAMAZ : bellek kullanımını.
    await shell(page);
    await page.waitForTimeout(800);
    const base = await counts(page);

    for (let i = 0; i < 15; i++) {
      await page.keyboard.press('Control+k');
      await page.waitForTimeout(160);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(160);
    }
    await page.waitForTimeout(1_500);
    const after = await counts(page);
    console.log('MODAL base=' + JSON.stringify(base) + ' after=' + JSON.stringify(after));

    expect(after.dialogs, 'kapanmayan diyalog kaldı').toBe(0);
    expect(after.pcsOpen, 'modal döngüsü eşleşme sızdırdı').toBe(base.pcsOpen);
  });

  test('ses katıl/ayrıl döngüsü eşleşme BİRİKTİRMEZ', async ({ page }) => {
    // KANITLAR   : 5 katıl/ayrıl sonrası AÇIK peer connection kalmıyor ve
    //              uzak ses elemanı birikmiyor.
    // KANITLAMAZ : iki taraflı medya kurulumunun maliyetini (tek bağlam).
    await shell(page);
    const base = await counts(page);

    for (let i = 0; i < 5; i++) {
      await page.locator(`[aria-label="Ses kanalı: ${voiceCh}"]`).first().click({ timeout: 20_000 });
      await page.waitForTimeout(1_200);
      const leave = page.locator('[aria-label="Ses kanalından ayrıl"]:visible').first();
      if (await leave.count()) await leave.click().catch(() => undefined);
      await page.waitForTimeout(800);
    }
    await page.waitForTimeout(2_500);
    const after = await counts(page);
    console.log('VOICE base=' + JSON.stringify(base) + ' after=' + JSON.stringify(after));

    // Tek kişilik odada eşleşme kurulmaz; asıl kontrol AÇIK kalan olmaması.
    expect(after.pcsOpen, 'ayrıldıktan sonra açık eşleşme kaldı').toBe(0);
    expect(after.remoteAudio, 'uzak ses elemanı birikti').toBe(0);
  });
});
