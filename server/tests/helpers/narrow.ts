// server/tests/helpers/narrow.ts
//
// ════════════════════════════════════════════════════════════════════════════
// `unknown` DEĞERLERİ TESTLERDE GÜVENLE DARALTMAK
// ════════════════════════════════════════════════════════════════════════════
//
// Strict altında testlerin en sık karşılaştığı iki durum:
//
//     res.reactions['👍']          // TS18046: 'res.reactions' is of type 'unknown'
//     saved.activity.object.cc     // aynısı, zincirleme
//
// Bunların "kolay" çözümü `as any` ya da `as Record<string, unknown>` yazmaktır.
// İkisi de YANLIŞTIR: birincisi tipi tamamen kaybettirir, ikincisi ise
// DOĞRULAMADAN iddia eder — değer gerçekten nesne değilse test, anlaşılmaz bir
// `undefined` hatasıyla çok sonra patlar.
//
// Buradaki yardımcılar İDDİA ETMEZ, DOĞRULAR. Değer beklenen biçimde değilse
// hemen ve AÇIKLAYICI bir hata verirler. Yani tip güvenliği kazanılırken
// testin teşhis kalitesi de artar.
//
// Hiçbirinde `as any` / `@ts-ignore` yoktur.

/** `unknown` → okunabilir nesne. Nesne değilse açık hata. */
export function recordOf(value: unknown, label = 'deger'): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} bir nesne degil: ${describe(value)}`);
  }
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) out[key] = entry;
  return out;
}

/** `unknown` → dizi. Dizi değilse açık hata. */
export function arrayOf(value: unknown, label = 'deger'): unknown[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${label} bir dizi degil: ${describe(value)}`);
  }
  return value;
}

/** `unknown` → nesne dizisi. */
export function recordsOf(value: unknown, label = 'deger'): Array<Record<string, unknown>> {
  return arrayOf(value, label).map((item, index) => recordOf(item, `${label}[${index}]`));
}

/** `unknown` → string. */
export function stringOf(value: unknown, label = 'deger'): string {
  if (typeof value !== 'string') throw new TypeError(`${label} bir string degil: ${describe(value)}`);
  return value;
}

/** `unknown` → number. */
export function numberOf(value: unknown, label = 'deger'): number {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new TypeError(`${label} bir sayi degil: ${describe(value)}`);
  }
  return value;
}

/** `unknown` → string dizisi. */
export function stringsOf(value: unknown, label = 'deger'): string[] {
  return arrayOf(value, label).map((item, index) => stringOf(item, `${label}[${index}]`));
}

/**
 * Nokta yolu ile iç içe alan okur: `at(obj, 'activity.object.cc')`.
 *
 * Her adımda gerçekten nesne olup olmadığı denetlenir; olmayan bir ara adım
 * `undefined` döndürmek yerine YOLU söyleyen bir hata verir.
 */
export function at(value: unknown, path: string, label = 'deger'): unknown {
  let current = value;
  const walked: string[] = [];
  for (const segment of path.split('.')) {
    const record = recordOf(current, `${label}.${walked.join('.') || '<kok>'}`);
    current = record[segment];
    walked.push(segment);
  }
  return current;
}

/** `null` / `undefined` olmadığını DOĞRULAR ve değeri daraltır. */
export function present<T>(value: T | null | undefined, label = 'deger'): T {
  if (value === null || value === undefined) {
    throw new TypeError(`${label} beklenmedik sekilde ${value === null ? 'null' : 'undefined'}`);
  }
  return value;
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `dizi(${value.length})`;
  return typeof value;
}
