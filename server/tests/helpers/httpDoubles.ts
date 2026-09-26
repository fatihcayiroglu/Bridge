// server/tests/helpers/httpDoubles.ts
//
// ════════════════════════════════════════════════════════════════════════════
// HTTP YANIT BAŞLIKLARINI GÜVENLE OKUMA
// ════════════════════════════════════════════════════════════════════════════
//
// Testlerde şu satır ondan fazla yerde tekrarlanıyordu:
//
//     const cookies: string[] = res.headers['set-cookie'] ?? [];
//
// Node'un `IncomingHttpHeaders` tipinde `set-cookie` `string[] | undefined`
// GÖRÜNÜR, ama supertest'in `Response.headers` tipi `Record<string, string>`
// olduğu için değer `string`e daralıyor ve atama TS2322 veriyordu.
//
// Daha önemlisi: GERÇEK dünyada bu başlık ÜÇ biçimde gelebilir —
//   · hiç yok (undefined),
//   · tek bir çerez (string),
//   · birden çok çerez (string[]).
//
// Testler üçüncü biçimi varsayıyordu. Tek çerez dönen bir yolda
// `cookies.find(...)` sessizce yanlış çalışırdı (string üzerinde `find` yok;
// çalışma zamanında TypeError). Yani buradaki düzeltme yalnızca tipi değil,
// testin DOĞRULUĞUNU da onarır.

/** Yanıt başlıklarının okunan yüzeyi — supertest ve Node ikisine de uyar. */
export interface HeaderBag {
  [key: string]: unknown;
}

/**
 * `set-cookie` başlığını HER ZAMAN dizi olarak verir.
 *
 *     const cookies = setCookiesOf(res.headers);
 *     expect(cookies.some(c => c.startsWith('refreshToken='))).toBe(true);
 */
export function setCookiesOf(headers: HeaderBag | undefined): string[] {
  const raw = headers?.['set-cookie'];
  if (raw === undefined || raw === null) return [];
  if (Array.isArray(raw)) return raw.filter((entry): entry is string => typeof entry === 'string');
  return typeof raw === 'string' ? [raw] : [];
}

/**
 * Adı verilen çerezi arar; yoksa `undefined`.
 *
 * Karşılaştırma çerez ADI üzerindedir (`name=`), içerik üzerinde değil —
 * `cookies.find(c => c.includes('token'))` biçimindeki kırılgan aramalar
 * başka bir çereze de rastlayabiliyordu.
 */
export function cookieNamed(headers: HeaderBag | undefined, name: string): string | undefined {
  return setCookiesOf(headers).find(entry => entry.startsWith(`${name}=`));
}

// ── İSTEK GÖVDESİ ──────────────────────────────────────────────────────────
//
// supertest/superagent `.send()` yalnızca `string | object` kabul eder.
// Testlerin çoğu yardımcılarını `body: unknown` diye yazıp `.send(body)`
// çağırıyordu; `unknown` o imzaya uymaz.
//
// `unknown` burada zaten YANLIŞ tipti: gövde JSON'dur — nesne, dizi ya da
// önceden serileştirilmiş bir dizge. Bu takma ad o gerçeği yazar ve
// "geçersiz gövde" senaryolarını (sayı, boş dizge, dizi) yazmayı ENGELLEMEZ.
export type RequestBody = string | object;
