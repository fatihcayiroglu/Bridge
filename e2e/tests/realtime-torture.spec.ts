// e2e/tests/realtime-torture.spec.ts
//
// ════════════════════════════════════════════════════════════════════════════
// FAZ 5 — GERÇEK ZAMANLI İŞKENCE
// ════════════════════════════════════════════════════════════════════════════
//
// ── BU DOSYANIN REDDETTİĞİ İDDİA ────────────────────────────────────────────
// "Soket bağlandı" hiçbir şey kanıtlamaz. Kullanıcı kopmayı umursamaz;
// kopmadan SONRA ekranında ne yazdığını umursar. Bu yüzden buradaki her
// senaryo NİHAİ DURUM DOĞRULUĞUNU ölçer:
//
//     mesaj kaybı = 0 · mesaj çiftlenmesi = 0 · okunmamış yakınsaması TAM
//     varlık yakınsaması · bayat pencere SINIRLI
//
// ── EŞİKLER KOŞUMDAN ÖNCE TANIMLIDIR ────────────────────────────────────────
// Aşağıdaki `budget(...)` bildirimleri, senaryolar çalışmadan ÖNCE, bu
// dosyanın tepesinde durur ve `Object.freeze` ile dondurulur. Sonuç
// görüldükten sonra eşik OYNATILAMAZ. Bir bütçe aşılırsa test DÜŞER.
//
// ── ÜRÜNÜN KORUMALARI GEVŞETİLMEZ ───────────────────────────────────────────
// Üretimdeki anti-spam politikası 4 saniyede 5 mesajı aşanı önce uyarır,
// sonra 30 SANİYE susturur (`server/lib/security.ts`). Bu doğru bir korumadır
// ve İŞKENCE UĞRUNA GEVŞETİLMEZ. Yük bunun yerine BİRDEN ÇOK GÖNDERİCİYE
// dağıtılır ve her gönderici insan hızında (`paceSends`) yazar — gerçek bir
// yoğun kanal da böyle davranır.
//
// ── HATA ENJEKSİYONU DETERMİNİSTİKTİR ───────────────────────────────────────
// "Bazen kopar" diye beklenmez. Kopma `socket.disconnect()` ile İSTENEREK
// yapılır, çiftlenme AYNI `ackId` ile İSTENEREK tetiklenir, çift oda üyeliği
// `channel:join`ı İSTENEREK üç kez yayarak kurulur.

import { test, expect } from '../helpers/apiTest';
import {
  getTokens, createTestServer, createTestChannel, apiRequest, joinServer,
} from '../helpers/bridge';
import { openSocket, closeSockets, joinChannelConfirmed, paceSends } from '../helpers/socket';
import {
  budget, scenario, percentile, writeTortureReport, tortureResults,
} from '../helpers/torture';
import type { Socket } from 'socket.io-client';

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:3000';

// ════════════════════════════════════════════════════════════════════════════
// BÜTÇELER — KOŞUMDAN ÖNCE, DONDURULMUŞ
// ════════════════════════════════════════════════════════════════════════════
const B = {
  // T1 — yeniden bağlanma fırtınası
  reconnectP50:      budget('yeniden baglanma p50',        1_500, 'ms'),
  reconnectP95:      budget('yeniden baglanma p95',        4_000, 'ms'),
  reconnectFailures: budget('basarisiz yeniden baglanma',      0, ' adet'),

  // T2 — çevrimdışı pencerede kayıp/çiftlenme
  lostMessages:      budget('kayip mesaj',                     0, ' adet'),
  duplicateMessages: budget('ciftlenmis mesaj',                0, ' adet'),
  convergenceMs:     budget('yakinsama suresi',           10_000, 'ms'),

  // T3 — düşen ACK sonrası istemci tekrarı
  ackReplayExtraRows: budget('ackId tekrarinda satir sapmasi (tam 1 olmali)', 0, ' adet'),
  ackReplayMismatch:  budget('ackId tekrarinda farkli id',     0, ' adet'),

  // T4 — çift oda üyeliği
  doubleJoinDuplicates: budget('cift join ciftlenmesi',        0, ' adet'),

  // T5 — çok sekmeli yakınsama
  tabLoss:           budget('sekme basina kayip',              0, ' adet'),
  tabDuplicates:     budget('sekme basina ciftlenme',          0, ' adet'),

  // T6 — okunmamış yakınsaması
  unreadDrift:       budget('kacirilan bahsetme sapmasi',       0, ' adet'),
  unreadConvergeMs:  budget('bahsetme yakinsama suresi',   15_000, 'ms'),

  // T7 — varlık yakınsaması
  presenceStaleMs:   budget('bayat varlik suresi',         8_000, 'ms'),
  presenceWrongFinal: budget('yanlis nihai varlik',            0, ' adet'),

  // T8 — yazıyor fırtınası
  typingSocketDeaths: budget('firtinada olen soket',           0, ' adet'),
  // NOT: "takili kalan yaziyor" butcesi BU dosyadan KALDIRILDI cunku yanlis
  // katmani olcuyordu (kablo != kullanici ekrani). Kullaniciya gorunen bayat
  // pencere `typing-convergence.spec.ts` icinde 12000 ms butcesiyle olculur.
} as const;

// ── Fikstür ────────────────────────────────────────────────────────────────
let serverId = '';
let channelId = '';
let channelName = '';
let bobUserId = '';
let fixtureError = '';

const T = getTokens();

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ request }) => {
  const stamp = Date.now().toString(36);
  try {
    const srv = await createTestServer(request, T.alice, `RT ${stamp}`);
    serverId = String(srv?._id ?? srv?.id ?? '');
    if (!serverId) { fixtureError = 'sunucu olusturulamadi (hiz siniri?)'; return; }

    channelName = `rt-${stamp}`;
    const ch = await createTestChannel(request, T.alice, serverId, channelName, 'text');
    channelId = String(ch?._id ?? ch?.id ?? '');
    if (!channelId) { fixtureError = 'kanal olusturulamadi'; return; }

    // Bob ve Carol GERÇEK üye olmalı: okunmamış sayacı ve varlık yayını
    // yalnızca üyeler için üretilir.
    if (!(await joinServer(request, T.alice, T.bob, serverId))) {
      fixtureError = 'bob sunucuya katilamadi';
      return;
    }
    if (!(await joinServer(request, T.alice, T.carol, serverId))) {
      fixtureError = 'carol sunucuya katilamadi';
      return;
    }

    // Kanonik uc `/api/me`. Olculdu: `/api/users/me` -> 404 "User not found"
    // ("me" bir kullanici ID'si sanilir), `/api/auth/me` -> 404 "Not found".
    // Ilk kosumda bu yuzden `bobUserId` bos kaldi ve T7/T8 varlik/yaziyor
    // olaylarini KULLANICI BAZINDA SUZEMEDI — olculen sey baska bir
    // kullanicinin olayi olabilirdi. Suzgec artik gercekten calisir.
    const meRes = await apiRequest(request, 'GET', '/api/me', undefined, T.bob);
    if (meRes.ok()) {
      const me = await meRes.json() as { _id?: string; id?: string };
      bobUserId = String(me?._id ?? me?.id ?? '');
    }
  } catch (err) {
    fixtureError = `fikstur istisnasi: ${(err as Error).message}`;
  }
});

// ── Yardımcılar ────────────────────────────────────────────────────────────

/** Bağlanma gecikmesini ÖLÇEREK soket açar. */
async function timedOpen(token: string): Promise<{ socket: Socket; ms: number }> {
  // Hiz bekleme SAAT BASLAMADAN once biter: olculen sey urunun baglanma
  // gecikmesidir, harness'in nezaketi degil.
  await paceSocketOpen();
  const t0 = Date.now();
  const socket = await openSocket(token);
  return { socket, ms: Date.now() - t0 };
}

/** Bir mesajı ürünün hız politikasına UYARAK gönderir ve ack'ini bekler. */
async function sendPaced(
  socket: Socket, who: string, content: string, ackId: string,
): Promise<{ messageId: string } | null> {
  await paceSends(who, 1_400);
  return new Promise((resolve) => {
    const timer = setTimeout(() => { socket.off('message:ack', onAck); resolve(null); }, 12_000);
    function onAck(data: { ackId?: string; messageId?: string }) {
      if (data?.ackId !== ackId) return;
      clearTimeout(timer);
      socket.off('message:ack', onAck);
      resolve({ messageId: String(data.messageId ?? '') });
    }
    socket.on('message:ack', onAck);
    socket.emit('message:send', { channelId, serverId, content, ackId });
  });
}

/**
 * Kanalın SUNUCUDAKİ gerçeğini okur — istemci belleğini değil.
 *
 * İKİ ÖLÇÜM KUSURU BURADA KAPATILDI (ilk koşumda ikisi de ÜRÜN KUSURU gibi
 * görünüyordu):
 *
 *   1. `limit=200` isteniyordu. Sunucu bunu DOĞRU biçimde reddediyor
 *      (`limit must be an integer between 1 and 100`, HTTP 400) — yani ürün
 *      girdi doğrulamasını yapıyordu, kusur bendeydi. Artık 100 istenir.
 *   2. Okuma başarısız olunca SESSİZCE boş dizi dönüyordu. Sonuç: sağlam bir
 *      kanal "8 mesajın 8'i de KAYIP" gibi raporlanıyordu. Bozuk bir ölçüm
 *      aleti, ürün kusurundan AYIRT EDİLEBİLİR olmalıdır; artık hata
 *      fırlatılır ve senaryo ölçüm hatası olarak düşer.
 */
async function historyContents(
  request: import('@playwright/test').APIRequestContext, token: string,
): Promise<string[]> {
  const res = await apiRequest(
    request, 'GET', `/api/channels/${channelId}/messages?limit=100`, undefined, token,
  );
  if (!res.ok()) {
    throw new Error(
      `OLCUM ALETI BOZUK: gecmis okunamadi HTTP ${res.status()} — `
      + `${(await res.text()).slice(0, 160)}`,
    );
  }
  const body = await res.json() as unknown;
  const rows: Array<{ content?: string }> = Array.isArray(body)
    ? body as Array<{ content?: string }>
    : Array.isArray((body as { messages?: unknown }).messages)
      ? (body as { messages: Array<{ content?: string }> }).messages
      : [];
  return rows.map((r) => String(r?.content ?? ''));
}

async function unreadCountFor(
  request: import('@playwright/test').APIRequestContext, token: string, cid: string,
): Promise<number | null> {
  const res = await apiRequest(request, 'GET', '/api/notification-prefs/unread', undefined, token);
  if (!res.ok()) return null;
  const body = await res.json() as { channels?: Array<{ channelId?: string; count?: number }> };
  const row = (body.channels ?? []).find((c) => String(c?.channelId) === cid);
  return row ? Number(row.count ?? 0) : 0;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ════════════════════════════════════════════════════════════════════════════
// ÜRÜNÜN SOKET KORUMALARI — GEVŞETİLMEZ, UYULUR
// ════════════════════════════════════════════════════════════════════════════
// İlk harness bu iki gerçek limiti ihlal ediyordu ve ölçtüğü şey işkence
// değil, LİMİTİN KENDİSİ olurdu:
//
//   · `RL_SOCKET_CONNECT_MAX` = 20 bağlantı / dakika / IP
//     (`server/socket/ipRateLimit.ts`)
//   · `MAX_WS_PER_USER` = 5 EŞZAMANLI soket / kullanıcı
//     (`server/socket/middleware/wsConnectionLimit.ts`)
//
// İkisi de DOĞRU korumalardır. Çözüm limiti büyütmek DEĞİL, harness'in
// gerçek bir istemci gibi davranmasıdır: açılışlar 3.2 sn aralıklıdır
// (19/dk — sınırın altında) ve her senaryo KENDİ soketlerini kapatır,
// böylece eşzamanlı sayı hiçbir zaman 5'e yaklaşmaz.
const SOCKET_OPEN_GAP_MS = 3_200;
let _lastSocketOpenAt = 0;
async function paceSocketOpen(): Promise<void> {
  const wait = _lastSocketOpenAt + SOCKET_OPEN_GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
  _lastSocketOpenAt = Date.now();
}

/** Ürünün IP bütçesine UYARAK soket açar. Bekleme ÖLÇÜMÜN DIŞINDADIR. */
async function openPaced(token: string): Promise<Socket> {
  await paceSocketOpen();
  return openSocket(token);
}

/** Senaryo boyunca açılan soketleri toplar ve senaryo biterken kapatır. */
function socketScope(): { open: (tk: string) => Promise<Socket>; close: () => void } {
  const owned: Socket[] = [];
  return {
    open: async (tk: string) => { const s = await openPaced(tk); owned.push(s); return s; },
    close: () => closeSockets(...owned),
  };
}

// ════════════════════════════════════════════════════════════════════════════

test('gercek zamanli iskence — nihai durum dogrulugu', async ({ request }) => {
  test.setTimeout(15 * 60_000);
  test.skip(Boolean(fixtureError), `fikstur kurulamadi: ${fixtureError}`);

  try {
    // ══════════════════════════════════════════════════════════════════════
    // T1 — YENİDEN BAĞLANMA FIRTINASI
    // ══════════════════════════════════════════════════════════════════════
    // Determinist: 24 kez İSTENEREK kopar, her seferinde yeniden bağlan ve
    // gecikmeyi ölç. `openSocket` `connect`i DEĞİL `userAuthenticated`i
    // bekler — yani soket gerçekten KULLANILABİLİR olduğunda ölçüm biter.
    {
      const s = scenario('T1', 'yeniden baglanma firtinasi (20 dongu)');
      const latencies: number[] = [];
      let failures = 0;
      for (let i = 0; i < 20; i++) {
        try {
          const { socket, ms } = await timedOpen(T.bob);
          latencies.push(ms);
          socket.disconnect();
        } catch {
          failures += 1;
        }
      }
      s.check(B.reconnectFailures, failures);
      if (latencies.length > 0) {
        s.check(B.reconnectP50, percentile(latencies, 50));
        s.check(B.reconnectP95, percentile(latencies, 95));
        s.info('en yuksek', Math.max(...latencies), 'ms');
        s.info('ornek', latencies.length, ' adet');
      }
      s.end();
    }

    // ══════════════════════════════════════════════════════════════════════
    // T2 — ÇEVRİMDIŞI PENCERE: KAYIP YOK, ÇİFTLENME YOK
    // ══════════════════════════════════════════════════════════════════════
    // Bob koparken Alice ve Carol yazmaya devam eder. Bob döndüğünde
    // SUNUCUNUN GERÇEĞİ okunur ve küme eşitliği aranır: yazılan her mesaj
    // TAM BİR KEZ vardır. Bu, "soket bağlandı" değil, NİHAİ DURUM testidir.
    {
      const s = scenario('T2', 'cevrimdisi pencere — kayip/ciftlenme');
      const sc = socketScope();
      const alice = await sc.open(T.alice);
      const carol = await sc.open(T.carol);
      await joinChannelConfirmed(alice, channelId, serverId);
      await joinChannelConfirmed(carol, channelId, serverId);

      const tag = `t2-${Date.now().toString(36)}`;
      const expected: string[] = [];
      for (let i = 0; i < 8; i++) {
        const content = `${tag}-${i}`;
        const who = i % 2 === 0 ? { s: alice, k: 'alice', t: T.alice } : { s: carol, k: 'carol', t: T.carol };
        const ack = await sendPaced(who.s, who.k, content, `${tag}-ack-${i}`);
        if (ack) expected.push(content);
      }

      const t0 = Date.now();
      const bob = await sc.open(T.bob);
      const seen = await historyContents(request, T.bob);
      const convergedMs = Date.now() - t0;

      const mine = seen.filter((c) => c.startsWith(tag));
      const counts = new Map<string, number>();
      for (const c of mine) counts.set(c, (counts.get(c) ?? 0) + 1);

      const lost = expected.filter((c) => !counts.has(c)).length;
      const dup = [...counts.values()].reduce((n, v) => n + Math.max(0, v - 1), 0);

      s.check(B.lostMessages, lost);
      s.check(B.duplicateMessages, dup);
      s.check(B.convergenceMs, convergedMs);
      s.info('gonderilen', expected.length, ' adet');
      s.info('yakinsayan', counts.size, ' adet');
      bob.disconnect();
      sc.close();
      s.end();
    }

    // ══════════════════════════════════════════════════════════════════════
    // T3 — DÜŞEN ACK → İSTEMCİ TEKRARI (İDEMPOTENSİ)
    // ══════════════════════════════════════════════════════════════════════
    // En sinsi gerçek zamanlı kusur budur: mesaj YAZILDI ama ack yolda
    // kayboldu; istemci "gitmedi" sanıp AYNI mesajı tekrar yollar. Kusurlu
    // bir sunucu iki satır üretir ve kullanıcı mesajını İKİ KEZ görür.
    //
    // Determinist enjeksiyon: aynı `ackId` ile İKİ KEZ emit edilir.
    // Beklenen sözleşme (`server/socket/handlers/messages-send.ts`):
    // ikinci istek YENİ SATIR ÜRETMEZ ve AYNI `messageId`i geri verir.
    {
      const s = scenario('T3', 'dusen ACK sonrasi tekrar — idempotensi');
      const sc = socketScope();
      const alice = await sc.open(T.alice);
      await joinChannelConfirmed(alice, channelId, serverId);

      const tag = `t3-${Date.now().toString(36)}`;
      const ackId = `${tag}-fixed-ack`;
      const content = `${tag}-tekil`;

      const first = await sendPaced(alice, 'alice', content, ackId);
      // İkinci deneme: istemci ack'i GÖRMEDİ varsayımıyla AYNI ackId.
      const second = await sendPaced(alice, 'alice', content, ackId);

      if (!first || !second) {
        s.fail('ack alinamadi — idempotensi olculemedi');
      } else {
        s.check(B.ackReplayMismatch, first.messageId === second.messageId ? 0 : 1);
        const rows = (await historyContents(request, T.alice)).filter((c) => c === content);
        // ILK KOSUMDA BURASI BOS GECIYORDU: okuma sifir satir donduruyor,
        // `max(0, 0-1)` = 0 oluyor ve senaryo hicbir sey olcmeden PASS
        // veriyordu. Dogru olcut MUTLAK SAPMADIR: 0 satir da (kayip),
        // 2 satir da (ciftlenme) kusurdur. Tam olarak 1 beklenir.
        s.check(B.ackReplayExtraRows, Math.abs(rows.length - 1));
        s.info('ayni icerikli satir', rows.length, ' adet');
      }
      sc.close();
      s.end();
    }

    // ══════════════════════════════════════════════════════════════════════
    // T4 — ÇİFT ODA ÜYELİĞİ
    // ══════════════════════════════════════════════════════════════════════
    // `channel:join` ack'siz bir fire-and-forget olaydır; gerçek istemci
    // yeniden bağlanma dalgasında bunu birden çok kez yayabilir. Oda üyeliği
    // küme (Set) değil de liste olsaydı, her mesaj ABONELİK SAYISI KADAR
    // teslim edilirdi. Determinist enjeksiyon: üç kez join.
    {
      const s = scenario('T4', 'cift oda uyeligi — teslimat ciftlenmesi');
      const sc = socketScope();
      const alice = await sc.open(T.alice);
      const bob = await sc.open(T.bob);
      await joinChannelConfirmed(alice, channelId, serverId);
      await joinChannelConfirmed(bob, channelId, serverId);
      bob.emit('channel:join', channelId);
      bob.emit('channel:join', channelId);
      await sleep(600);

      const tag = `t4-${Date.now().toString(36)}`;
      const received = new Map<string, number>();
      bob.on('message:new', (m: { content?: string }) => {
        const c = String(m?.content ?? '');
        if (c.startsWith(tag)) received.set(c, (received.get(c) ?? 0) + 1);
      });

      const sent: string[] = [];
      for (let i = 0; i < 4; i++) {
        const content = `${tag}-${i}`;
        if (await sendPaced(alice, 'alice', content, `${tag}-ack-${i}`)) sent.push(content);
      }
      await sleep(1_500);

      const dup = [...received.values()].reduce((n, v) => n + Math.max(0, v - 1), 0);
      s.check(B.doubleJoinDuplicates, dup);
      s.info('gonderilen', sent.length, ' adet');
      s.info('teslim edilen benzersiz', received.size, ' adet');
      bob.disconnect();
      sc.close();
      s.end();
    }

    // ══════════════════════════════════════════════════════════════════════
    // T5 — ÇOK SEKMELİ YAKINSAMA
    // ══════════════════════════════════════════════════════════════════════
    // Aynı kullanıcı iki sekme açar. HER İKİ sekme de her mesajı TAM BİR KEZ
    // görmelidir: biri eksik görürse kullanıcı sekmeler arası tutarsızlık
    // yaşar, biri fazla görürse mesaj çiftlenir.
    {
      const s = scenario('T5', 'cok sekmeli yakinsama (2 sekme)');
      const sc = socketScope();
      const alice = await sc.open(T.alice);
      const tab1 = await sc.open(T.bob);
      const tab2 = await sc.open(T.bob);
      await joinChannelConfirmed(alice, channelId, serverId);
      await joinChannelConfirmed(tab1, channelId, serverId);
      await joinChannelConfirmed(tab2, channelId, serverId);

      const tag = `t5-${Date.now().toString(36)}`;
      const seen = [new Map<string, number>(), new Map<string, number>()];
      [tab1, tab2].forEach((sock, idx) => {
        sock.on('message:new', (m: { content?: string }) => {
          const c = String(m?.content ?? '');
          if (c.startsWith(tag)) seen[idx].set(c, (seen[idx].get(c) ?? 0) + 1);
        });
      });

      const sent: string[] = [];
      for (let i = 0; i < 4; i++) {
        const content = `${tag}-${i}`;
        if (await sendPaced(alice, 'alice', content, `${tag}-ack-${i}`)) sent.push(content);
      }
      await sleep(1_500);

      let loss = 0; let dup = 0;
      for (const map of seen) {
        loss += sent.filter((c) => !map.has(c)).length;
        dup += [...map.values()].reduce((n, v) => n + Math.max(0, v - 1), 0);
      }
      s.check(B.tabLoss, loss);
      s.check(B.tabDuplicates, dup);
      s.info('sekme 1 benzersiz', seen[0].size, ' adet');
      s.info('sekme 2 benzersiz', seen[1].size, ' adet');
      tab1.disconnect(); tab2.disconnect();
      sc.close();
      s.end();
    }

    // ══════════════════════════════════════════════════════════════════════
    // T6 — KAÇIRILAN BAHSETME YAKINSAMASI (ÇEVRİMDIŞI PATLAMA)
    // ══════════════════════════════════════════════════════════════════════
    // ── İLK KOŞUMDA BU SENARYO YANLIŞ ŞEYİ ÖLÇÜYORDU ──────────────────────
    // Düz (bahsetmesiz) K mesajın `unread_counts`u K artırmasını bekliyordum
    // ve 0 ölçüp "sapma 5" diye raporladım. ÜRÜNÜ okuyunca sözleşme netleşti:
    // `unread_counts`, `lib/notifications.ts`te YALNIZCA dikkat olayları için
    // (`insertChannelAttention` → `incrementUnread`) yazılır; yani BAHSETME
    // ve İZLEME SÖZCÜĞÜ. Düz mesajın kanal rozeti istemcide canlı olaydan
    // üretilir (`client/js/core/unread-svelte.ts:onMessageNew`).
    //
    // Yani ölçtüğüm sapma bir ürün kusuru DEĞİL, benim ürünün hiç vermediği
    // bir sözü ölçmemdi. Eşiği gevşetmek YANLIŞ olurdu; ölçüm ÜRÜNÜN GERÇEK
    // SÖZLEŞMESİNE çevrildi — ve bu, kullanıcı için en pahalı gerçek zamanlı
    // kusurdur: ÇEVRİMDIŞIYKEN GELEN BAHSETME KAYBOLURSA kullanıcı kendisine
    // yazıldığını HİÇ öğrenemez.
    //
    // Sözleşme: Bob tamamen çevrimdışıyken K kez bahsedilir; döndüğünde
    // yetkili anlık görüntü TAM OLARAK K göstermelidir. Eksikse bahsetme
    // kaybolur, fazlaysa sahte rozet çıkar. "Yaklaşık" KABUL EDİLMEZ.
    {
      const s = scenario('T6', 'kacirilan bahsetme yakinsamasi — cevrimdisi patlama');
      const sc = socketScope();
      const stamp = Date.now().toString(36);
      const bobUsername = String((T.users as Record<string, { username?: string }> | undefined)
        ?.bob?.username ?? '');
      const ch2 = await createTestChannel(request, T.alice, serverId, `rt-un-${stamp}`, 'text');
      const unreadChannelId = String(ch2?._id ?? ch2?.id ?? '');

      if (!unreadChannelId) {
        s.block('ikinci kanal olusturulamadi (hiz siniri) — bahsetme yakinsamasi olculemedi');
      } else if (!bobUsername) {
        s.block('bob kullanici adi fiksturde yok — bahsetme uretilemedi');
      } else {
        const before = await unreadCountFor(request, T.bob, unreadChannelId) ?? 0;
        const alice = await sc.open(T.alice);
        await joinChannelConfirmed(alice, unreadChannelId, serverId);

        const K = 4;
        let delivered = 0;
        for (let i = 0; i < K; i++) {
          await paceSends('alice', 1_400);
          const ackId = `t6-${stamp}-${i}`;
          const got = await new Promise<boolean>((resolve) => {
            const timer = setTimeout(() => { alice.off('message:ack', onAck); resolve(false); }, 12_000);
            function onAck(d: { ackId?: string }) {
              if (d?.ackId !== ackId) return;
              clearTimeout(timer); alice.off('message:ack', onAck); resolve(true);
            }
            alice.on('message:ack', onAck);
            alice.emit('message:send', {
              channelId: unreadChannelId, serverId,
              content: `@${bobUsername} t6-${stamp}-${i}`, ackId,
            });
          });
          if (got) delivered += 1;
        }

        const t0 = Date.now();
        let observed: number | null = null;
        let convergeMs = 0;
        for (let i = 0; i < 30; i++) {
          observed = await unreadCountFor(request, T.bob, unreadChannelId);
          convergeMs = Date.now() - t0;
          if (observed !== null && observed - before >= delivered) break;
          await sleep(500);
        }
        const drift = Math.abs((observed ?? 0) - before - delivered);
        s.check(B.unreadDrift, drift);
        s.check(B.unreadConvergeMs, convergeMs);
        s.info('bahsedilen', delivered, ' adet');
        s.info('olculen artis', (observed ?? 0) - before, ' adet');
      }
      sc.close();
      s.end();
    }

    // ══════════════════════════════════════════════════════════════════════
    // T7 — VARLIK YAKINSAMASI
    // ══════════════════════════════════════════════════════════════════════
    // Bob 10 kez bağlanıp kopar. Alice `server:<id>` odasından `user:status`
    // görür. Önemli olan olay SAYISI değil, NİHAİ DURUMUN DOĞRU olması ve
    // bayat pencerenin SINIRLI kalmasıdır.
    {
      const s = scenario('T7', 'varlik yakinsamasi — 8 kopma/donme');
      const sc = socketScope();
      const alice = await sc.open(T.alice);

      let lastStatus = '';
      let lastAt = 0;
      alice.on('user:status', (d: { userId?: string; status?: string }) => {
        if (bobUserId && String(d?.userId) !== bobUserId) return;
        lastStatus = String(d?.status ?? '');
        lastAt = Date.now();
      });

      for (let i = 0; i < 8; i++) {
        const sock = await openPaced(T.bob);
        await sleep(150);
        sock.disconnect();
        await sleep(150);
      }

      // Son kopma sonrası nihai durumun YAKINSAMASI beklenir.
      const t0 = Date.now();
      let staleMs = 0;
      for (let i = 0; i < 40; i++) {
        staleMs = Date.now() - t0;
        if (lastStatus && lastStatus !== 'online' && lastAt >= t0 - 3_000) break;
        await sleep(250);
      }

      if (!bobUserId) {
        // Suzgec kurulamadiysa olculen sey BASKA bir kullanicinin olayi
        // olabilir. Zayif bir PASS uretmektense durust bir BLOCKED verilir.
        s.block('bob kimligi okunamadi — varlik olayi kullanici bazinda suzulemedi');
      }
      s.check(B.presenceStaleMs, staleMs);
      // Nihai durum "online" KALMAMALIDIR: Bob koptu.
      s.check(B.presenceWrongFinal, lastStatus === 'online' ? 1 : 0);
      s.info('nihai varlik', lastStatus === '' ? 0 : 1, lastStatus ? ` (${lastStatus})` : ' (olay yok)');
      sc.close();
      s.end();
    }

    // ══════════════════════════════════════════════════════════════════════
    // T8 — YAZIYOR FIRTINASI
    // ══════════════════════════════════════════════════════════════════════
    // 120 hızlı `typing:start`/`typing:stop`. Sunucunun bunların HEPSİNİ
    // yayması BEKLENMEZ — soket hız sınırı doğru davranıştır ve burada
    // GEVŞETİLMEZ. Aranan şey: soket ÖLMEZ ve nihai durum "yazmıyor"a
    // yakınsar, yani kullanıcıda takılı bir "yazıyor…" göstergesi kalmaz.
    {
      const s = scenario('T8', 'yaziyor firtinasi (120 olay)');
      const sc = socketScope();
      const alice = await sc.open(T.alice);
      const bob = await sc.open(T.bob);
      await joinChannelConfirmed(alice, channelId, serverId);
      await joinChannelConfirmed(bob, channelId, serverId);

      if (!bobUserId) s.block('bob kimligi okunamadi — yaziyor olayi suzulemedi');
      let lastTyping: boolean | null = null;
      alice.on('typing:update', (d: { userId?: string; typing?: boolean }) => {
        if (bobUserId && String(d?.userId) !== bobUserId) return;
        lastTyping = Boolean(d?.typing);
      });

      for (let i = 0; i < 60; i++) {
        bob.emit('typing:start', { channelId });
        bob.emit('typing:stop', { channelId });
      }
      await sleep(2_500);

      s.check(B.typingSocketDeaths, (bob.connected ? 0 : 1) + (alice.connected ? 0 : 1));

      // ── KAPSAM DÜZELTMESİ (ilk koşumda burada YANLIŞ ŞEY ölçülüyordu) ────
      // İlk sürüm "kablodaki son olay `typing:true` ise KUSUR" diyordu ve
      // düşüyordu. ÜRÜNÜ okuyunca bunun yanlış kapsam olduğu görüldü:
      //
      //     client/js/core/MessageLoader.svelte:299
      //     // Emniyet: stop event'i kaybolursa gösterge takılı kalmasın.
      //     typingTimers.set(userId, setTimeout(..., 8000));
      //
      // Yani `typing:stop` kaybolsa bile kullanıcının EKRANI 8 saniyede
      // kendini temizler; kimse sonsuza dek "Bob yazıyor…" görmez. Kablonun
      // son olayı tek başına bir kusur DEĞİLDİR — önemli olan bayat
      // pencerenin SINIRLI olmasıdır.
      //
      // Bütçe gevşetilmedi; ölçüm DOĞRU KATMANA taşındı. Kullanıcıya görünen
      // yakınsama `typing-convergence.spec.ts` içinde GERÇEK TARAYICIDA,
      // `typing:stop` KASITLI OLARAK HİÇ gönderilmeden doğrulanır.
      s.info('kablodaki son yaziyor durumu', lastTyping === null ? -1 : lastTyping ? 1 : 0,
        ' (-1 olay yok; kullanici gorunumu typing-convergence.spec.ts)');
      sc.close();
      s.end();
    }
  } finally {
    // Senaryolar kendi soketlerini kapatir; burada kalan bir sey olmamalidir.
  }

  // ══════════════════════════════════════════════════════════════════════
  // YARGI — BÜTÇELER KOŞUMDAN ÖNCE TANIMLIYDI, OYNATILMADI
  // ══════════════════════════════════════════════════════════════════════
  const summary = writeTortureReport();
  // BLOCKED bir senaryonun icindeki asilmis butce de SAYILIR — "bloke"
  // etiketi bir bütce ihlalini gizlemek icin kullanilamaz.
  const failed = tortureResults()
    .filter((r) => r.measurements.some((m) => m.verdict === 'FAIL'));
  const detail = failed.map((f) => {
    const broken = f.measurements.filter((m) => m.verdict === 'FAIL')
      .map((m) => `${m.label}=${m.value}${m.unit} (butce <= ${m.budgetMax}${m.unit})`).join(', ');
    return `${f.id} [${f.status}] ${f.name}: ${broken}`;
  }).join('\n');

  expect(summary.fail, `Gercek zamanli bütce asildi:\n${detail}`).toBe(0);
});
