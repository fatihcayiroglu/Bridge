// server/tests/helpers/fetchDouble.ts
//
// ════════════════════════════════════════════════════════════════════════════
// GLOBAL `fetch` TEST İKİZİ — TEK KANONİK, TİPLİ SAHİP
// ════════════════════════════════════════════════════════════════════════════
//
// 15 test dosyası aynı kalıbı tekrarlıyordu:
//
//     global.fetch = jest.fn();
//     jest.mock('../lib/fetch', () => ({
//       fetchT: jest.fn((...args) => global.fetch(...args)),
//     }));
//     afterEach(() => { global.fetch.mockReset(); });
//
// Bu kalıp strict altında İKİ AYRI yapısal hata üretir:
//
//   1. `global.fetch`in BİLDİRİLEN tipi gerçek `fetch`tir, `jest.Mock` değil.
//      Bu yüzden `.mockReset()` / `.mockResolvedValueOnce()` / `.mock.calls`
//      TS2339 verir — atama çalışma zamanında işe yarasa bile tip kaybolur.
//   2. `jest.fn((...args) => ...)` içindeki `args`, @types/jest v30'da
//      `Mock<T, Y = any>` olduğu için `any`dir; `any` bir demet (tuple)
//      olmadığından yayma (spread) TS2556 verir.
//
// Ölçüldü: bu tek deyim 15 dosyada ~87 strict hatası doğuruyordu.
//
// ── ÇÖZÜM ──────────────────────────────────────────────────────────────────
// Tipi geri kazanmanın yolu `as any` DEĞİL, ikizin sahipliğini tek bir yere
// almaktır. `fetchMock()` global `fetch`i ÇALIŞMA ZAMANINDA doğrular: gerçekten
// bir jest mock'u mu? Değilse sessizce `any`ye düşmek yerine AÇIK hata verir —
// yani bu yardımcı tip güvenliğini artırmakla kalmaz, testin yanlış kurulumunu
// da yakalar.

/** Gerçek `fetch`in argüman demeti — ikiz ile üretim imzası ayrışamaz. */
export type FetchArgs = Parameters<typeof fetch>;

/**
 * Üretim kodunun bir `fetch` yanıtından FİİLEN okuduğu yüzey.
 *
 * Testler bilerek TAM bir `Response` kurmaz; örneğin akış (stream) testleri
 * `body.getReader()`i elle taklit eder. Bunu `any` ile geçiştirmek yerine
 * tüketilen alt küme AÇIKÇA yazılır: yanlış alan adı yine derleme zamanında
 * yakalanır, ama ikizin gerçek `Response` olmadığı da gizlenmez.
 *
 * Gerçek `Response` bu arayüze yapısal olarak uyar; iki biçim bir arada
 * kullanılabilir.
 */
export interface ResponseDouble {
  ok?: boolean;
  status?: number;
  statusText?: string;
  type?: string;
  url?: string;
  redirected?: boolean;
  headers?: { get(name: string): string | null };
  json?: () => Promise<unknown>;
  text?: () => Promise<string>;
  arrayBuffer?: () => Promise<ArrayBuffer>;
  /** Akış gövdesi — testler `getReader()` ikizi koyar, şekli senaryoya özgüdür. */
  body?: unknown;
  clone?: () => ResponseDouble;
}

/** `fetch` yerine geçen, tam tipli jest mock'u. */
export type FetchMock = jest.Mock<Promise<ResponseDouble>, FetchArgs>;

/**
 * Bir değerin gerçekten jest mock yüzeyi taşıyıp taşımadığını ÇALIŞMA
 * ZAMANINDA doğrular.
 *
 * Bu bir TİP KORUYUCUSUDUR (type predicate), dönüştürme (cast) DEĞİLDİR:
 * `in` ile daraltma yapılır ve `_isMockFunction` bayrağı fiilen sınanır.
 * Yani `fetchMock()` tipi "iddia etmez", DOĞRULAR.
 */
function isFetchMock(value: unknown): value is FetchMock {
  return (
    typeof value === 'function' &&
    '_isMockFunction' in value &&
    value._isMockFunction === true &&
    'mockReset' in value &&
    typeof value.mockReset === 'function'
  );
}

/** Yeni, tipli bir `fetch` ikizi üretir (globali DEĞİŞTİRMEZ). */
export function createFetchMock(): FetchMock {
  return jest.fn<Promise<ResponseDouble>, FetchArgs>();
}

/**
 * Tipli ikizi `globalThis.fetch` yuvasına kurar ve döndürür.
 *
 * Atama, KASITLI olarak zayıflatılmış bir görünüm üzerinden yapılır. Bunun
 * sebebi saklanacak bir şey olması değil, söylenen şeyin DOĞRU olmasıdır:
 * testte global yuvada gerçek `fetch` DEĞİL, bir ikiz durur. `as any` ya da
 * `as unknown as typeof fetch` yazmak bu gerçeği gizlerdi; burada tek ve adı
 * konmuş bir dikişten geçer, üstelik `fetchMock()` bunu çalışma zamanında
 * ayrıca doğrular.
 */
export function installFetchMock(): FetchMock {
  const mock = createFetchMock();
  const globalSlot: { fetch?: unknown } = globalThis;
  globalSlot.fetch = mock;
  return mock;
}

/** Kurulu ikizi kaldırıp global yuvayı boşaltır (afterAll temizliği için). */
export function uninstallFetchMock(): void {
  const globalSlot: { fetch?: unknown } = globalThis;
  delete globalSlot.fetch;
}

/**
 * Kurulu global `fetch` ikizini TİPLİ olarak verir.
 *
 * Global gerçekten mock değilse — örneğin `installFetchMock()` çağrılmadıysa
 * ya da bir başka test globali geri yüklediyse — sessizce yanlış davranmak
 * yerine AÇIKÇA patlar. Eski `global.fetch.mockReset()` yazımı bu durumda
 * anlaşılması zor bir "not a function" hatası veriyordu.
 */
export function fetchMock(): FetchMock {
  const current: unknown = globalThis.fetch;
  if (!isFetchMock(current)) {
    throw new Error(
      'fetchDouble: globalThis.fetch bir jest mock değil — önce installFetchMock() çağrılmalı.',
    );
  }
  return current;
}

/**
 * GERÇEK bir `Response` üreten JSON yardımcısı.
 *
 * Elde kurulan `{ ok: true, json: async () => x }` ikizleri yerine bunu
 * kullanmak daha yüksek sadakat sağlar: durum kodu ile `ok` arasındaki
 * tutarlılık, başlık okuma ve `json()` çözümlemesi gerçek uygulamadan gelir.
 */
export function jsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

/**
 * `RequestInit.headers` içinden TEK bir başlığı güvenle okur.
 *
 * `HeadersInit` üç biçimin BİRLEŞİMİDİR: `Headers` örneği, `[ad, değer]`
 * çiftlerinden dizi, ya da düz nesne. Testler bunu düz nesne varsayıp
 * `init.headers.Authorization` yazıyordu; bu, üç biçimden ikisinde çalışmayan
 * ve tip düzeyinde de yanlış olan bir varsayımdı.
 *
 * Ad karşılaştırması HTTP semantiğine uygun biçimde büyük/küçük harf
 * duyarsızdır.
 */
export function headerFrom(init: RequestInit | undefined, name: string): string | undefined {
  const headers = init?.headers;
  if (!headers) return undefined;
  const wanted = name.toLowerCase();

  if (headers instanceof Headers) {
    return headers.get(name) ?? undefined;
  }
  if (Array.isArray(headers)) {
    for (const pair of headers) {
      if (pair[0]?.toLowerCase() === wanted) return pair[1];
    }
    return undefined;
  }
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
}
