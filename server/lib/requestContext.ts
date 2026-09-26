// server/lib/requestContext.ts
//
// ════════════════════════════════════════════════════════════════════════════
// İSTEK BAĞLAMI — TEK BİR HATANIN UÇTAN UCA İZLENEBİLMESİ
// ════════════════════════════════════════════════════════════════════════════
// Bir üretim olayında sorulan ilk soru şudur: "kullanıcının 500 aldığı O istek
// tam olarak ne yaptı?" Bu soruya cevap verebilmek için HTTP girişinde üretilen
// bir kimliğin, o isteğin tetiklediği HER günlük satırında görünmesi gerekir:
//
//     HTTP → auth → repository/DB → Redis → dış sağlayıcı → yanıt
//
// Bunu her çağrıya elle parametre geçirerek yapmak, yüzlerce imzayı değiştirmek
// ve ilk unutulan yerde zinciri koparmak demektir. `AsyncLocalStorage` ise
// bağlamı asenkron çağrı ağacı boyunca KENDİLİĞİNDEN taşır: `await` sınırları,
// `Promise.all`, zamanlayıcı geri çağrıları ve olay işleyicileri dahil.
//
// ── NEDEN SAYAÇ DEĞİL, RASTGELE KİMLİK ──────────────────────────────────────
// Artan bir sayaç süreç yeniden başlayınca sıfırlanır ve çok süreçli/çok düğümlü
// bir kurulumda ÇAKIŞIR. 128 bitlik rastgele bir değer, düğümler arasında
// koordinasyon gerektirmeden benzersizdir.
//
// ── NEDEN DIŞARIDAN GELEN KİMLİĞE KOŞULLU GÜVENİLİR ─────────────────────────
// Ters vekil (reverse proxy) genellikle kendi `X-Request-Id` başlığını üretir ve
// aynı kimliği erişim günlüğüne yazar. Onu kabul etmek, vekil günlüğü ile
// uygulama günlüğünü BİRLEŞTİRİLEBİLİR kılar.
//
// Ama başlık İSTEMCİDEN de gelebilir ve istemci girdisi GÜVENİLMEZDİR:
//   · sınırsız uzunluk    → günlük şişirme
//   · kontrol karakteri   → günlük satırı enjeksiyonu (CRLF)
//   · sabit bir değer     → farklı kullanıcıların istekleri tek kimlikte birleşir
//
// Bu yüzden gelen değer KATI bir biçime uymak zorundadır; uymuyorsa sessizce
// yok sayılır ve yeni bir kimlik üretilir. Reddetmek yerine üretmek bilinçlidir:
// izlenebilirlik bir güvenlik sınırı değildir ve kötü bir başlık yüzünden
// meşru bir isteği düşürmek yanlış olurdu.
import { AsyncLocalStorage } from 'async_hooks';
import crypto from 'crypto';

export interface RequestContext {
  /** Bu isteğin (veya soket işleminin) uçtan uca korelasyon kimliği. */
  requestId: string;
  /** Kimlik doğrulandıysa aktör; günlükte sahibi göstermek için. */
  userId?: string;
  /** Soket kaynaklı işlerde bağlantı kimliği. */
  socketId?: string;
  /**
   * İSTEK KAPSAMLI hesaplama önbelleği.
   *
   * Yalnızca bu isteğin ömrü boyunca yaşar ve istek bitince bağlamla birlikte
   * yok olur. İzin çözümü bunu `(userId, serverId)` değişmezleri için kullanır
   * (sunucu satırı, üyelik, roller) — bunlar tek bir istek içinde defalarca,
   * aynı sonuçla okunuyordu.
   *
   * GÜVENLİK: istekler arasında hiçbir şey taşınmaz. Bir rol değişikliği bir
   * sonraki istekte HEMEN görünür; bayat yetki mümkün değildir. Tek bir istek
   * içindeki tutarlı görüntü ise zaten istenen davranıştır.
   */
  memo?: Map<string, unknown>;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** Dışarıdan gelen bir korelasyon kimliğinin kabul edilebilir biçimi. */
const INBOUND_ID = /^[A-Za-z0-9_-]{8,128}$/;

/** Yeni, çakışmayan bir korelasyon kimliği üretir. */
export function newRequestId(): string {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * Gelen başlığı kabul edilebilirse benimser, aksi hâlde yeni kimlik üretir.
 *
 * Dizi hâlinde gelen başlık (aynı başlığın tekrarı) BİLEREK reddedilir:
 * hangisinin doğru olduğu belirsizdir ve seçim yapmak sessiz bir tahmindir.
 */
export function adoptRequestId(headerValue: unknown): string {
  if (typeof headerValue === 'string' && INBOUND_ID.test(headerValue)) return headerValue;
  return newRequestId();
}

/** Verilen bağlamla bir işi çalıştırır; bağlam tüm asenkron alt ağaca yayılır. */
export function runWithRequestContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

/** Yürürlükteki bağlam (yoksa `undefined`). */
export function currentRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

/** Yürürlükteki korelasyon kimliği (yoksa `undefined`). */
export function currentRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}

/**
 * Kimlik doğrulandıktan SONRA aktörü bağlama iliştirir.
 *
 * Kimlik, isteğin başında bilinmez (jeton henüz doğrulanmamıştır). Bağlam
 * nesnesi yerinde güncellenir ki, doğrulamadan sonraki günlük satırları
 * sahibi de göstersin — yeni bir bağlam açmak, o noktaya kadar biriken
 * asenkron zinciri koparırdı.
 */
export function attachActor(userId: string | undefined, socketId?: string): void {
  const store = storage.getStore();
  if (!store) return;
  if (userId) store.userId = userId;
  if (socketId) store.socketId = socketId;
}

/**
 * Pino `mixin` kancası — her günlük satırına bağlamı otomatik ekler.
 *
 * Çağıran taraf hiçbir şey yapmaz: mevcut `logger.info({ event })` çağrıları
 * korelasyon kimliğini KENDİLİĞİNDEN taşımaya başlar. Bağlam yoksa (açılış,
 * zamanlanmış işler) hiçbir alan eklenmez — boş/`undefined` alanlar günlüğü
 * kirletmesin diye.
 */
export function requestContextMixin(): Record<string, string> {
  const store = storage.getStore();
  if (!store) return {};
  const fields: Record<string, string> = { requestId: store.requestId };
  if (store.userId) fields.userId = store.userId;
  if (store.socketId) fields.socketId = store.socketId;
  return fields;
}

/**
 * İstek kapsamlı memoizasyon. Bağlam yoksa (açılış, zamanlanmış işler, testler)
 * hesaplama HER ZAMAN çalışır — önbellek sessizce atlanır, sonuç değişmez.
 */
export async function memoizeInRequest<T>(key: string, compute: () => Promise<T>): Promise<T> {
  const store = storage.getStore();
  if (!store) return compute();
  const memo = store.memo ??= new Map<string, unknown>();
  if (memo.has(key)) return memo.get(key) as T;
  const value = await compute();
  memo.set(key, value);
  return value;
}
