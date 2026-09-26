// server/socket/handler-contracts.ts
//
// ════════════════════════════════════════════════════════════════════════════
// SOKET HANDLER'LARININ İHTİYAÇ SÖZLEŞMELERİ (ARAYÜZ AYRIŞTIRMASI)
// ════════════════════════════════════════════════════════════════════════════
//
// Handler'lar `socket.io`nun TAM `Socket` / `Server` tipini parametre olarak
// alıyordu. Oysa `dm.ts` bu tipten yalnızca YEDİ üye kullanıyor:
//
//     on · emit · id · to · rooms · join · leave
//
// Geri kalan ~68 üye (`nsp`, `client`, `handshake`, `recovered`, ...) hiç
// okunmuyor. Bunları imzada talep etmenin iki somut bedeli var:
//
//   1. ÜRÜN TARAFI — imza, handler'ın gerçekte neye bağlı olduğunu SAKLAR.
//      İleride biri `socket.client.conn` yazsa imza değişmez; bağımlılık
//      sessizce büyür.
//   2. TEST TARAFI — 68 üyeyi taklit etmek mümkün olmadığı için test ikizleri
//      tipe UYAMAZ. Ölçüldü: bu tek sebep 6 dosyada 82 strict hatası
//      üretiyordu. Alışılmış "çözüm" `as any` yazmaktır; o da tipi tamamen
//      kaybettirir.
//
// Buradaki sözleşmeler İHTİYACI yazar. Gerçek `socket.io` tipleri bu
// sözleşmeleri karşılamaya DEVAM etmek zorundadır — bu, aşağıdaki
// `assert*Compatible` fonksiyonlarıyla DERLEME ZAMANINDA kanıtlanır
// (dönüştürme yoktur: fonksiyon gövdesi gerçek tipi sözleşme tipine
// atayabiliyorsa uyum vardır, atayamıyorsa derleme kırılır).

import type { Server as IOServer, Socket as IOSocket } from 'socket.io';

/** Bir yayım hedefi — `socket.to(room)` / `io.to(room)` bunu döndürür. */
export interface EmitTarget {
  emit(event: string, ...args: unknown[]): unknown;
}

/** Handler'ların bir istemci soketinden kullandığı yüzey. */
export interface HandlerSocket {
  readonly id: string;
  /** Soketin bulunduğu odalar; handler'lar `has` / yineleme / yayılım yapar. */
  readonly rooms: Set<string>;
  /**
   * Dinleyici parametreleri `unknown`tur — `any` DEĞİL.
   *
   * Ağdan gelen yük GÜVENİLMEZDİR ve handler'lar zaten ilk satırda daraltma
   * yapıyor (`const raw = payload as { ... } | null`). `any` bu daraltmayı
   * İSTEĞE BAĞLI kılıyordu; `unknown` ZORUNLU kılar.
   */
  on<A extends unknown[] = unknown[]>(event: string, listener: (...args: A) => unknown): unknown;
  emit(event: string, ...args: unknown[]): unknown;
  join(room: string): unknown;
  leave(room: string): unknown;
  to(room: string): EmitTarget;
  once?<A extends unknown[] = unknown[]>(event: string, listener: (...args: A) => unknown): unknown;
  disconnect?(close?: boolean): unknown;

  // ── Projeye özgü alanlar ────────────────────────────────────────────────
  // `types/global.d.ts` bunları `socket.io`nun `Socket` arayüzüne ekliyor.
  // Sözleşmede İSTEĞE BAĞLIdırlar: kimlik doğrulama ara katmanı çalışmadan
  // önce gerçekten YOKturlar; zorunlu yazmak, var olmayan bir garantiyi
  // varmış gibi gösterirdi.
  userId?: string;
  username?: string;
  isBot?: boolean;
  botId?: string;
  botServerId?: string;
  currentVoiceChannel?: string | null;
  currentVoiceServer?: string | null;
  currentStageChannel?: string;
}

/**
 * Handler'ların sunucu nesnesinden kullandığı EN KÜÇÜK yüzey: odaya yayın.
 *
 * Daha fazlasına ihtiyaç duyan modüller aşağıdaki GENİŞLETİLMİŞ sözleşmelerden
 * birini alır. Böylece "hangi handler sunucunun hangi yeteneğine bağlı?"
 * sorusunun cevabı imzada yazılı olur — ve test ikizleri yalnızca gerçekten
 * kullanılan yüzeyi kurmak zorunda kalır.
 */
export interface HandlerServer {
  to(room: string): EmitTarget;
  /**
   * Oda kapsamı — `dm.ts` bunu ÇALIŞMA ZAMANINDA yokluğa karşı denetliyor
   * (`typeof io.in === 'function'`), çünkü bazı test ikizleri kurmuyor.
   * Sözleşme bu gerçeği isteğe bağlılıkla yazar.
   */
  in?(room: string): RoomScope;
}

/**
 * `io.in(room)` kapsamının döndürdüğü yüzey.
 *
 * Handler'lar bu kapsamdan YALNIZCA `fetchSockets()` kullanıyor; `emit` bu
 * yola hiç girmiyor. Sözleşmeye `emit` eklemek, test ikizlerini hiç
 * çağrılmayan bir üyeyi kurmaya zorlardı.
 *
 * DİKKAT — `in()` SENKRONDUR. `socket.io` kapsamı doğrudan döndürür; `Promise`
 * döndüren bir ikiz gerçeğe uymaz ve `io.in(room).fetchSockets()` yazan üretim
 * kodunda çalışmazdı.
 */
export interface RoomScope {
  fetchSockets(): Promise<Array<{ id: string }>>;
}

/** Oda kapsamını KESİN olarak kullanan modüller için (ör. bağlantı limiti). */
export interface RoomScopedServer extends HandlerServer {
  in(room: string): RoomScope;
}

/** Bağlı soketlerin kaydına erişen modüller için. */
export interface SocketRegistryServer extends HandlerServer {
  sockets: { sockets: Map<string, { id: string; userId?: string; user?: { _id: string } }> };
}

/**
 * Küme (cluster) denetimi kullanan modüller için.
 *
 * `serverSideEmit` Redis adapter'ı üzerinden DİĞER düğümlere gider; bu, tek
 * düğümlü bir ikizde taklit edilemeyen gerçek bir altyapı bağımlılığıdır ve
 * imzada görünmesi doğrudur.
 */
export interface ClusterServer extends HandlerServer {
  on<A extends unknown[] = unknown[]>(event: string, listener: (...args: A) => unknown): unknown;
  serverSideEmit(event: string, ...args: unknown[]): unknown;
}

// ── DERLEME ZAMANI UYUM KANITLARI ──────────────────────────────────────────
//
// Bu fonksiyonlar ÇAĞRILMAZ. Var olma sebepleri, gerçek `socket.io` tiplerinin
// yukarıdaki sözleşmeleri karşıladığını derleyiciye kanıtlatmaktır. socket.io
// bir gün `rooms`u `Set<string>` olmaktan çıkarsa ya da `to()` imzasını
// değiştirse, hata ÜRÜN KODUNUN DERLENMESİNDE çıkar — testlerde değil.

/** @internal derleme zamanı kanıt */
export function assertSocketCompatible(socket: IOSocket): HandlerSocket {
  return socket;
}

/** @internal derleme zamanı kanıt */
export function assertServerCompatible(io: IOServer): HandlerServer {
  return io;
}

/** @internal derleme zamanı kanıt */
export function assertRoomScopedServerCompatible(io: IOServer): RoomScopedServer {
  return io;
}

/** @internal derleme zamanı kanıt */
export function assertSocketRegistryServerCompatible(io: IOServer): SocketRegistryServer {
  return io;
}

/** @internal derleme zamanı kanıt */
export function assertClusterServerCompatible(io: IOServer): ClusterServer {
  return io;
}
