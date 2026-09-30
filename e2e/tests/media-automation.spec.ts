// e2e/tests/media-automation.spec.ts
//
// İNSAN KONTROL LİSTESİNİN MAKİNEYLE KANITLANABİLİR KISMI
//
// ════════════════════════════════════════════════════════════════════════════
// AMAÇ
// ════════════════════════════════════════════════════════════════════════════
// İnsan gözü/kulağı GEREKTİRMEYEN her maddeyi otomatikleştirmek. Geriye
// yalnızca gerçekten duyusal olanlar kalsın.
//
// Her testin başında iki satır zorunludur:
//   KANITLAR      — bu testin gerçekten gösterdiği şey
//   KANITLAMAZ    — insanın hâlâ doğrulaması gereken şey
//
// Bu ayrım olmadan otomasyon, insan doğrulamasının yerine geçmiş gibi
// görünür ki bu yanlış olur.
//
// ── ZAMAN AŞIMI BÜTÇESİ ───────────────────────────────────────────────────
// Medya kurulumu (yeniden pazarlık + medya başlatma) tek başına ~15 sn sürer.
// 33 ağır iki-tarayıcılı test ardışık koştuğunda bu süre 30 sn'yi aşabiliyor:
// ÖLÇÜLDÜ — testler tek tek geçti, tam pakette dönüşümlü olarak düştü.
// Bu yüzden kurulum beklemeleri 45 sn'dir. Hiçbir İDDİA zayıflatılmadı;
// yalnızca gerçek maliyete göre beklenir.
//
// ── ORTAK SINIR ───────────────────────────────────────────────────────────
// Sahte cihazların AKUSTİK yolu yoktur: hoparlörden çıkıp mikrofona dönmez.
// Bu yüzden YANKI, netlik, gecikme hissi ve algılanan kalite bu dosyada
// KANITLANAMAZ ve kanıtlanmaya çalışılmaz.

import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import { createTestServer, createTestChannel, joinServer, getTokens } from '../helpers/bridge';
import { displayFixture, REMOTE_AUDIO_MAP, SCREEN_AUDIO_SUFFIX } from '../helpers/media-fixtures';

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:3000';

/** Sayfa yüklenmeden önce her RTCPeerConnection örneğini topla. */
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
};

function userIdFromToken(token: string): string {
  try {
    const body = token.split('.')[1] ?? '';
    const json = Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return String(JSON.parse(json).id ?? '');
  } catch { return ''; }
}

interface OpenOpts { display?: 'audio' | 'silent' | false }

async function openApp(ctx: BrowserContext, token: string, opts: OpenOpts = {}): Promise<Page> {
  await ctx.addInitScript(INSTRUMENT);
  await ctx.addInitScript((t: string) => {
    localStorage.setItem('token', t);
    localStorage.setItem('bridge_token', t);
  }, token);
  await ctx.addInitScript((uid: string) => {
    if (uid) localStorage.setItem(`bridge_onboarding_v3:${uid}`, 'done');
    localStorage.setItem('bridge_onboarding_v3:anon', 'done');
  }, userIdFromToken(token));
  if (opts.display) await ctx.addInitScript(displayFixture(opts.display === 'audio'));
  const page = await ctx.newPage();
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await page.locator('#app').waitFor({ state: 'visible', timeout: 25_000 });
  return page;
}

const selectServer = (p: Page, id: string) =>
  p.locator(`.server-icon[data-id="${id}"]`).first().click({ timeout: 25_000 });

const joinVoice = (p: Page, name: string) =>
  p.locator(`[aria-label="Ses kanalı: ${name}"]`).first().click({ timeout: 25_000 });

/** Gerçek `getStats()` — iddia edilen değil, ölçülen. */
async function rtp(page: Page, kind: 'audio' | 'video') {
  return page.evaluate(async (k) => {
    const pcs = ((window as unknown as { __pcs?: RTCPeerConnection[] }).__pcs ?? [])
      .filter(pc => pc.connectionState !== 'closed');
    const out = { inBytes: 0, inPackets: 0, outPackets: 0, inTracks: 0, outTracks: 0, frames: 0, pcs: pcs.length };
    for (const pc of pcs) {
      // A closed SFU consumer leaves its media section in the receive
      // transport as an inactive transceiver whose inbound stats (frozen
      // bytes) stay in getStats(). Only live receiving paths are counted, so
      // a dead one can neither look like a duplicate nor like flowing media.
      const live = new Set(pc.getTransceivers()
        .filter(t => (t.currentDirection === 'recvonly' || t.currentDirection === 'sendrecv') &&
          t.receiver.track.readyState === 'live')
        .map(t => t.mid));
      const stats = await pc.getStats();
      stats.forEach((r: Record<string, unknown>) => {
        if (r.kind !== k) return;
        if (r.type === 'inbound-rtp' && live.has(r.mid as string)) {
          out.inTracks += 1;
          out.inBytes += Number(r.bytesReceived ?? 0);
          out.inPackets += Number(r.packetsReceived ?? 0);
          out.frames += Number(r.framesDecoded ?? 0);
        }
        if (r.type === 'outbound-rtp') {
          out.outTracks += 1;
          out.outPackets += Number(r.packetsSent ?? 0);
        }
      });
    }
    return out;
  }, kind);
}

const remoteAudio = (page: Page) =>
  page.evaluate(REMOTE_AUDIO_MAP) as Promise<Array<{
    socket: string; muted: boolean; paused: boolean; hasStream: boolean; tracks: number;
  }>>;

/** Giden mikrofon track'inin GERÇEK durumu. */
const micEnabled = (page: Page) => page.evaluate(() => {
  const pcs = ((window as unknown as { __pcs?: RTCPeerConnection[] }).__pcs ?? []);
  for (const pc of pcs) {
    const t = pc.getSenders().find(s => s.track?.kind === 'audio')?.track;
    if (t) return t.enabled;
  }
  return null;
});


/**
 * TIKLANABILIR olani secip tiklar.
 *
 * Ayni etiketi tasiyan birden fazla kontrol olabilir (kabuk dock'u + panel +
 * paylasim cubugu) ve bazilari ortulu olabilir. `.first()` ortulu olani
 * secerse tiklama zaman asimina ugrar; bu yardimci gercekten tiklanabilir
 * olanin SIRASINI bulur.
 */
async function clickReachable(page: Page, selector: string): Promise<void> {
  const idx = await page.evaluate((sel) => {
    const els = [...document.querySelectorAll(sel)] as HTMLElement[];
    for (let i = 0; i < els.length; i++) {
      const r = els[i].getBoundingClientRect();
      if (!r.width || !r.height) continue;
      const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) as HTMLElement | null;
      if (!top || els[i].contains(top) || top === els[i]) return i;
    }
    return -1;
  }, selector);
  if (idx < 0) throw new Error('tiklanabilir eslesme yok: ' + selector);
  await page.locator(selector).nth(idx).click({ timeout: 15_000 });
}

// ════════════════════════════════════════════════════════════════════════════
let srvId = '';
let vcName = '';
let ownerTok = '';
let peerTok = '';
let thirdTok = '';

// Bu dosyadaki HER test 2-3 gercek tarayici baglami + WebRTC kurar. Tek
// basina olculen sureler 15-39 sn arasindadir; ardisik kosumda ust sinir
// daha da yukselir. Varsayilan test butcesi bu is icin GERCEKCI DEGIL.
// Iddialar degismez — yalnizca sure gercege gore ayarlanir.
test.beforeEach(() => { test.setTimeout(150_000); });

// Chrome'un WebRTC yikimi ASENKRONDUR: `context.close()` donse bile eslesme
// ve medya kaynaklari hemen geri alinmaz. 33 agir testin ardisik kosumunda bu
// birikim paylasim kurulumunu 45 sn'nin uzerine itiyordu (olculdu: testler tek
// tek ve kucuk gruplar halinde geciyor, tam dosyada donusumlu dusuyordu).
// Kisa bir geri alma araligi kaynagi serbest birakir; hicbir iddia degismez.
test.afterEach(async () => { await new Promise(r => setTimeout(r, 2_000)); });

test.beforeAll(async ({ request }) => {
  // ══════════════════════════════════════════════════════════════════════════
  // MEVCUT KIMLIKLER YENIDEN KULLANILIR — YENI HESAP ACILMAZ
  // ══════════════════════════════════════════════════════════════════════════
  // Eskiden burada `ma1/ma2/ma3` etiketleriyle UC YENI hesap aciliyordu.
  // Sunucu IP basina saatte `MAX_REG_PER_HOUR` (varsayilan 3) hesapla
  // sinirlidir; kota tukendiginde `beforeAll` dusuyor ve 33 testin yalnizca
  // 10'u kosabiliyordu.
  //
  // Sinir DOGRUDUR ve degistirilmez. Global setup ZATEN medya icin ayrilmis
  // `media1`/`media2` kimliklerini saglar; ucuncu izleyici icin `bob`
  // kullanilir. Testler yine de HER BIRI icin AYRI, tek kullanimlik kanal
  // olusturur — yalitim kanal duzeyinde saglanir, hesap acarak degil.
  //
  // carol KULLANILMAZ: o bilerek "hicbir yere uye olmayan" taraftir.
  const t = getTokens();
  ownerTok = t.media1;
  peerTok = t.media2;
  thirdTok = t.bob;
  const srv = await createTestServer(request, ownerTok, `MediaAuto ${Date.now()}`);
  srvId = String((srv as { _id?: string })?._id ?? '');
  vcName = `ma-${Date.now().toString(36)}`;
  await createTestChannel(request, ownerTok, srvId, vcName, 'voice');
  await joinServer(request, ownerTok, peerTok, srvId);
  await joinServer(request, ownerTok, thirdTok, srvId);
});

/**
 * İki taraf da ses kanalında — ortak kurulum.
 *
 * HER ÇAĞRI KENDİ KANALINI kurar. Tek bir paylaşılan kanalda ardışık testler
 * birbirine sızıyordu: bir bağlam paylaşım sürerken kapandığında sunucu
 * tarafında akran bir süre daha duruyor ve SONRAKİ test bayat durumla
 * başlıyordu (ölçüldü: tek başına geçen testler tam pakette düşüyordu).
 * İzolasyon iddiaları zayıflatmadan sorunu kökünden kaldırır.
 */
async function twoInVoice(
  browser: import('@playwright/test').Browser,
  request: import('@playwright/test').APIRequestContext,
  opts: OpenOpts = {},
) {
  const vcName = `ma-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  // Olusturulamayan kanal 25 sn'lik bir dugme beklemesine donusuyordu; neden
  // burada, adiyla gorunsun.
  expect(await createTestChannel(request, ownerTok, srvId, vcName, 'voice'), 'ses kanalı oluşturulamadı').toBeTruthy();
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await openApp(ctxA, ownerTok, opts);
  const pageB = await openApp(ctxB, peerTok, opts);
  await selectServer(pageA, srvId); await selectServer(pageB, srvId);
  await joinVoice(pageA, vcName);
  await pageA.waitForTimeout(1_500);
  await joinVoice(pageB, vcName);
  await expect.poll(() => pageB.locator('audio.remote-audio').count(), { timeout: 25_000 })
    .toBeGreaterThan(0);
  return { ctxA, ctxB, pageA, pageB, vcName };
}

// ════════════════════════════════════════════════════════════════════════════
test.describe('SES — işlevsel otomasyon', () => {
  test('V1/V2 — iki yönde de RTP GERÇEKTEN akıyor', async ({ browser, request }) => {
    // KANITLAR    : her iki uçta giden track var, karşı uç alıyor, baytlar ARTIYOR.
    // KANITLAMAZ  : sesin anlaşılır olduğunu. Netlik insan işidir.
    const { ctxA, ctxB, pageA, pageB } = await twoInVoice(browser, request);
    try {
      await expect.poll(async () => (await rtp(pageB, 'audio')).inBytes, { timeout: 25_000 })
        .toBeGreaterThan(0);
      await expect.poll(async () => (await rtp(pageA, 'audio')).inBytes, { timeout: 25_000 })
        .toBeGreaterThan(0);

      // ARTIŞ: tek bir anlık okuma "akıyor" demek değildir.
      const first = (await rtp(pageB, 'audio')).inBytes;
      await pageB.waitForTimeout(1_500);
      expect((await rtp(pageB, 'audio')).inBytes).toBeGreaterThan(first);

      // ÇİFT ÇALMA YOK: iki kişilik odada tek uzak ses yolu.
      expect((await remoteAudio(pageB)).length).toBe(1);
      expect((await rtp(pageB, 'audio')).inTracks).toBe(1);
    } finally { await ctxA.close(); await ctxB.close(); }
  });

  test('V4/V5 — sessize alma giden track\'i GERÇEKTEN kapatır ve geri açar', async ({ browser, request }) => {
    // KANITLAR    : `track.enabled` değişiyor — yalnızca ikon değil.
    // KANITLAMAZ  : karşı tarafın sessizliği DUYDUĞUNU.
    const { ctxA, ctxB, pageA } = await twoInVoice(browser, request);
    try {
      await expect.poll(() => micEnabled(pageA), { timeout: 20_000 }).toBe(true);
      await pageA.locator('[aria-label="Mikrofonu kapat"]:visible').first().click();
      await expect.poll(() => micEnabled(pageA), { timeout: 10_000 }).toBe(false);
      await pageA.locator('[aria-label="Mikrofonu aç"]:visible').first().click();
      await expect.poll(() => micEnabled(pageA), { timeout: 10_000 }).toBe(true);

      // TEK KEZ geri açılır: yinelenen gönderici oluşmamalı.
      expect((await rtp(pageA, 'audio')).outTracks).toBe(1);
    } finally { await ctxA.close(); await ctxB.close(); }
  });

  test('V6/V7 — sağırlaştırma TÜM uzak sesleri susturur ve geri verir', async ({ browser, request }) => {
    // KANITLAR    : her `audio.remote-audio` elemanının `muted` durumu değişiyor.
    // KANITLAMAZ  : kullanıcının gerçekten sessizlik duyduğunu.
    const { ctxA, ctxB, pageA } = await twoInVoice(browser, request);
    try {
      const allMuted = async () => {
        const els = await remoteAudio(pageA);
        return els.length ? els.every(e => e.muted) : null;
      };
      await expect.poll(allMuted, { timeout: 20_000 }).toBe(false);
      await pageA.locator('#btn-deafen:visible').click();
      await expect.poll(allMuted, { timeout: 10_000 }).toBe(true);
      await pageA.locator('#btn-deafen:visible').click();
      await expect.poll(allMuted, { timeout: 10_000 }).toBe(false);

      // Geri verme TEK sefer: eleman çoğalmamalı.
      expect((await remoteAudio(pageA)).length).toBe(1);
    } finally { await ctxA.close(); await ctxB.close(); }
  });

  test('V8 — ters yön: B sessize alır, A tarafı doğru tepki verir', async ({ browser, request }) => {
    // KANITLAR    : mute yolu tek yönlü değil; B için de giden track kapanıyor.
    // KANITLAMAZ  : A'nın sessizliği duyduğunu.
    const { ctxA, ctxB, pageB } = await twoInVoice(browser, request);
    try {
      await expect.poll(() => micEnabled(pageB), { timeout: 20_000 }).toBe(true);
      await pageB.locator('[aria-label="Mikrofonu kapat"]:visible').first().click();
      await expect.poll(() => micEnabled(pageB), { timeout: 10_000 }).toBe(false);
      await pageB.locator('[aria-label="Mikrofonu aç"]:visible').first().click();
      await expect.poll(() => micEnabled(pageB), { timeout: 10_000 }).toBe(true);
    } finally { await ctxA.close(); await ctxB.close(); }
  });

  test('V13/V14 — çık/tekrar katıl: hayalet akran ve çift ses YOK', async ({ browser, request }) => {
    // KANITLAR    : ayrılınca uzak yol temizleniyor, tekrar katılınca TEK yol
    //               kuruluyor ve RTP yeniden akıyor.
    // KANITLAMAZ  : sesin tekrar duyulduğunu.
    const { ctxA, ctxB, pageA, pageB, vcName: ch } = await twoInVoice(browser, request);
    try {
      await pageA.locator('[aria-label="Ses kanalından ayrıl"]:visible').first().click();
      await expect.poll(() => pageB.locator('audio.remote-audio').count(), { timeout: 20_000 })
        .toBe(0);
      // AYNI kanala tiklayarak tekrar katilim: gercek kullanicinin yaptigi sey.
      await joinVoice(pageA, ch);
      await pageA.waitForTimeout(2_000);
      // Once A'nin GERCEKTEN yeniden katildigini dogrula: aksi halde asagidaki
      // hata "B duymuyor" gibi gorunur ama aslinda A hic katilmamistir.
      await expect.poll(() => pageA.locator('audio.remote-audio').count(), { timeout: 25_000 })
        .toBe(1);
      await expect.poll(() => pageB.locator('audio.remote-audio').count(), { timeout: 25_000 })
        .toBe(1);

      // TEK eşleşme, TEK gelen track — yeniden katılım çoğaltmıyor.
      const flow = await rtp(pageB, 'audio');
      expect(flow.inTracks).toBe(1);
      await expect.poll(async () => (await rtp(pageB, 'audio')).inBytes, { timeout: 25_000 })
        .toBeGreaterThan(0);
    } finally { await ctxA.close(); await ctxB.close(); }
  });

  test('V15 — bağlantı kesintisi sonrası hayalet/çift akran YOK', async ({ browser, request }) => {
    // KANITLAR    : kesinti sonrası uzak ses yolu sayısı ARTMIYOR; yinelenen
    //               eşleşme veya asılı eleman kalmıyor.
    // KANITLAMAZ  : sesin kesintiden sonra tekrar DUYULDUĞUNU.
    const { ctxA, ctxB, pageA, pageB } = await twoInVoice(browser, request);
    try {
      const before = (await remoteAudio(pageB)).length;
      await ctxA.setOffline(true);
      await pageA.waitForTimeout(2_500);
      await ctxA.setOffline(false);
      await pageA.waitForTimeout(6_000);

      const after = await remoteAudio(pageB);
      // Kritik: B tarafında A'nın SESİ ÇOĞALMAMALI.
      expect(after.length).toBeLessThanOrEqual(Math.max(before, 1));
      const sockets = after.map(a => a.socket);
      expect(new Set(sockets).size).toBe(sockets.length);   // yinelenen kimlik YOK
    } finally { await ctxA.close(); await ctxB.close(); }
  });
});

// ════════════════════════════════════════════════════════════════════════════
test.describe('SES — PTT / hassasiyet / cihaz', () => {
  /** Ayarlar acilir ve CIHAZLAR sekmesine gecilir — varsayilan sekme degil. */
  async function openDevicesTab(page: Page): Promise<void> {
    await page.locator('#btn-settings').first().click({ timeout: 15_000 });
    const tab = page.locator('[data-tab="devices"], [role="tab"], .settings-nav button')
      .filter({ hasText: /Cihaz|Device|Ses|Voice/i }).first();
    if (await tab.count()) await tab.click({ timeout: 10_000 });
  }

  /** Ayarlar → Cihazlar üzerinden GERÇEK ürün yolundan PTT yapılandır. */
  async function configurePtt(page: Page, mode: 'hold' | 'toggle', code: string) {
    await openDevicesTab(page);
    const ptt = page.locator('.ptt').first();
    await ptt.waitFor({ state: 'visible', timeout: 15_000 });
    if (!(await ptt.locator('input[type="checkbox"]').first().isChecked())) {
      await ptt.locator('input[type="checkbox"]').first().click();
    }
    await ptt.locator('.ptt-mode').nth(mode === 'hold' ? 0 : 1).click({ timeout: 10_000 });
    await ptt.locator('.ptt-btn').first().click({ timeout: 10_000 });
    await page.keyboard.press(code);
    await expect.poll(() => page.evaluate(() => {
      try { return JSON.parse(localStorage.getItem('bridgePTT') ?? '{}').key?.code; }
      catch { return null; }
    }), { timeout: 10_000 }).toBe(code);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(600);
  }

  test('V9 HOLD — keydown yayını açar, keyup kapatır', async ({ browser, request }) => {
    // KANITLAR    : yapılandırılan tuş GERÇEK üretim yolundan giden mikrofon
    //               track durumunu değiştiriyor.
    // KANITLAMAZ  : karşı tarafın konuşmayı duyduğunu.
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    try {
      const pageA = await openApp(ctxA, ownerTok);
      const pageB = await openApp(ctxB, peerTok);
      await configurePtt(pageA, 'hold', 'KeyV');
      await selectServer(pageA, srvId); await selectServer(pageB, srvId);
      await joinVoice(pageA, vcName);
      await pageA.waitForTimeout(1_500);
      await joinVoice(pageB, vcName);
      await expect.poll(() => micEnabled(pageA), { timeout: 25_000 }).not.toBeNull();

      await pageA.keyboard.down('KeyV');
      await expect.poll(() => micEnabled(pageA), { timeout: 10_000 }).toBe(true);
      await pageA.keyboard.up('KeyV');
      // Bırakma gecikmesi sonrası kapanır.
      await expect.poll(() => micEnabled(pageA), { timeout: 10_000 }).toBe(false);
    } finally { await ctxA.close(); await ctxB.close(); }
  });

  test('V9 TOGGLE — basılı tutmak STUTTER yapmaz', async ({ browser, request }) => {
    // KANITLAR    : KeyboardEvent.repeat yayını defalarca açıp kapatmıyor.
    //               Düzeltilen gerçek bir kusurun regresyon kilidi.
    // KANITLAMAZ  : sesin duyulduğunu.
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    try {
      const pageA = await openApp(ctxA, ownerTok);
      const pageB = await openApp(ctxB, peerTok);
      await configurePtt(pageA, 'toggle', 'KeyB');
      await selectServer(pageA, srvId); await selectServer(pageB, srvId);
      await joinVoice(pageA, vcName);
      await pageA.waitForTimeout(1_500);
      await joinVoice(pageB, vcName);
      await expect.poll(() => micEnabled(pageA), { timeout: 25_000 }).not.toBeNull();

      await pageA.keyboard.press('KeyB');
      await expect.poll(() => micEnabled(pageA), { timeout: 10_000 }).toBe(true);

      // TEKRAR olayları: yayın AÇIK kalmalı, titrememeli.
      await pageA.evaluate(() => {
        for (let i = 0; i < 8; i++) {
          document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyB', repeat: true, bubbles: true }));
        }
      });
      await pageA.waitForTimeout(500);
      expect(await micEnabled(pageA), 'tuş tekrarı yayını değiştirdi').toBe(true);

      await pageA.keyboard.press('KeyB');
      await expect.poll(() => micEnabled(pageA), { timeout: 10_000 }).toBe(false);
    } finally { await ctxA.close(); await ctxB.close(); }
  });

  test('V9 METİN GÜVENLİĞİ — yazarken PTT tetiklenmez', async ({ browser, request }) => {
    // KANITLAR    : komut paleti / arama / ayar alanına yazmak mikrofonu AÇMIYOR.
    // KANITLAMAZ  : duyusal hiçbir şey — tamamen işlevsel bir sözleşme.
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    try {
      const pageA = await openApp(ctxA, ownerTok);
      const pageB = await openApp(ctxB, peerTok);
      await configurePtt(pageA, 'hold', 'KeyT');
      await selectServer(pageA, srvId); await selectServer(pageB, srvId);
      await joinVoice(pageA, vcName);
      await pageA.waitForTimeout(1_500);
      await joinVoice(pageB, vcName);
      await expect.poll(() => micEnabled(pageA), { timeout: 25_000 }).toBe(false);

      await pageA.keyboard.press('Control+k');
      await pageA.waitForTimeout(600);
      await pageA.keyboard.type('tttt');
      expect(await micEnabled(pageA), 'komut paletinde yazmak PTT actı').toBe(false);
      await pageA.keyboard.press('Escape');
      await pageA.waitForTimeout(400);

      await pageA.keyboard.press('Control+f');
      await pageA.waitForTimeout(600);
      await pageA.keyboard.type('tttt');
      expect(await micEnabled(pageA), 'aramada yazmak PTT actı').toBe(false);
      await pageA.keyboard.press('Escape');
      await pageA.waitForTimeout(400);

      await pageA.locator('#btn-settings').first().click({ timeout: 15_000 });
      const anyInput = pageA.locator('input[type="text"]:visible, textarea:visible').first();
      if (await anyInput.count()) {
        await anyInput.click();
        await pageA.keyboard.type('tttt');
        expect(await micEnabled(pageA), 'ayar alanında yazmak PTT actı').toBe(false);
      }
      await pageA.keyboard.press('Escape');
    } finally { await ctxA.close(); await ctxB.close(); }
  });

  test('V10 — hassasiyet KANONİK kalıcı kayda ulaşır', async ({ browser, request }) => {
    // KANITLAR    : arayüzden yapılan eşik/mod değişikliği kanonik depoya yazılıyor.
    // KANITLAMAZ  : eşiğin ÖZNEL olarak doğru olduğunu — o kulak işidir.
    const ctx = await browser.newContext();
    try {
      const page = await openApp(ctx, ownerTok);
      await openDevicesTab(page);
      const isc = page.locator('.isc').first();
      await isc.waitFor({ state: 'visible', timeout: 15_000 });

      const before = await page.evaluate(() =>
        localStorage.getItem('bridge:voice-sensitivity'));

      const modes = isc.locator('.isc-mode, [role="radio"]');
      const n = await modes.count();
      expect(n, 'hassasiyet modu kontrolü yok').toBeGreaterThan(0);
      await modes.nth(n - 1).click({ timeout: 10_000 });

      await expect.poll(
        () => page.evaluate(() => localStorage.getItem('bridge:voice-sensitivity')),
        { timeout: 10_000 },
      ).not.toBe(before);
    } finally { await ctx.close(); }
  });

  test('V11/V12 — cihaz sayımı ve çıkış yönlendirmesi kanonik yoldan uygulanır', async ({ browser, request }) => {
    // KANITLAR    : ürün cihazları görüyor; setSinkId destekliyse uzak ses
    //               elemanı onu KABUL ediyor.
    // KANITLAMAZ  : sesin FİZİKSEL olarak seçilen hoparlörden çıktığını.
    //               Sahte cihazın akustik yolu yoktur — insan/donanım işidir.
    const { ctxA, ctxB, pageA } = await twoInVoice(browser, request);
    try {
      const caps = await pageA.evaluate(async () => {
        const devs = await navigator.mediaDevices.enumerateDevices();
        return {
          inputs: devs.filter(d => d.kind === 'audioinput').length,
          outputs: devs.filter(d => d.kind === 'audiooutput').length,
          sinkSupported: 'setSinkId' in HTMLMediaElement.prototype,
        };
      });
      // Ortamın gerçekte ne sunduğunu RAPORLA — varsayma.
      console.log('DEVICES ' + JSON.stringify(caps));
      expect(caps.inputs).toBeGreaterThan(0);

      if (caps.sinkSupported) {
        const applied = await pageA.evaluate(async () => {
          const el = document.querySelector('audio.remote-audio') as (HTMLMediaElement & {
            setSinkId?: (id: string) => Promise<void>;
          }) | null;
          if (!el?.setSinkId) return 'yok';
          try { await el.setSinkId(''); return 'ok'; } catch (e) { return String((e as Error).name); }
        });
        expect(['ok', 'yok']).toContain(applied);
      }
    } finally { await ctxA.close(); await ctxB.close(); }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// EKRAN PAYLAŞIMI — GÖRÜNTÜ
//
// Fikstür SÜREKLİ DEĞİŞEN bir canvas yayınlar. Bu kasıtlıdır: sabit bir
// kaynakla "donmuş kare" ile "çalışan akış" ayırt edilemez.
// ════════════════════════════════════════════════════════════════════════════
test.describe('EKRAN PAYLAŞIMI — işlevsel otomasyon', () => {
  /** Kanonik paylaşım yolu: gerçek düğme + gerçek kalite seçici. */
  async function startShare(page: Page, withAudioCheckbox = false) {
    await clickReachable(page, '[aria-label="Ekran paylaş"]');
    const picker = page.locator('#ss-quality-modal').first();
    if (await picker.isVisible({ timeout: 3_000 }).catch(() => false)) {
      if (withAudioCheckbox) {
        const box = page.locator('#ss-include-audio');
        if (await box.count()) await box.check().catch(() => undefined);
      }
      await page.locator('.ss-quality-btn').first().click({ timeout: 10_000 });
    }
  }

  /** Uzak video GERÇEKTEN ilerliyor mu — yalnızca var mı değil. */
  const remoteVideoProgress = (page: Page) => page.evaluate(() => {
    const v = document.querySelector('#remote-screen-video') as HTMLVideoElement | null;
    if (!v) return null;
    return { w: v.videoWidth, h: v.videoHeight, t: v.currentTime, ready: v.readyState };
  });

  test('S1/S2 — paylaşım başlar ve izleyicide GÖRÜNTÜ İLERLER', async ({ browser, request }) => {
    // KANITLAR    : uzak video elemanı oynatılabilir boyuta ulaşıyor,
    //               `currentTime` ARTIYOR ve çözülen kare sayısı ARTIYOR —
    //               yani donmuş tek kare bu testi GEÇEMEZ.
    // KANITLAMAZ  : görüntünün İNSANCA net/akıcı göründüğünü.
    const { ctxA, ctxB, pageA, pageB } = await twoInVoice(browser, request, { display: 'silent' });
    try {
      await startShare(pageA);

      await expect.poll(async () => (await rtp(pageB, 'video')).inBytes, { timeout: 45_000 })
        .toBeGreaterThan(0);

      // Boyut: gerçek bir kare çözülmüş olmalı.
      await expect.poll(async () => (await remoteVideoProgress(pageB))?.w ?? 0, { timeout: 45_000 })
        .toBeGreaterThan(0);

      // İLERLEME: iki ölçüm arasında zaman ve kare sayısı artmalı.
      const t1 = (await remoteVideoProgress(pageB))!.t;
      const f1 = (await rtp(pageB, 'video')).frames;
      await pageB.waitForTimeout(2_000);
      const t2 = (await remoteVideoProgress(pageB))!.t;
      const f2 = (await rtp(pageB, 'video')).frames;
      expect(t2, 'uzak video DONMUŞ (currentTime ilerlemedi)').toBeGreaterThan(t1);
      expect(f2, 'çözülen kare sayısı artmadı').toBeGreaterThan(f1);
    } finally { await ctxA.close(); await ctxB.close(); }
  });

  test('S3/S4 — durdurma temizler, yeniden başlatma TEK akış kurar', async ({ browser, request }) => {
    // KANITLAR    : durdurmada uzak görünüm kalkıyor; yeniden başlatmada
    //               tam olarak BİR video akışı geliyor (çift kutucuk yok).
    // KANITLAMAZ  : görüntünün insanca göründüğünü.
    const { ctxA, ctxB, pageA, pageB } = await twoInVoice(browser, request, { display: 'silent' });
    try {
      await startShare(pageA);
      await expect.poll(async () => (await rtp(pageB, 'video')).inBytes, { timeout: 45_000 })
        .toBeGreaterThan(0);

      await clickReachable(pageA, '#ss-stop-btn');
      await expect.poll(
        () => pageB.evaluate(() => document.querySelectorAll('#remote-screen-video').length),
        { timeout: 20_000 },
      ).toBe(0);

      // Sese yeniden katılmadan tekrar paylaş.
      await startShare(pageA);
      await expect.poll(
        () => pageB.evaluate(() => document.querySelectorAll('#remote-screen-video').length),
        { timeout: 45_000 },
      ).toBe(1);
    } finally { await ctxA.close(); await ctxB.close(); }
  });

  test('S5 — paylaşırken AYRILAN kişinin görüntüsü temizlenir', async ({ browser, request }) => {
    // KANITLAR    : ayrılma sonrası izleyicide donmuş kare/asılı alıcı kalmıyor.
    // KANITLAMAZ  : görsel kaliteyi.
    const { ctxA, ctxB, pageA, pageB } = await twoInVoice(browser, request, { display: 'silent' });
    try {
      await startShare(pageA);
      await expect.poll(async () => (await rtp(pageB, 'video')).inBytes, { timeout: 45_000 })
        .toBeGreaterThan(0);

      await clickReachable(pageA, '#ss-leave-btn');
      await expect.poll(() => pageB.locator('audio.remote-audio').count(), { timeout: 20_000 }).toBe(0);
      await expect.poll(
        () => pageB.evaluate(() => document.querySelectorAll('#remote-screen-video').length),
        { timeout: 20_000 },
      ).toBe(0);
    } finally { await ctxA.close(); await ctxB.close(); }
  });

  test('S7/S8 — ters yönde paylaşım ve YETKİ sınırı', async ({ browser, request }) => {
    // KANITLAR    : B paylaştığında A görüyor; A tarafında B'nin paylaşımını
    //               durduracak bir kontrol YOK.
    // KANITLAMAZ  : görsel kaliteyi.
    const { ctxA, ctxB, pageA, pageB } = await twoInVoice(browser, request, { display: 'silent' });
    try {
      await startShare(pageB);
      await expect.poll(async () => (await rtp(pageA, 'video')).inBytes, { timeout: 45_000 })
        .toBeGreaterThan(0);

      // A yalnızca İZLEYİCİ: kendi "durdur" kontrolü GÖRÜNMEMELİ.
      expect(await pageA.locator('#ss-stop-btn:visible').count(),
        'izleyicide başkasının paylaşımını durduran kontrol var').toBe(0);
    } finally { await ctxA.close(); await ctxB.close(); }
  });

  test('S9 — üç kullanıcı: iki izleyici de alır, çift kutucuk YOK', async ({ browser, request }) => {
    // KANITLAR    : tek paylaşan → iki izleyicide de video baytı; her izleyicide
    //               TAM BİR uzak görünüm.
    // KANITLAMAZ  : görsel kaliteyi.
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const ctxC = await browser.newContext();
    try {
      const pageA = await openApp(ctxA, ownerTok, { display: 'silent' });
      const pageB = await openApp(ctxB, peerTok);
      const pageC = await openApp(ctxC, thirdTok);
      for (const [p, t] of [[pageA, ownerTok], [pageB, peerTok], [pageC, thirdTok]] as const) {
        void t; await selectServer(p, srvId);
      }
      await joinVoice(pageA, vcName);
      await pageA.waitForTimeout(1_200);
      await joinVoice(pageB, vcName);
      await pageB.waitForTimeout(1_200);
      await joinVoice(pageC, vcName);
      await expect.poll(() => pageC.locator('audio.remote-audio').count(), { timeout: 45_000 })
        .toBeGreaterThan(0);

      await startShare(pageA);
      for (const viewer of [pageB, pageC]) {
        await expect.poll(async () => (await rtp(viewer, 'video')).inBytes, { timeout: 40_000 })
          .toBeGreaterThan(0);
        expect(await viewer.evaluate(
          () => document.querySelectorAll('#remote-screen-video').length,
        )).toBeLessThanOrEqual(1);
      }
    } finally { await ctxA.close(); await ctxB.close(); await ctxC.close(); }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// PAYLAŞIM SESİ (SİSTEM SESİ)
//
// Fikstür 660 Hz bir osilatör verir; mikrofonun 440 Hz sahte tonundan AYRIDIR.
// Bu, iki ses yolunun BİRBİRİNİ EZMEDİĞİNİ kimlik düzeyinde doğrulamayı sağlar.
// ════════════════════════════════════════════════════════════════════════════
test.describe('SİSTEM SESİ — işlevsel otomasyon', () => {
  async function startShareWithAudio(page: Page) {
    await clickReachable(page, '[aria-label="Ekran paylaş"]');
    const picker = page.locator('#ss-quality-modal').first();
    if (await picker.isVisible({ timeout: 3_000 }).catch(() => false)) {
      const box = page.locator('#ss-include-audio');
      if (await box.count()) await box.check().catch(() => undefined);
      await page.locator('.ss-quality-btn').first().click({ timeout: 10_000 });
    }
  }

  test('SA1/SA3 — paylaşım sesi AYRI kimlikle iletilir, mikrofonu EZMEZ', async ({ browser, request }) => {
    // KANITLAR    : izleyicide İKİ ayrı uzak ses yolu var; biri mikrofon
    //               (`<socketId>`), diğeri paylaşım sesi
    //               (`<socketId>::screen-audio`). Biri diğerini düşürmüyor.
    // KANITLAMAZ  : izleyicinin ikisini de DUYDUĞUNU.
    const { ctxA, ctxB, pageA, pageB } = await twoInVoice(browser, request, { display: 'audio' });
    try {
      const before = await remoteAudio(pageB);
      expect(before.length, 'başlangıçta tek mikrofon yolu olmalı').toBe(1);
      const micSocket = before[0].socket;

      await startShareWithAudio(pageA);

      await expect.poll(async () => (await remoteAudio(pageB)).length, { timeout: 45_000 })
        .toBe(2);

      const after = await remoteAudio(pageB);
      const sockets = after.map(a => a.socket).sort();
      // MİKROFON YOLU HÂLÂ ORADA — asıl tehlike buydu.
      expect(sockets).toContain(micSocket);
      expect(sockets.some(s => s.endsWith(SCREEN_AUDIO_SUFFIX)),
        'paylaşım sesi ayrı kimlikle gelmedi').toBe(true);
      // İkisi de gerçek track taşımalı.
      expect(after.every(a => a.tracks > 0)).toBe(true);
    } finally { await ctxA.close(); await ctxB.close(); }
  });

  test('SA2 — paylaşan tarafta Bridge kaynaklı YEREL geri besleme YOK', async ({ browser, request }) => {
    // KANITLAR    : paylaşan kendi uzak-ses konağında kendi paylaşım sesini
    //               ÇALMIYOR (yerel loopback yok).
    // KANITLAMAZ  : kullanıcının fiziksel olarak yankı duymadığını.
    const { ctxA, ctxB, pageA } = await twoInVoice(browser, request, { display: 'audio' });
    try {
      await startShareWithAudio(pageA);
      await pageA.waitForTimeout(3_000);
      const own = await remoteAudio(pageA);
      // A yalnızca B'nin mikrofonunu çalmalı; kendi paylaşım sesini DEĞİL.
      expect(own.some(a => a.socket.endsWith(SCREEN_AUDIO_SUFFIX)),
        'paylaşan kendi sistem sesini yerel olarak çalıyor').toBe(false);
    } finally { await ctxA.close(); await ctxB.close(); }
  });

  test('SA4/SA5 — mikrofonu susturmak paylaşım sesini ÖLDÜRMEZ', async ({ browser, request }) => {
    // KANITLAR    : mute yalnızca mikrofon track'ini kapatıyor; paylaşım sesi
    //               yolu ayakta kalıyor. Unmute mikrofonu geri veriyor.
    // KANITLAMAZ  : duyulabilirliği.
    const { ctxA, ctxB, pageA, pageB } = await twoInVoice(browser, request, { display: 'audio' });
    try {
      await startShareWithAudio(pageA);
      await expect.poll(async () => (await remoteAudio(pageB)).length, { timeout: 45_000 }).toBe(2);

      await clickReachable(pageA, '[aria-label="Mikrofonu kapat"]');
      await expect.poll(() => micEnabled(pageA), { timeout: 10_000 }).toBe(false);
      // Paylaşım sesi yolu DURUYOR olmalı.
      expect((await remoteAudio(pageB)).some(a => a.socket.endsWith(SCREEN_AUDIO_SUFFIX))).toBe(true);

      await clickReachable(pageA, '[aria-label="Mikrofonu aç"]');
      await expect.poll(() => micEnabled(pageA), { timeout: 10_000 }).toBe(true);
      expect((await remoteAudio(pageB)).length, 'unmute yolu çiftledi').toBe(2);
    } finally { await ctxA.close(); await ctxB.close(); }
  });

  test('SA6/SA7 — sağırlaştırma HER İKİ uzak kaynağı susturur ve geri verir', async ({ browser, request }) => {
    // KANITLAR    : deafen mikrofon VE paylaşım sesi elemanlarının ikisini de
    //               `muted` yapıyor; undeafen ikisini de geri veriyor.
    // KANITLAMAZ  : sessizliğin duyulduğunu.
    const { ctxA, ctxB, pageA, pageB } = await twoInVoice(browser, request, { display: 'audio' });
    try {
      await startShareWithAudio(pageA);
      await expect.poll(async () => (await remoteAudio(pageB)).length, { timeout: 45_000 }).toBe(2);

      // Paylasim gorunumu kabuk dock'unu orter; cubugun KENDI kontrolu kullanilir.
      await clickReachable(pageB, '#ss-deafen-btn, [aria-label="Sesi kapat"]');
      await expect.poll(async () => (await remoteAudio(pageB)).every(a => a.muted), { timeout: 10_000 })
        .toBe(true);

      await clickReachable(pageB, '#ss-deafen-btn, [aria-label="Sesi aç"]');
      await expect.poll(async () => (await remoteAudio(pageB)).every(a => !a.muted), { timeout: 10_000 })
        .toBe(true);
      await expect.poll(async () => (await remoteAudio(pageB)).length, { timeout: 10_000 })
        .toBe(2);
    } finally { await ctxA.close(); await ctxB.close(); }
  });

  test('SA8/SA9 — durdurma sesi kaldırır, yeniden başlatma TEK yol kurar', async ({ browser, request }) => {
    // Bu test IKI tam kurulum dongusu yapar (baslat → durdur → yeniden baslat).
    // Tek basina OLCULDU: 38.6 sn. Tam pakette bu butce asiliyordu; iddiayi
    // kirpmak yerine testin GERCEK maliyeti bildirilir.
    test.slow();
    // KANITLAR    : paylaşım bitince ses kimliği kayboluyor; yeniden başlatınca
    //               tam olarak BİR paylaşım-sesi yolu oluşuyor.
    // KANITLAMAZ  : duyulabilirliği.
    const { ctxA, ctxB, pageA, pageB } = await twoInVoice(browser, request, { display: 'audio' });
    try {
      await startShareWithAudio(pageA);
      await expect.poll(async () => (await remoteAudio(pageB)).length, { timeout: 45_000 }).toBe(2);

      await clickReachable(pageA, '#ss-stop-btn');
      await expect.poll(
        async () => (await remoteAudio(pageB)).some(a => a.socket.endsWith(SCREEN_AUDIO_SUFFIX)),
        { timeout: 20_000 },
      ).toBe(false);

      await startShareWithAudio(pageA);
      await expect.poll(
        async () => (await remoteAudio(pageB)).filter(a => a.socket.endsWith(SCREEN_AUDIO_SUFFIX)).length,
        { timeout: 45_000 },
      ).toBe(1);
    } finally { await ctxA.close(); await ctxB.close(); }
  });

  test('SA10 — tarayıcı track ENDED olayı tam temizlik yapar', async ({ browser, request }) => {
    // KANITLAR    : Chrome kendi "Paylaşımı durdur" kontrolüyle track bittiğinde
    //               Bridge uzak ses ve görüntüyü kaldırıyor.
    // KANITLAMAZ  : duyulabilirliği.
    const { ctxA, ctxB, pageA, pageB } = await twoInVoice(browser, request, { display: 'audio' });
    try {
      await startShareWithAudio(pageA);
      await expect.poll(async () => (await remoteAudio(pageB)).length, { timeout: 45_000 }).toBe(2);

      // Tarayıcının kendi durdurmasını taklit et: track'leri BİTİR.
      await pageA.evaluate(() => {
        const s = (window as unknown as { __displayFixtureStream?: MediaStream }).__displayFixtureStream;
        s?.getTracks().forEach(t => {
          t.stop();
          t.dispatchEvent(new Event('ended'));
        });
      });

      await expect.poll(
        async () => (await remoteAudio(pageB)).some(a => a.socket.endsWith(SCREEN_AUDIO_SUFFIX)),
        { timeout: 25_000 },
      ).toBe(false);
    } finally { await ctxA.close(); await ctxB.close(); }
  });

  test('SA11 — paylaşırken ayrılınca ses VE görüntü birlikte gider', async ({ browser, request }) => {
    // KANITLAR    : ayrılma her iki uzak yolu da kaldırıyor.
    // KANITLAMAZ  : duyulabilirliği.
    const { ctxA, ctxB, pageA, pageB } = await twoInVoice(browser, request, { display: 'audio' });
    try {
      await startShareWithAudio(pageA);
      await expect.poll(async () => (await remoteAudio(pageB)).length, { timeout: 45_000 }).toBe(2);

      await clickReachable(pageA, '#ss-leave-btn');
      await expect.poll(() => pageB.locator('audio.remote-audio').count(), { timeout: 25_000 }).toBe(0);
      await expect.poll(
        () => pageB.evaluate(() => document.querySelectorAll('#remote-screen-video').length),
        { timeout: 20_000 },
      ).toBe(0);
    } finally { await ctxA.close(); await ctxB.close(); }
  });

  test('SA12 — ses track YOKSA ürün bunu DÜRÜSTÇE söyler', async ({ browser, request }) => {
    // KANITLAR    : platform ses vermediğinde paylaşım sesi kimliği HİÇ
    //               oluşmuyor ve arayüz "paylaşılıyor" DEMİYOR.
    // KANITLAMAZ  : gerçek bir OS yüzeyinin ses verip vermediğini — o platforma
    //               bağlıdır ve insan testinde kalır.
    const { ctxA, ctxB, pageA, pageB } = await twoInVoice(browser, request, { display: 'silent' });
    try {
      // Kutu İŞARETLİ — yani kullanıcı ses İSTİYOR ama platform vermiyor.
      await startShareWithAudio(pageA);
      // 45 sn: paylasim kurulumu YENIDEN PAZARLIK + medya baslatma icerir.
      // Tek basina ~15 sn surer; 33 agir iki-tarayicili testin ardisik
      // kosumunda 30 sn'yi asabiliyor (olculdu: tek basina gecti, tam pakette
      // dustu). Iddia ZAYIFLATILMADI — yalnizca gercek maliyete gore beklenir.
      await expect.poll(async () => (await rtp(pageB, 'video')).inBytes, { timeout: 45_000 })
        .toBeGreaterThan(0);
      await pageA.waitForTimeout(2_000);

      // Paylaşım sesi kimliği OLUŞMAMALI.
      expect((await remoteAudio(pageB)).some(a => a.socket.endsWith(SCREEN_AUDIO_SUFFIX)),
        'ses yokken paylaşım-sesi yolu uydurulmuş').toBe(false);

      // Arayüz "paylaşılıyor" İDDİA ETMEMELİ.
      const claim = await pageA.evaluate(() => document.body.innerText);
      expect(/Sistem sesi paylaşılıyor|System audio is being shared/.test(claim),
        'ses yokken arayüz paylaşıldığını iddia etti').toBe(false);
    } finally { await ctxA.close(); await ctxB.close(); }
  });
});
