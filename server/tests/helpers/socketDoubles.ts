// server/tests/helpers/socketDoubles.ts
//
// ════════════════════════════════════════════════════════════════════════════
// SOCKET İKİZLERİ İÇİN KANONİK TİPLER VE YAYIM (EMIT) KAYDI OKUYUCULARI
// ════════════════════════════════════════════════════════════════════════════
//
// 43 test dosyası kendi `makeSocket` / `makeIo` ikizini kuruyor. Bunların
// gövdeleri BİLEREK farklı: her senaryo farklı bir yüzeyi zorluyor. Bu yüzden
// burada tek bir `makeSocket` DAYATILMAZ — dosyalar arası davranış farkları
// gerçek ve kasıtlıdır, onları tek kalıba sokmak testlerin kapsadığı durumları
// daraltırdı.
//
// Ortak olan şey ikizin GÖVDESİ değil, ikizin ÜRETTİĞİ KAYITTIR:
//
//     const emitted = [];
//     emit(ev, data) { emitted.push({ ev, data }); }
//     to(room) { return { emit(ev, data) { emitted.push({ ev, data, _room: room }); } }; }
//
// `const emitted = []` bir kapanış (closure) içinden dolduruluyor; bu, TS'in
// "evolving any" çıkarımını devre dışı bırakır ve dizi örtük `any[]` kalır.
// Ölçüldü: bu tek deyim ~20 yerde TS7034/TS7005 üretiyordu.
//
// Buradaki tipler o kaydı adlandırır; okuyucular ise testlerin en kırılgan
// satırını onarır (aşağıya bakınız).

/**
 * Bir ikizin kaydettiği tek yayım.
 *
 * Alan adları dosyadan dosyaya değişiyor (`ev` ya da `event`, `_room` ya da
 * `_target`). Bu ayrışma gerçek: bazı ikizler `socket.to(room)`, bazıları
 * `io.to(socketId)` taklit ediyor. Tip bunu gizlemek yerine ikisini de taşır.
 */
export interface EmittedEvent {
  /** `socket.emit(ev, data)` ikizlerinde olay adı. */
  ev?: string;
  /** `io.emit(event, data)` ikizlerinde olay adı. */
  event?: string;
  /**
   * Yayım yükü — `unknown`.
   *
   * İkizin `emit(ev, data)` üyesi ürün sözleşmesinden bağlamsal tip aldığı
   * için `data` burada gerçekten `unknown`tur; başka bir şey yazmak yalan
   * olurdu. Alan okumak isteyen testler `requireEmittedData()` kullanır: o
   * fonksiyon yükün NESNE olduğunu ÇALIŞMA ZAMANINDA doğrular ve ancak
   * ondan sonra okunabilir bir tip verir.
   */
  data?: unknown;
  /** `socket.to(room)` hedefi. */
  _room?: string;
  /** `io.to(socketId | user:<id>)` hedefi. */
  _target?: string;
  [key: string]: unknown;
}

/** İkizin biriktirdiği yayım kaydı — ANNOTASYON İÇİN varsayılan biçim. */
export type EmittedLog = EmittedEvent[];

/**
 * Okuyucuların kabul ettiği EN AZ yüzey.
 *
 * Dosyaların bir kısmı kendi `Emission` / `Emitted` arayüzünü tanımlıyor
 * (`{ event, payload }`, `{ ev, data }`, ...). Okuyucuları `EmittedLog`a
 * bağlamak bu dosyaları kaydı YENİDEN yazmaya zorlardı; oysa aradaki fark
 * gerçek ve zararsız. Bu yüzden okuyucular JENERİKTİR: her dosya kendi kayıt
 * tipini korur, okuyucu ona uyum sağlar ve dönüş tipi de o dosyanın tipidir —
 * yani çağıran taraf tip KAYBETMEZ.
 */
export interface EmittedLike {
  ev?: string;
  event?: string;
  data?: unknown;
  payload?: unknown;
  _target?: string;
  _room?: string;
}

/** Olay adını hangi alanda tutulursa tutulsun okur. */
export function emittedName(entry: EmittedLike): string | undefined {
  return entry.ev ?? entry.event;
}

export interface EmittedFilter {
  /** `_target` alanı bu değere eşit olmalı. */
  target?: string;
  /** `_room` alanı bu değere eşit olmalı. */
  room?: string;
}

/** Kayıtta olayı arar; bulamazsa `undefined` döner. */
export function findEmitted<T extends EmittedLike>(
  log: readonly T[],
  name: string,
  filter: EmittedFilter = {},
): T | undefined {
  return log.find((entry) => {
    if (emittedName(entry) !== name) return false;
    if (filter.target !== undefined && entry._target !== filter.target) return false;
    if (filter.room !== undefined && entry._room !== filter.room) return false;
    return true;
  });
}

/**
 * Kayıtta olayı arar; YOKSA anlaşılır bir hata fırlatır.
 *
 * Testlerde en sık görülen kırılgan satır şuydu:
 *
 *     const callId = socket._emitted.find(e => e.ev === 'dm:call:outgoing').data.callId;
 *
 * Olay hiç yayımlanmadığında bu satır `Cannot read properties of undefined`
 * verir — hangi olayın beklendiğini, bunun yerine NELERİN yayımlandığını
 * söylemez. `requireEmitted` her ikisini de söyler. Yani buradaki tip düzeltmesi
 * aynı zamanda bir TEŞHİS düzeltmesidir.
 */
export function requireEmitted<T extends EmittedLike>(
  log: readonly T[],
  name: string,
  filter: EmittedFilter = {},
): T {
  const found = findEmitted(log, name, filter);
  if (found) return found;
  const seen = log.map((entry) => emittedName(entry) ?? '<isimsiz>');
  const scope = filter.target !== undefined ? ` (_target=${filter.target})`
              : filter.room   !== undefined ? ` (_room=${filter.room})`
              : '';
  throw new Error(
    `requireEmitted: '${name}'${scope} yayimlanmadi. Kayittaki yayimlar: ` +
    (seen.length ? seen.join(', ') : '<hic yok>'),
  );
}

/** Yükün okunabilir bir nesne olduğunu ÇALIŞMA ZAMANINDA doğrular. */
function hasObjectData<T extends EmittedLike>(entry: T): entry is T & { data: Record<string, unknown> } {
  return typeof entry.data === 'object' && entry.data !== null && !Array.isArray(entry.data);
}

/**
 * Olayı bulur ve YÜKÜNÜ okunabilir biçimde döndürür.
 *
 *     requireEmitted(log, 'dm:call:outgoing').data.callId   // `data` unknown
 *     requireEmittedData(log, 'dm:call:outgoing').callId    // doğrulanmış
 *
 * Olay yoksa ya da yükü nesne değilse AÇIK bir hata fırlatır; dönen tip
 * iddia edilmez, sınanır.
 */
export function requireEmittedData<T extends EmittedLike>(
  log: readonly T[],
  name: string,
  filter: EmittedFilter = {},
): Record<string, unknown> {
  const entry = requireEmitted(log, name, filter);
  if (!hasObjectData(entry)) {
    throw new Error(
      `requireEmittedData: '${name}' yayimlandi ama yuku okunabilir bir nesne degil (${typeof entry.data}).`,
    );
  }
  return entry.data;
}

/** Yükün nesne DİZİSİ olduğunu ÇALIŞMA ZAMANINDA doğrular. */
function hasObjectListData<T extends EmittedLike>(entry: T): entry is T & { data: Array<Record<string, unknown>> } {
  return Array.isArray(entry.data) &&
    entry.data.every((item) => typeof item === 'object' && item !== null && !Array.isArray(item));
}

/**
 * Yükü nesne DİZİSİ olan olaylar için (`voice:existing-peers` gibi).
 *
 * `requireEmittedData`den ayrı durur, çünkü ikisi FARKLI sözleşmelerdir:
 * bir olayın yükünün tek nesne mi yoksa liste mi olduğu ürün davranışının
 * parçasıdır; testin hangisini beklediği yazılı olmalıdır.
 */
export function requireEmittedList<T extends EmittedLike>(
  log: readonly T[],
  name: string,
  filter: EmittedFilter = {},
): Array<Record<string, unknown>> {
  const entry = requireEmitted(log, name, filter);
  if (!hasObjectListData(entry)) {
    throw new Error(
      `requireEmittedList: '${name}' yayimlandi ama yuku nesne dizisi degil.`,
    );
  }
  return entry.data;
}

/**
 * Elde tutulan bir yayım kaydının yükünü okunabilir nesne olarak verir.
 *
 * `requireEmittedData` kaydı yeniden ARAR; `dataOf` ise zaten bulunmuş bir
 * girdiyle çalışır. İkisi de yükün nesne olduğunu ÇALIŞMA ZAMANINDA doğrular,
 * yani tip iddia edilmez.
 */
export function dataOf(entry: EmittedLike): Record<string, unknown> {
  if (!hasObjectData(entry)) {
    throw new Error(
      `dataOf: '${emittedName(entry) ?? '<isimsiz>'}' yayiminin yuku okunabilir bir nesne degil (${typeof entry.data}).`,
    );
  }
  return entry.data;
}

/** Kayıtta olayın bulunup bulunmadığını döner. */
export function hasEmitted<T extends EmittedLike>(log: readonly T[], name: string, filter: EmittedFilter = {}): boolean {
  return findEmitted(log, name, filter) !== undefined;
}

/** Olayın kaç kez yayımlandığını sayar. */
export function countEmitted<T extends EmittedLike>(log: readonly T[], name: string, filter: EmittedFilter = {}): number {
  return log.filter((entry) => {
    if (emittedName(entry) !== name) return false;
    if (filter.target !== undefined && entry._target !== filter.target) return false;
    if (filter.room !== undefined && entry._room !== filter.room) return false;
    return true;
  }).length;
}

/**
 * İkiz `on()` üyelerinin işleyici imzası.
 *
 * ÜRÜN sözleşmesindeki `on` JENERİKTİR (`on<A extends unknown[]>`). Bir ikiz
 * `on`u sabit bir imzayla (`(data: unknown) => void`) yazarsa jenerik hedefe
 * ATANAMAZ — ikiz, sözleşmenin kabul ettiği her çağrıyı kabul etmiyor demektir.
 * Bu tip, ikizleri sözleşmeyle aynı genişlikte tutar.
 */
export type SocketListener = (...args: never[]) => unknown;

/** @deprecated `SocketListener` kullanın. */
export type SocketEventHandler = SocketListener;

/** `handlers[event] = fn` sözlüğü — ikizler bunu `_trigger` için tutar. */
export type SocketHandlerMap = Record<string, unknown>;

// ── ÜRÜN SÖZLEŞMESİNE UYUM ─────────────────────────────────────────────────
//
// `socket/handler-contracts.ts` handler'ların soketten/sunucudan NEYE ihtiyaç
// duyduğunu yazar. Test ikizleri o sözleşmeyi karşılamak zorundadır — ama
// ikizler ayrıca kendi denetim alanlarını taşır (`_emitted`, `_handlers`,
// `_trigger`, ...).
//
// Bu yüzden ikizler `satisfies` ile işaretlenir:
//
//     const socket = { id, rooms, on(...) {...}, _emitted } satisfies SocketDouble;
//
// `satisfies` iki işi birden yapar:
//   · UYUM DENETİMİ — ikiz sözleşmeden saparsa DERLEME kırılır. Yani ürün
//     imzası değiştiğinde ikizler sessizce eskimez.
//   · BAĞLAMSAL TİPLEME — `on(event, fn)` gibi üyelerin parametreleri
//     sözleşmeden tip alır; tek tek yazmaya gerek kalmaz.
// Annotasyondan (`const socket: SocketDouble = ...`) farkı: `satisfies`
// nesnenin KENDİ tipini korur, bu yüzden `socket._emitted` hâlâ tam tiplidir.

export type { HandlerSocket, HandlerServer, EmitTarget, RoomScope } from '../../socket/handler-contracts';
import type { HandlerSocket, HandlerServer } from '../../socket/handler-contracts';

/** Sözleşmeye uyan, üstüne kendi denetim alanlarını taşıyabilen socket ikizi. */
export interface SocketDouble extends HandlerSocket {
  [key: string]: unknown;
}

/** Sözleşmeye uyan, üstüne kendi denetim alanlarını taşıyabilen io ikizi. */
export interface ServerDouble extends HandlerServer {
  [key: string]: unknown;
}

/** Küme (cluster) yeteneği de taşıyan io ikizi — `registerStageHandlers` bunu ister. */
export interface ClusterServerDouble extends ServerDouble {
  on<A extends unknown[] = unknown[]>(event: string, listener: (...args: A) => unknown): unknown;
  serverSideEmit(event: string, ...args: unknown[]): unknown;
}

/**
 * Bilinmeyen bir yükü okunabilir nesne olarak daraltır; nesne değilse `undefined`.
 *
 * İkizlerin `_trigger(event, data)` üyeleri yükü `unknown` alır (doğrusu budur:
 * ağdan gelen veri güvenilmez). Buradaki daraltma, `data?.channelId` gibi
 * okumaları TİP DENETİMİNDEN geçirir ve `as any` ihtiyacını ortadan kaldırır.
 */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) out[key] = entry;
  return out;
}

/** Bilinmeyen bir yükten string alan okur; yoksa `undefined`. */
export function readString(value: unknown, key: string): string | undefined {
  const record = asRecord(value);
  const field = record?.[key];
  return typeof field === 'string' ? field : undefined;
}
