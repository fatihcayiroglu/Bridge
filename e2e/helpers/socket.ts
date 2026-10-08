// e2e/helpers/socket.ts — Socket.IO test yardımcıları
// Kullanım:
//   const alice = await openSocket(tokens.alice);
//   const event = await waitForEvent<VoiceUpdate>(bob, 'voice:room-update');
//   alice.disconnect();

import { io, Socket } from 'socket.io-client';
import fs from 'fs';
import path from 'path';

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:3000';

/**
 * Kimlik doğrulamalı bir Socket.IO bağlantısı açar.
 * Bağlantı başarılı olana kadar bekler; hata olursa reject eder.
 */
export function openSocket(token: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = io(BASE_URL, {
      auth:         { token },
      transports:   ['websocket'],
      reconnection: false,
      timeout:      8_000,
    });
    // `connect` YETMEZ: sunucu, soket→kullanici eslemesini (`socketUsers`)
    // bir DB okumasindan SONRA kurar (socket/index.ts) ve bitince
    // `userAuthenticated` yayar. `connect`te emit etmeye baslamak, hedefi
    // henuz kayitli olmayan bir kullaniciya sinyal gondermek demektir:
    // `findSocketsForUser()` bos doner ve olay SESSIZCE kaybolur.
    //
    // Bu yalnizca test kolayligi degil — ayni yaris gercek istemcide de
    // vardir; kanonik istemci bu yuzden `bridge:socket-ready` bekler.
    socket.once('connect', () => {
      // Sunucu bu olayi yaymazsa (eski surum) baglantiyi yine de veririz.
      const fallback = setTimeout(() => resolve(socket), 1_500);
      socket.once('userAuthenticated', () => { clearTimeout(fallback); resolve(socket); });
    });
    socket.once('connect_error', (err) => reject(err));
  });
}

/**
 * Belirtilen event gelene kadar bekler.
 * timeoutMs içinde gelmezse hata fırlatır.
 *
 * `match` verilirse yalnızca ona uyan olay kabul edilir (Final21 Faz 19): `message:ack`
 * gönderene özeldir ama SIRASI garanti değildir — `joinChannelConfirmed` sondasının yayını
 * kendi ack'inden ÖNCE gelebilir ve "bir sonraki ack"i bekleyen gönderim o geç ack'i yutardı.
 */
export function waitForEvent<T = unknown>(
  socket:    Socket,
  event:     string,
  timeoutMs  = 5_000,
  match?:    (data: T) => boolean,
): Promise<T> {
  return new Promise((resolve, reject) => {
    // ÖNEMLİ: zaman aşımında dinleyiciyi MUTLAKA kaldır.
    // Aksi halde `once` dinleyicisi socket üzerinde asılı kalır ve BİR SONRAKİ
    // olayı sessizce yutar (kendisi zaten reddedilmiş bir promise'e bağlıdır).
    // Bu, tek bir zaman aşımının ardışık testleri de düşürdüğü zincirleme
    // hataya yol açıyordu.
    const onEvent = (data: T) => {
      if (match && !match(data)) return;
      clearTimeout(timer);
      socket.off(event, onEvent);
      resolve(data);
    };
    const timer = setTimeout(() => {
      socket.off(event, onEvent);
      reject(new Error(`Timeout: "${event}" olayı ${timeoutMs}ms içinde gelmedi`));
    }, timeoutMs);
    socket.on(event, onEvent);
  });
}

/**
 * Birden fazla socket'i tek seferde kapatır.
 */
export function closeSockets(...sockets: Socket[]): void {
  for (const s of sockets) {
    try { s.disconnect(); } catch { /* zaten kapalı */ }
  }
}

/**
 * `channel:join` KANONİK olarak ack'siz bir fire-and-forget event'tir:
 * sunucu tarafında kanal/üyelik/görünürlük denetimleri asenkron çalışır ve
 * başarı için istemciye hiçbir olay dönmez. Bu yüzden "emit + sabit sleep"
 * yarışa açıktır — odaya girilmeden yapılan edit/react/delete testleri
 * yayını hiç görmez.
 *
 * Burada odaya girildiğini ÜRÜNÜN KENDİ olayıyla doğruluyoruz: sonda bir
 * mesaj gönderip `message:new` yayınının bize ulaşmasını bekliyoruz —
 * bu yayın yalnızca `channel:<id>` odasına gider.
 *
 * Not: Sonda mesajı gerçek bir mesajdır; testler bunu içerik filtresiyle
 * ayırt edebilsin diye ayırt edici bir önek taşır.
 */
export async function joinChannelConfirmed(
  socket: Socket,
  channelId: string,
  serverId: string,
  attempts = 6,
  paceKey?: string,
): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    socket.emit('channel:join', channelId);
    // Join probes are real messages: pace each one with the sender's key.
    if (paceKey) await paceSends(paceKey);
    const probe = `__e2e_join_probe__ ${Date.now()}-${i}`;
    const seen = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => { socket.off('message:new', onNew); resolve(false); }, 1_500);
      function onNew(msg: { content?: string }) {
        if (msg?.content === probe) {
          clearTimeout(timer);
          socket.off('message:new', onNew);
          resolve(true);
        }
      }
      socket.on('message:new', onNew);
      socket.emit('message:send', {
        channelId, serverId, content: probe, ackId: `join-probe-${Date.now()}-${i}`,
      });
    });
    if (seen) return;
  }
  throw new Error(`channel:join doğrulanamadı — socket ${channelId} odasına giremedi`);
}

// ── Anti-spam uyumlu gönderim hızı ───────────────────────────────────────────
// Üretimdeki anti-spam politikası: 4 saniyede 5 mesajı aşan kullanıcı önce
// uyarılır, sonra 30 SANİYE susturulur (server/lib/security.ts SPAM_CONFIG).
// Susturulan gönderimler `error:spam` döner ve HİÇ ack üretmez — testler bunu
// "message:ack timeout" olarak görüyordu. Bu doğru ürün davranışıdır; testler
// insan hızında göndermelidir.
const _lastSendAt = new Map<string, number>();

// ══════════════════════════════════════════════════════════════════════════
// SÜREÇLER ARASI HIZ AYARI — PARALEL İŞÇİ ÇEKİŞMESİNİN GERÇEK SEBEBİ
// ══════════════════════════════════════════════════════════════════════════
// `_lastSendAt` MODÜL düzeyinde bir Map'tir; yani her Playwright İŞÇİ
// SÜRECİNDE AYRI bir kopyası vardır. `playwright.config.ts` yerelde
// `workers: 2` kullanır ve spec'lerin çoğu AYNI kimliği (alice) sürer.
// Sonuç: iki süreç birbirinden habersiz gönderim yapar ve kullanıcı başına
// gerçek hız İKİYE KATLANIR.
//
// Ürünün anti-spam politikası (server/lib/security.ts):
//     SPAM_CONFIG = { maxMessages: 5, windowMs: 4000 }
//     eşik aşılınca kullanıcı 30 SANİYE susturulur; susturulan gönderim
//     `error:spam` döner ve HİÇ `message:ack` üretmez.
//
// ÖLÇÜLEN BELİRTİLER (koşumdan koşuma yer değiştiriyordu):
//   · "channel:join doğrulanamadı — socket <id> odasına giremedi"
//     (`joinChannelConfirmed` sonda kendi mesajını hiç göremiyor)
//   · optimistic mesaj hiç uzlaşmıyor → `waitForFunction` 20 sn zaman aşımı
//
// KANIT: tam paket TEK işçiyle 332/0 (temiz), iki işçiyle koşumda bir
// başarısızlık — hep FARKLI bir testte. Klasik çekişme imzası.
//
// ÜRÜN SINIRI DOĞRUDUR ve DEĞİŞTİRİLMEZ: gerçek bir kullanıcı 4 saniyede 5
// mesajı aşmaz. Düzeltilmesi gereken, harness'in kendi hız ayarının
// süreçler arasında GÖRÜNMEZ olmasıydı. Aşağıdaki kilit, aynı kullanıcı için
// ayrılan gönderim yuvasını TÜM işçiler arasında paylaşır.
const PACE_DIR = path.join(__dirname, '..', 'fixtures', '.pace');

/** Yuvayı ATOMİK ayır: kilit dosyası `wx` ile yalnızca tek süreçte açılır. */
async function reserveSendSlot(key: string, minGapMs: number): Promise<number> {
  const safe = key.replace(/[^a-zA-Z0-9_-]/g, '_');
  const stamp = path.join(PACE_DIR, `${safe}.stamp`);
  const lock = path.join(PACE_DIR, `${safe}.lock`);
  try { fs.mkdirSync(PACE_DIR, { recursive: true }); } catch { /* zaten var */ }

  for (let attempt = 0; attempt < 400; attempt++) {
    let fd: number | undefined;
    try {
      fd = fs.openSync(lock, 'wx');            // EEXIST → başka işçi tutuyor
      let last = 0;
      try { last = parseInt(fs.readFileSync(stamp, 'utf8'), 10) || 0; } catch { /* ilk kez */ }
      const now = Date.now();
      const slot = Math.max(now, last + minGapMs);
      fs.writeFileSync(stamp, String(slot));   // yuvayı ÖNCEDEN ayır
      return slot - now;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      await new Promise((r) => setTimeout(r, 15));
    } finally {
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch { /* yoksay */ }
        try { fs.unlinkSync(lock); } catch { /* yoksay */ }
      }
    }
  }
  // Kilit alınamadıysa güvenli tarafta kal: tam aralık kadar bekle.
  return minGapMs;
}

/**
 * Aynı kullanıcı için ardışık gönderimler arasında en az `minGapMs` bırakır.
 * ÖNEMLİ: anahtar KULLANICI başına olmalıdır (bağlam/spec başına değil) —
 * anti-spam sayacı kullanıcı bazlıdır ve spec dosyaları arasında paylaşılır.
 * Bekleme SÜREÇLER ARASINDA koordine edilir; bkz. yukarıdaki not.
 */
export async function paceSends(key: string, minGapMs = 1_100): Promise<void> {
  const wait = await reserveSendSlot(key, minGapMs);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  _lastSendAt.set(key, Date.now());
}

/**
 * `error:spam` / `error:message` olaylarını yakalayıp anlaşılır hata üretir.
 * Aksi halde bu durumlar sessiz bir ack zaman aşımı gibi görünür.
 */
export function attachSendDiagnostics(socket: Socket, label = 'socket'): void {
  socket.on('error:spam', (d: { reason?: string; remainingMs?: number }) => {
    // eslint-disable-next-line no-console
    console.error(`[e2e] ${label} anti-spam engeli: ${d?.reason} (${d?.remainingMs}ms)`);
  });
  socket.on('error:message', (d: { code?: string; message?: string }) => {
    // eslint-disable-next-line no-console
    console.error(`[e2e] ${label} error:message: ${d?.code} — ${d?.message}`);
  });
  socket.on('error:ratelimit', (d: { event?: string }) => {
    // eslint-disable-next-line no-console
    console.error(`[e2e] ${label} rate limit: ${d?.event}`);
  });
}
