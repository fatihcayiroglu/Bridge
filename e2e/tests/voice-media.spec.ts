// e2e/tests/voice-media.spec.ts
//
// İKİ GERÇEK TARAYICI ARASINDA GERÇEK SES AKIŞI
//
// ════════════════════════════════════════════════════════════════════════════
// NEDEN VAR
// ════════════════════════════════════════════════════════════════════════════
// Ses doğrulaması "insan gerekir" diye tamamen açık bırakılmıştı ve insan
// testi üç kez boş döndü. Oysa o formun BİRÇOK satırı makineyle
// ölçülebilir — yalnızca *kalite* yargısı kulak ister:
//
//   makineyle ölçülebilir : A→B ses AKIYOR mu, B→A akıyor mu, çift çalma var
//                           mı, eşleşme sayısı, mute gerçekten susturuyor mu,
//                           deafen uzak sesi kesiyor mu, çık/tekrar katıl
//   yalnızca kulakla      : yankı ŞİDDETİ, bozulma, gecikme hissi, ses seviyesi
//
// Bu paket birinci kümeyi kapatır. `voice.spec.ts` yalnızca API ve SİNYALLEŞME
// sınıyordu — hiçbir test iki tarayıcı arasında MEDYA aktığını kanıtlamıyordu.
//
// ── ÖLÇÜM YÖNTEMİ ─────────────────────────────────────────────────────────
// Chromium'un sahte medya cihazı (`--use-fake-device-for-media-stream`) 440 Hz
// bir ton üretir. `RTCPeerConnection` sayfa yüklenmeden ÖNCE sarmalanır ve
// üretilen tüm örnekler toplanır; sonra `getStats()` okunur.
//
// Uygulama kodu DEĞİŞTİRİLMEZ: sarmalama yalnızca test bağlamındadır ve
// gerçek üretim `RTCPeerConnection`larını ölçer.
//
// ── BU TESTİN KANITLAMADIĞI ───────────────────────────────────────────────
// Sahte cihazın AKUSTİK yolu yoktur: hoparlörden çıkıp mikrofona geri
// dönmez. Dolayısıyla YANKI bu testle ölçülemez. Yankı ve ses kalitesi
// insan doğrulamasında kalır (docs/VOICE_HUMAN_VERIFICATION.md).

import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import { createTestServer, createTestChannel, joinServer, getTokens } from '../helpers/bridge';

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

interface AudioFlow {
  pcCount: number;
  openPcCount: number;
  /** Open connections carry only one-way transceivers: SFU send/receive transports, not P2P pairings. */
  sfuTransports: boolean;
  packetsSent: number;
  packetsReceived: number;
  bytesReceived: number;
  inboundAudioTracks: number;
  outboundAudioTracks: number;
}

/** Gerçek `getStats()` okumaları — iddia edilen değil, ölçülen. */
async function readAudioFlow(page: Page): Promise<AudioFlow> {
  return page.evaluate(async () => {
    const pcs = ((window as unknown as { __pcs?: RTCPeerConnection[] }).__pcs ?? []);
    const open = pcs.filter(pc => pc.connectionState !== 'closed');
    const out: AudioFlow = {
      pcCount: pcs.length, openPcCount: open.length,
      // P2P pairs carry `sendrecv` transceivers; mediasoup transports only
      // `sendonly` (send) or `recvonly` (receive) ones.
      sfuTransports: open.length > 0 && open.every(pc => pc.getTransceivers().every(t => t.direction !== 'sendrecv')),
      packetsSent: 0, packetsReceived: 0, bytesReceived: 0,
      inboundAudioTracks: 0, outboundAudioTracks: 0,
    };
    for (const pc of open) {
      // A closed SFU consumer leaves its media section in the receive
      // transport as an inactive transceiver whose inbound stats (frozen
      // bytes) stay in getStats(). Only live receiving paths are counted, so
      // a dead one can neither look like double playback nor like flowing
      // audio.
      const live = new Set(pc.getTransceivers()
        .filter(t => (t.currentDirection === 'recvonly' || t.currentDirection === 'sendrecv') &&
          t.receiver.track.readyState === 'live')
        .map(t => t.mid));
      const stats = await pc.getStats();
      stats.forEach((r: Record<string, unknown>) => {
        if (r.type === 'outbound-rtp' && r.kind === 'audio') {
          out.outboundAudioTracks += 1;
          out.packetsSent += Number(r.packetsSent ?? 0);
        }
        if (r.type === 'inbound-rtp' && r.kind === 'audio' && live.has(r.mid as string)) {
          out.inboundAudioTracks += 1;
          out.packetsReceived += Number(r.packetsReceived ?? 0);
          out.bytesReceived += Number(r.bytesReceived ?? 0);
        }
      });
    }
    return out;
  }) as Promise<AudioFlow>;
}

/**
 * Open connections the media topology does not account for. P2P needs one
 * pairing per remote peer; the SFU exactly one send and one receive transport
 * per client, whatever the number of peers.
 */
function orphanPcs(flow: AudioFlow, remotePeers = 1): number {
  return flow.openPcCount - (flow.sfuTransports ? 2 : remotePeers);
}

/** DOM'daki uzak ses elemanları — çift çalma buradan görünür. */
const remoteAudioCount = (page: Page) =>
  page.locator('audio.remote-audio').count();

/** JWT govdesinden kullanici kimligi — yalnizca test kurulumu icin. */
function userIdFromToken(token: string): string {
  try {
    const body = token.split('.')[1] ?? '';
    const json = Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return String(JSON.parse(json).id ?? '');
  } catch { return ''; }
}

async function openApp(context: BrowserContext, token: string): Promise<Page> {
  await context.addInitScript(INSTRUMENT);
  await context.addInitScript((t: string) => {
    localStorage.setItem('token', t);
    localStorage.setItem('bridge_token', t);
  }, token);
  // ── ONBOARDING SIHIRBAZINI KAPAT ────────────────────────────────────────
  // Yeni bir tarayici baglaminda sihirbaz otomatik acilir ve `aria-modal`
  // arkaplani TUM tiklamalari yutar. Bu bir urun kusuru DEGIL, ilk kullanim
  // davranisi; test onu gercek kullanicinin yaptigi gibi "gorulmus" isaretler.
  await context.addInitScript((uid: string) => {
    if (uid) localStorage.setItem(`bridge_onboarding_v3:${uid}`, 'done');
    localStorage.setItem('bridge_onboarding_v3:anon', 'done');
  }, userIdFromToken(token));
  const page = await context.newPage();
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await page.locator('#app').waitFor({ state: 'visible', timeout: 25_000 });
  return page;
}

/**
 * Sunucuyu sec — kanal listesi ancak sunucu SECILDIKTEN sonra dolar.
 * `data-id` kanonik ve dile bagli olmayan bir capa (ServerSwitcher.svelte).
 */
async function selectServer(page: Page, serverId: string): Promise<void> {
  const btn = page.locator(`.server-icon[data-id="${serverId}"]`).first();
  await btn.waitFor({ state: 'visible', timeout: 25_000 });
  await btn.click();
}

/** Ses kanalına KANONİK yoldan katıl: kanal listesindeki düğmeye tıkla. */
async function joinVoiceChannel(page: Page, channelName: string): Promise<void> {
  const btn = page.locator(`[aria-label="Ses kanalı: ${channelName}"]`).first();
  await btn.waitFor({ state: 'visible', timeout: 25_000 });
  await btn.click();
}

/** Koşul sağlanana kadar ölç; sabit `waitForTimeout` yerine gerçek ölçüm. */
async function waitForFlow(
  page: Page, predicate: (f: AudioFlow) => boolean, timeoutMs = 25_000,
): Promise<AudioFlow> {
  const started = Date.now();
  let last = await readAudioFlow(page);
  while (Date.now() - started < timeoutMs) {
    if (predicate(last)) return last;
    await page.waitForTimeout(500);
    last = await readAudioFlow(page);
  }
  return last;
}

// ════════════════════════════════════════════════════════════════════════════
// ŞU AN ATLANIYOR — SEBEP ÖLÇÜLDÜ, GİZLENMİYOR
// ════════════════════════════════════════════════════════════════════════════
// Bu paket YAZILDI ve doğru şeyi ölçüyor, ancak bu Playwright ortamında iki
// tarayıcı arasında medya kurulamıyor. Ölçülen zincir:
//
//   1. Sunucu seçilir, ses kanalı düğmesine tıklanır  → ✅ çalışıyor
//   2. `ChannelStagePanel` sahneyi 'voice' yapar        → ✅ loglandı
//   3. `detectVoiceStack()` → `BridgeRegistry.has('rtc')` → ❌ FALSE
//   4. Sonuç: kullanıcıya "ses yığını kullanılamıyor" durumu gösterilir,
//      `joinVoice` HİÇ çağrılmaz, `RTCPeerConnection` hiç kurulmaz.
//
// Neden `rtc` kayıtlı değil: `ensureRtc()` yalnızca `BridgeRegistry.get('socket')`
// varsa örnek kurar. Ölçümde tarayıcı bağlamında Socket.IO el sıkışması
// GÖRÜLMEDİ — ne depolanmış jetonla ne de GERÇEK arayüz girişiyle
// (`loginViaUI`). Tarayıcı yetenekleri elenmiştir: `typeof RTCPeerConnection`
// ve `typeof navigator.mediaDevices.getUserMedia` 'function', `isSecureContext`
// true.
//
// BU BİR ÜRÜN KUSURU İDDİASI DEĞİLDİR. Kullanıcı gerçek tarayıcısında sesi
// ÇALIŞIR halde kullanıyor (yankı bildirdi), dolayısıyla soketler orada
// kuruluyor. En olası açıklama, ölçüm aracının engine.io'nun taşımasını
// yakalayamaması ya da otomasyon bağlamına özgü bir farktır — kanıtlanmadı.
//
// AÇILMASI İÇİN sıradaki adım: tarayıcı bağlamında Socket.IO'nun gerçekten
// bağlanıp bağlanmadığını `BridgeRegistry` üzerinden (ESM olduğu için test
// kancası gerekir) ya da sunucu erişim loglarından doğrulamak. Bağlantı
// kurulur kurulmaz bu paket olduğu gibi çalışmalıdır.
//
// ATLAMAK, ÖLÇÜMÜ GİZLEMEK DEĞİLDİR: paket silinmedi, sebebi burada yazılı ve
// yeşil sınır sahte bir "ses doğrulandı" iddiası taşımıyor.
// ════════════════════════════════════════════════════════════════════════════
// ATLAMA KALDIRILDI — KOK NEDEN BULUNDU VE DUZELTILDI
// ════════════════════════════════════════════════════════════════════════════
// Yukaridaki cozumleme dogru olcmus ama YANLIS yorumlamisti. "Tarayici
// baglaminda Socket.IO el sikismasi GORULMEDI" bir olcum aracı kusuru DEGIL,
// GERCEK BIR URUN KUSURUYDU (P0):
//
//   `js/app.ts` icinde `import { socket } from './core/socket-svelte.ts'`
//   vardi ve `socket` hicbir yerde kullanilmiyordu. TypeScript'in import
//   elision kurali deyimin TAMAMINI siler; esbuild de uygular. Modul
//   derlemeye HIC girmedi, kendini mount eden yan etkisi calismadi,
//   `SocketManager` kurulmadi ve `io()` HIC cagrilmadi.
//
// Bu yuzden `BridgeRegistry.get('socket')` bostu, `ensureRtc()` ornek
// kurmuyordu ve `detectVoiceStack()` "ses yigini kullanilamiyor" diyordu.
//
// Duzeltme yan etki import'udur (`import './core/socket-svelte.ts';`).
// Tarayici artik gercek bir WebSocket aciyor, dolayisiyla bu paket
// CALISABILIR durumdadir ve atlama kaldirilmistir.
test.describe('ses — iki tarayıcı arasında GERÇEK medya', () => {
  // Sahte medya bayrakları PROJE düzeyindedir (playwright.config.ts →
  // `voice-media`). `test.use({ launchOptions })` bir describe içinde
  // kullanılamaz: yeni bir worker'a zorlar ve Playwright bunu reddeder.

  let serverId = '';
  let voiceName = '';

  test.beforeAll(async ({ request }) => {
    const tokens = getTokens();
    const srv = await createTestServer(request, tokens.media1, `Voice Media ${Date.now()}`);
    serverId = String(srv?._id ?? srv?.id ?? '');
    expect(serverId, 'test sunucusu oluşturulamadı').toBeTruthy();

    voiceName = `ses-${Date.now().toString(36)}`;
    const ch = await createTestChannel(request, tokens.media1, serverId, voiceName, 'voice');
    expect(ch, 'ses kanalı oluşturulamadı').toBeTruthy();

    expect(
      await joinServer(request, tokens.media1, tokens.media2, serverId),
      'bob sunucuya katılamadı',
    ).toBe(true);
  });

  test('A→B ve B→A ses AKIYOR, çift çalma YOK', async ({ browser }) => {
    const tokens = getTokens();
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();

    try {
      const pageA = await openApp(ctxA, tokens.media1);
      const pageB = await openApp(ctxB, tokens.media2);
      await selectServer(pageA, serverId);
      await selectServer(pageB, serverId);

      await joinVoiceChannel(pageA, voiceName);
      await pageA.waitForTimeout(1_500);          // A önce girsin, B'yi beklesin
      await joinVoiceChannel(pageB, voiceName);

      // ── A→B: B GERÇEKTEN paket alıyor mu? ────────────────────────────────
      const flowB = await waitForFlow(pageB, f => f.packetsReceived > 0 && f.bytesReceived > 0);
      expect(flowB.openPcCount, 'B eşleşme kurmadı').toBeGreaterThan(0);
      expect(flowB.packetsReceived, 'A→B ses paketi ULAŞMADI').toBeGreaterThan(0);
      expect(flowB.bytesReceived, 'A→B ses baytı ULAŞMADI').toBeGreaterThan(0);

      // ── B→A: A GERÇEKTEN paket alıyor mu? ────────────────────────────────
      const flowA = await waitForFlow(pageA, f => f.packetsReceived > 0 && f.bytesReceived > 0);
      expect(flowA.packetsReceived, 'B→A ses paketi ULAŞMADI').toBeGreaterThan(0);
      expect(flowA.bytesReceived, 'B→A ses baytı ULAŞMADI').toBeGreaterThan(0);

      // ── Her iki taraf da GÖNDERİYOR ──────────────────────────────────────
      expect(flowA.packetsSent, 'A ses göndermiyor').toBeGreaterThan(0);
      expect(flowB.packetsSent, 'B ses göndermiyor').toBeGreaterThan(0);

      // ── ÇİFT ÇALMA YOK ───────────────────────────────────────────────────
      // Karşı tarafta TEK gelen ses akışı ve TEK ses elemanı olmalı. İkisi
      // olsaydı kullanıcı sesi çift/odalı duyardı — bildirilen belirtinin ta
      // kendisi.
      expect(flowA.inboundAudioTracks, 'A birden fazla gelen ses akışı görüyor').toBe(1);
      expect(flowB.inboundAudioTracks, 'B birden fazla gelen ses akışı görüyor').toBe(1);
      expect(await remoteAudioCount(pageA), 'A tarafında fazladan uzak ses elemanı').toBe(1);
      expect(await remoteAudioCount(pageB), 'B tarafında fazladan uzak ses elemanı').toBe(1);

      // ── AYNI KİŞİ İÇİN İKİNCİ BAĞLANTI YOK ───────────────────────────────
      expect(orphanPcs(flowA), 'A tarafında yetim eşleşme kaldı').toBe(0);
      expect(orphanPcs(flowB), 'B tarafında yetim eşleşme kaldı').toBe(0);
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });

  test('yankı gidermesi GERÇEKTEN uygulanıyor (canlı arama track\'i)', async ({ browser }) => {
    // Bu, tek kişilik vekil ölçüm DEĞİL: gerçek bir aramadaki canlı
    // mikrofon track'inden `getSettings()` okunur.
    // IKI baglam GEREKLIDIR: tek kisilik bir ses kanalinda AKRAN BAGLANTISI
    // kurulmaz, dolayisiyla giden ses gondericisi de olusmaz. Test eskiden
    // tek kullaniciyla kosuyor ve "canli giden ses track'i bulunamadi" ile
    // basarisiz oluyordu — bu bir URUN kusuru degil, olcum kurulumu hatasiydi.
    const tokens = getTokens();
    const ctx  = await browser.newContext();
    const ctxB = await browser.newContext();
    try {
      const page  = await openApp(ctx, tokens.media1);
      const pageB = await openApp(ctxB, tokens.media2);
      await selectServer(page, serverId);
      await selectServer(pageB, serverId);
      await joinVoiceChannel(page, voiceName);
      await page.waitForTimeout(1_500);
      await joinVoiceChannel(pageB, voiceName);

      const applied = await page.evaluate(async () => {
        const deadline = Date.now() + 20_000;
        while (Date.now() < deadline) {
          const pcs = ((window as unknown as { __pcs?: RTCPeerConnection[] }).__pcs ?? []);
          for (const pc of pcs) {
            const sender = pc.getSenders().find(s => s.track?.kind === 'audio');
            const track = sender?.track;
            if (track && track.readyState === 'live') return track.getSettings();
          }
          await new Promise(r => setTimeout(r, 400));
        }
        return null;
      }) as MediaTrackSettings | null;

      expect(applied, 'canlı giden ses track\'i bulunamadı').not.toBeNull();
      // Sahte cihazda tarayıcı bu kısıtları uygular; `false` dönerse istek
      // düşürülmüş demektir ve yankı riski GERÇEKTİR.
      expect(applied?.echoCancellation, 'yankı giderme UYGULANMADI').not.toBe(false);
      expect(applied?.noiseSuppression, 'gürültü bastırma UYGULANMADI').not.toBe(false);
      expect(applied?.autoGainControl, 'otomatik kazanç UYGULANMADI').not.toBe(false);
    } finally {
      await ctx.close();
      await ctxB.close();
    }
  });

  test('çık/tekrar katıl — yetim eşleşme ve ses elemanı BIRAKMAZ', async ({ browser }) => {
    // Sızıntı burada birikirdi: her katılımda bir eşleşme daha eklenip
    // eskisi kapanmasaydı, aynı kişi iki kez duyulurdu.
    const tokens = getTokens();
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    try {
      const pageA = await openApp(ctxA, tokens.media1);
      const pageB = await openApp(ctxB, tokens.media2);
      await selectServer(pageA, serverId);
      await selectServer(pageB, serverId);

      await joinVoiceChannel(pageA, voiceName);
      await pageA.waitForTimeout(1_000);
      await joinVoiceChannel(pageB, voiceName);
      await waitForFlow(pageB, f => f.packetsReceived > 0);

      // ══════════════════════════════════════════════════════════════════
      // BU TEST ESKIDEN BOSA CIKIYORDU
      // ══════════════════════════════════════════════════════════════════
      // Yorum "ayni kanala tekrar tiklamak ayrilmadir" diyordu; oysa
      // `ChannelListManager.selectChannel` AYNI kanal icin kosulsuz erken
      // donuyordu. Yani her iki tiklama da HICBIR SEY yapmiyordu: B sesten
      // hic cikmadi, dolayisiyla "tekrar katilim" da hic yasanmadi ve tum
      // iddialar bos yere geciyordu.
      //
      // Artik GERCEKTEN ayrilma dugmesiyle cikilir ve kanala tiklanarak
      // geri girilir — kullanicinin yaptigi sey.
      await pageB.locator('[aria-label="Ses kanalından ayrıl"]:visible').first().click();
      await expect.poll(() => remoteAudioCount(pageB), { timeout: 20_000 }).toBe(0);
      await joinVoiceChannel(pageB, voiceName);

      const again = await waitForFlow(pageB, f => f.packetsReceived > 0 && f.openPcCount > 0);
      expect(again.packetsReceived, 'tekrar katılımda ses gelmedi').toBeGreaterThan(0);
      expect(orphanPcs(again), 'tekrar katılımda yetim eşleşme kaldı').toBe(0);
      expect(again.inboundAudioTracks, 'tekrar katılımda ses akışı çiftlendi').toBe(1);
      expect(await remoteAudioCount(pageB), 'tekrar katılımda uzak ses elemanı çiftlendi').toBe(1);
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// MAKINE ON KONTROLU — SESSIZE ALMA / SAGIRLASTIRMA / PAYLASIM YASAM DONGUSU
//
// Bunlar INSAN dogrulamasi DEGILDIR. Insanin duydugunu kanitlamazlar; yalnizca
// urunun ic durumunun dogru degistigini kanitlarlar. Insan gecidi ayridir.
// ════════════════════════════════════════════════════════════════════════════
test.describe('makine ön kontrolü — ses durumu ve paylaşım yaşam döngüsü', () => {
  let srvId = '';
  let vcName = '';

  test.beforeAll(async ({ request }) => {
    const tokens = getTokens();
    const srv = await createTestServer(request, tokens.media1, `Preflight ${Date.now()}`);
    srvId = String(srv?._id ?? srv?.id ?? '');
    vcName = `pf-${Date.now().toString(36)}`;
    await createTestChannel(request, tokens.media1, srvId, vcName, 'voice');
    await joinServer(request, tokens.media1, tokens.media2, srvId);
  });

  test('SESSIZE ALMA giden ses track\'ini GERÇEKTEN etkiler', async ({ browser }) => {
    const tokens = getTokens();
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    try {
      const pageA = await openApp(ctxA, tokens.media1);
      const pageB = await openApp(ctxB, tokens.media2);
      await selectServer(pageA, srvId); await selectServer(pageB, srvId);
      await joinVoiceChannel(pageA, vcName);
      await pageA.waitForTimeout(1_500);
      await joinVoiceChannel(pageB, vcName);

      const outgoingEnabled = () => pageA.evaluate(() => {
        const pcs = ((window as unknown as { __pcs?: RTCPeerConnection[] }).__pcs ?? []);
        for (const pc of pcs) {
          const t = pc.getSenders().find(s => s.track?.kind === 'audio')?.track;
          if (t) return t.enabled;
        }
        return null;
      });

      await expect.poll(outgoingEnabled, { timeout: 20_000 }).toBe(true);

      await pageA.locator('[aria-label="Mikrofonu kapat"]:visible').first().click({ timeout: 10_000 });
      // Sessize alma giden track'i GERÇEKTEN kapatmalı; yalnızca ikon
      // değiştirmek karşı tarafın duymaya devam etmesi demektir.
      await expect.poll(outgoingEnabled, { timeout: 10_000 }).toBe(false);

      await pageA.locator('[aria-label="Mikrofonu aç"]:visible').first().click({ timeout: 10_000 });
      await expect.poll(outgoingEnabled, { timeout: 10_000 }).toBe(true);
    } finally { await ctxA.close(); await ctxB.close(); }
  });

  test('SAĞIRLAŞTIRMA uzak ses çalmayı GERÇEKTEN susturur', async ({ browser }) => {
    const tokens = getTokens();
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    try {
      const pageA = await openApp(ctxA, tokens.media1);
      const pageB = await openApp(ctxB, tokens.media2);
      await selectServer(pageA, srvId); await selectServer(pageB, srvId);
      await joinVoiceChannel(pageA, vcName);
      await pageA.waitForTimeout(1_500);
      await joinVoiceChannel(pageB, vcName);

      const allMuted = () => pageA.evaluate(() => {
        const els = [...document.querySelectorAll<HTMLMediaElement>('.remote-audio')];
        return els.length === 0 ? null : els.every(e => e.muted);
      });

      await expect.poll(() => pageA.locator('.remote-audio').count(), { timeout: 20_000 })
        .toBeGreaterThan(0);
      await expect.poll(allMuted, { timeout: 10_000 }).toBe(false);

      await pageA.locator('#btn-deafen:visible').click({ timeout: 10_000 });
      await expect.poll(allMuted, { timeout: 10_000 }).toBe(true);

      await pageA.locator('#btn-deafen:visible').click({ timeout: 10_000 });
      await expect.poll(allMuted, { timeout: 10_000 }).toBe(false);
    } finally { await ctxA.close(); await ctxB.close(); }
  });

  test('AYRILMA track ve eşleşme durumunu temizler', async ({ browser }) => {
    const tokens = getTokens();
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    try {
      const pageA = await openApp(ctxA, tokens.media1);
      const pageB = await openApp(ctxB, tokens.media2);
      await selectServer(pageA, srvId); await selectServer(pageB, srvId);
      await joinVoiceChannel(pageA, vcName);
      await pageA.waitForTimeout(1_500);
      await joinVoiceChannel(pageB, vcName);
      await expect.poll(() => pageB.locator('.remote-audio').count(), { timeout: 20_000 })
        .toBeGreaterThan(0);

      await pageA.locator('[aria-label="Ses kanalından ayrıl"]:visible').first().click({ timeout: 10_000 });

      // B tarafında A'ya ait uzak ses elemanı KALMAMALI — aksi halde ayrılan
      // kişinin sesi asılı kalır (hayalet akran).
      await expect.poll(() => pageB.locator('.remote-audio').count(), { timeout: 15_000 })
        .toBe(0);
    } finally { await ctxA.close(); await ctxB.close(); }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// MAKINE ON KONTROLU — EKRAN PAYLASIMI YASAM DONGUSU
//
// Sahte masaustu kaynagi ile calisir. GORUNTUNUN INSANCA GORULDUGUNU
// KANITLAMAZ; yalnizca track'in gercekten iletildigini, temizlendigini ve
// yeniden baslatilabildigini kanitlar.
// ════════════════════════════════════════════════════════════════════════════

/**
 * Tiklamayi ENGELLEYEN ogeyi tahmin etmek yerine RAPORLAYAN tiklama.
 *
 * Ayni etiketi tasiyan BIRDEN FAZLA kontrol olabilir (kabuk dock'u + panel +
 * paylasim cubugu). Bu yuzden once GERCEKTEN tiklanabilir olanin SIRASI
 * bulunur, sonra TAM O ogeye tiklanir — `.first()` ortulu olani secebilir.
 */
async function clickOrExplain(page: Page, selector: string): Promise<void> {
  const found = await page.evaluate((sel) => {
    const els = [...document.querySelectorAll(sel)] as HTMLElement[];
    if (!els.length) return { index: -1, why: 'SECICI ESLESMEDI: ' + sel };
    let lastTop = 'yok';
    for (let i = 0; i < els.length; i++) {
      const el = els[i];
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) as HTMLElement | null;
      if (!top || el.contains(top) || top === el) return { index: i, why: '' };
      lastTop = top.tagName + '.' + String(top.className).slice(0, 40);
    }
    return { index: -1, why: 'HEPSI ENGELLI: ' + sel + ' <- ' + lastTop };
  }, selector);

  if (found.index < 0) throw new Error(found.why);
  await page.locator(selector).nth(found.index).click({ timeout: 15_000 });
}

test.describe('makine ön kontrolü — ekran paylaşımı', () => {
  let srvId = '';
  let vcName = '';

  test.beforeAll(async ({ request }) => {
    const tokens = getTokens();
    const srv = await createTestServer(request, tokens.media1, `Screen ${Date.now()}`);
    srvId = String(srv?._id ?? srv?.id ?? '');
    vcName = `sc-${Date.now().toString(36)}`;
    await createTestChannel(request, tokens.media1, srvId, vcName, 'voice');
    await joinServer(request, tokens.media1, tokens.media2, srvId);
  });

  /** B tarafinda GELEN video akisi var mi? */
  const incomingVideo = (page: Page) => page.evaluate(async () => {
    const pcs = ((window as unknown as { __pcs?: RTCPeerConnection[] }).__pcs ?? []);
    let best = 0;
    for (const pc of pcs) {
      const stats = await pc.getStats();
      stats.forEach(r => {
        if (r.type === 'inbound-rtp' && (r as { kind?: string }).kind === 'video') {
          best = Math.max(best, (r as { bytesReceived?: number }).bytesReceived ?? 0);
        }
      });
    }
    return best;
  });

  test('paylaşım BAŞLAR, video GERÇEKTEN iletilir, DURDURULUR ve TEMİZLENİR', async ({ browser }) => {
    const tokens = getTokens();
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    try {
      const pageA = await openApp(ctxA, tokens.media1);
      const pageB = await openApp(ctxB, tokens.media2);
      await selectServer(pageA, srvId); await selectServer(pageB, srvId);
      await joinVoiceChannel(pageA, vcName);
      await pageA.waitForTimeout(1_500);
      await joinVoiceChannel(pageB, vcName);
      await expect.poll(() => pageB.locator('.remote-audio').count(), { timeout: 20_000 })
        .toBeGreaterThan(0);

      // ── BASLAT ────────────────────────────────────────────────────────
      await pageA.locator('[aria-label="Ekran paylaş"]:visible').first().click({ timeout: 15_000 });
      // Kalite secici acilabilir; varsayilan kaydedilmemisse bir secenek sec.
      const picker = pageA.locator('#ss-quality-modal, .ss-quality-modal').first();
      if (await picker.isVisible({ timeout: 3_000 }).catch(() => false)) {
        await clickOrExplain(pageA, '.ss-quality-btn');
      }

      // ASIL KANIT: B'ye gercekten video BAYTI ulasiyor.
      await expect.poll(() => incomingVideo(pageB), { timeout: 30_000 }).toBeGreaterThan(0);

      // ── DURDUR ────────────────────────────────────────────────────────
      // KANONIK durdurma kontrolu paylasim gorunumundeki `#ss-stop-btn`'dir.
      // Kontrol cubugundaki `#vc-screen` ayni etiketi tasir ama BASKA BIR
      // DUGME tarafindan ortulur (P2 bulgusu — kullanici yine de durdurabilir).
      await clickOrExplain(pageA, '#ss-stop-btn');

      // Uzak ekran gorunumu TEMIZLENMELI — donmus kare kalmamali.
      await expect.poll(
        () => pageB.evaluate(() => document.querySelectorAll('#remote-screen-video').length),
        { timeout: 15_000 },
      ).toBe(0);

      // ── YENIDEN BASLAT ────────────────────────────────────────────────
      await clickOrExplain(pageA, '[aria-label="Ekran paylaş"]');
      const picker2 = pageA.locator('#ss-quality-modal, .ss-quality-modal').first();
      if (await picker2.isVisible({ timeout: 3_000 }).catch(() => false)) {
        await clickOrExplain(pageA, '.ss-quality-btn');
      }
      // Sese/videoya yeniden katilmadan tekrar paylasabilmeli.
      await expect.poll(() => pageA.locator('[aria-label="Ekran paylaşımını durdur"]:visible').count(),
        { timeout: 20_000 }).toBeGreaterThan(0);
    } finally { await ctxA.close(); await ctxB.close(); }
  });

  test('paylaşırken AYRILAN kişinin uzak ekranı temizlenir', async ({ browser }) => {
    const tokens = getTokens();
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    try {
      const pageA = await openApp(ctxA, tokens.media1);
      const pageB = await openApp(ctxB, tokens.media2);
      await selectServer(pageA, srvId); await selectServer(pageB, srvId);
      await joinVoiceChannel(pageA, vcName);
      await pageA.waitForTimeout(1_500);
      await joinVoiceChannel(pageB, vcName);
      await expect.poll(() => pageB.locator('.remote-audio').count(), { timeout: 20_000 })
        .toBeGreaterThan(0);

      await pageA.locator('[aria-label="Ekran paylaş"]:visible').first().click({ timeout: 15_000 });
      const picker = pageA.locator('#ss-quality-modal, .ss-quality-modal').first();
      if (await picker.isVisible({ timeout: 3_000 }).catch(() => false)) {
        await clickOrExplain(pageA, '.ss-quality-btn');
      }
      await expect.poll(() => incomingVideo(pageB), { timeout: 30_000 }).toBeGreaterThan(0);

      // Paylasirken AYRIL.
      await clickOrExplain(pageA, '[aria-label="Ses kanalından ayrıl"]');

      // B'de ne uzak ses ne donmus ekran kalmali.
      await expect.poll(() => pageB.locator('.remote-audio').count(), { timeout: 20_000 }).toBe(0);
      await expect.poll(
        () => pageB.evaluate(() => document.querySelectorAll('#remote-screen-video').length),
        { timeout: 15_000 },
      ).toBe(0);
    } finally { await ctxA.close(); await ctxB.close(); }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// MAKINE ON KONTROLU — BAS-KONUS URETIM YOLU
//
// KAPATILAN GERCEK BOSLUK: PTT mekanizmasi calisiyordu ama HICBIR uretim
// arayuzu onu acmiyordu. Bu paket URETIM derlemesinde Ayarlar → Cihazlar
// yolunun kanonik PTT makinesine GERCEKTEN ulastigini kanitlar.
//
// INSAN dogrulamasi DEGILDIR: sesin duyuldugunu kanitlamaz.
// ════════════════════════════════════════════════════════════════════════════
test.describe('makine ön kontrolü — bas-konuş üretim yolu', () => {
  // Sunucusuz kullanicida "ilk sunucunu olustur" karsilama ekrani MESRU olarak
  // acilir ve Ayarlar'i orter. Bu bir urun kusuru degil; test gercekci bir
  // duruma kurulur.
  // MEDIA1 kullanilir.
  //
  // `socketRateLimit.ts` KULLANICI BASINA genel bir sinir uygular
  // (`'*': { max: 200, windowMs: 60_000 }`). Tum E2E paketi alice olarak
  // kostugu icin, bu testi de alice'e eklemek toplu kosumda o butceyi asiyor
  // ve ILGISIZ testler `pending` → `failed` ile dusuyordu.
  //
  // Bu bir URUN kusuru DEGILDIR: dakikada 200 olay gercek bir kullanicinin
  // ulasamayacagi bir kotuye kullanim siniridir. Dogru duzeltme kullaniciyi
  // AYIRMAKTIR. carol KULLANILMAZ — o bilerek "hicbir yere uye olmayan"
  // taraftir ve yetkilendirme sinir testleri buna dayanir.
  test.beforeAll(async ({ request }) => {
    const tokens = getTokens();
    await createTestServer(request, tokens.media1, `PTT ${Date.now()}`);
  });

  test('Ayarlar → Cihazlar PTT kontrolü SUNAR ve kanonik duruma YAZAR', async ({ browser }) => {
    const tokens = getTokens();
    const ctx = await browser.newContext();
    try {
      const page = await openApp(ctx, tokens.media1);
      await page.locator('#btn-settings').first().click({ timeout: 15_000 });

      const devicesTab = page.locator('[data-tab="devices"], [role="tab"]')
        .filter({ hasText: /Cihaz|Device|Ses|Voice/i }).first();
      if (await devicesTab.count()) await devicesTab.click({ timeout: 10_000 });

      // 1) Kontrol GERCEKTEN var mi?
      const ptt = page.locator('.ptt').first();
      await expect(ptt).toBeVisible({ timeout: 15_000 });

      // 2) Etkinlestirme kanonik duruma YAZIYOR mu?
      // `.check()` yerine `.click()`: bilesen tek yonlu `checked={...}`
      // kullanir, Playwright'in tiklama sonrasi durum dogrulamasi bu desende
      // yarisa girer. Asil sozlesme zaten asagida dogrulanir — hem KALICI
      // deger hem de kutunun GORUNEN durumu.
      await ptt.locator('input[type="checkbox"]').first().click({ timeout: 10_000 });
      await expect.poll(
        () => page.evaluate(() => {
          try { return JSON.parse(localStorage.getItem('bridgePTT') ?? '{}').enabled === true; }
          catch { return false; }
        }),
        { timeout: 10_000 },
      ).toBe(true);
      await expect(ptt.locator('input[type="checkbox"]').first()).toBeChecked();

      // 3) Mod secimi kanonik duruma YAZIYOR mu? (`setPttMode` eskiden
      //    registry'ye kayitli DEGILDI — hicbir arayuzden erisilemezdi.)
      await ptt.locator('.ptt-mode').nth(1).click({ timeout: 10_000 });
      await expect.poll(
        () => page.evaluate(() => {
          try { return JSON.parse(localStorage.getItem('bridgePTT') ?? '{}').mode; }
          catch { return null; }
        }),
        { timeout: 10_000 },
      ).toBe('toggle');

      // 4) Tus yakalama GERCEKTEN baglaniyor mu?
      await ptt.locator('.ptt-btn').first().click({ timeout: 10_000 });
      await expect(ptt.locator('.ptt-key-display.capturing')).toBeVisible({ timeout: 5_000 });
      await page.keyboard.press('KeyV');
      await expect.poll(
        () => page.evaluate(() => {
          try { return JSON.parse(localStorage.getItem('bridgePTT') ?? '{}').key?.code; }
          catch { return null; }
        }),
        { timeout: 10_000 },
      ).toBe('KeyV');

      // 5) Escape yakalamayi IPTAL eder (baglama degismez).
      await ptt.locator('.ptt-btn').first().click({ timeout: 10_000 });
      await expect(ptt.locator('.ptt-key-display.capturing')).toBeVisible({ timeout: 5_000 });
      await page.keyboard.press('Escape');
      await expect(ptt.locator('.ptt-key-display.capturing')).toHaveCount(0, { timeout: 5_000 });
      expect(await page.evaluate(() => {
        try { return JSON.parse(localStorage.getItem('bridgePTT') ?? '{}').key?.code; }
        catch { return null; }
      })).toBe('KeyV');

      // 6) Tercih yeniden yuklemede KORUNUR.
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.locator('#app').waitFor({ state: 'visible', timeout: 25_000 });
      expect(await page.evaluate(() => {
        try { const d = JSON.parse(localStorage.getItem('bridgePTT') ?? '{}');
              return `${d.enabled}:${d.mode}:${d.key?.code}`; } catch { return ''; }
      })).toBe('true:toggle:KeyV');
    } finally { await ctx.close(); }
  });
});
