// server/tests/helpers/deferred.ts
//
// ════════════════════════════════════════════════════════════════════════════
// ELLE ÇÖZÜLEN PROMISE — KESİN ATAMA İDDİASI OLMADAN
// ════════════════════════════════════════════════════════════════════════════
//
// Yarış koşullarını ölçen testlerin standart kalıbı şudur:
//
//     let resolveA;
//     const a = new Promise(resolve => { resolveA = resolve; });
//     ...
//     resolveA(row);          // <-- 'resolveA' possibly 'undefined'
//
// TypeScript, `Promise` yürütücüsünün SENKRON çalıştığını bilmez; bu yüzden
// `resolveA` onun için `undefined` olabilir. Alışılmış iki "çözüm" de kötüdür:
//
//   · `let resolveA!: ...`  → kesin atama İDDİASI. Doğru olduğu için değil,
//     susturduğu için çalışır; yürütücü bir gün gerçekten gecikirse hata
//     çalışma zamanına kaçar.
//   · `resolveA!(row)`      → aynı şey, çağrı yerinde.
//
// Buradaki fabrika iddia etmez, DOĞRULAR: yürütücü senkron çalışmamışsa
// anlaşılır bir hata fırlatır ve ancak ondan sonra daraltılmış tipi verir.

export interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason?: unknown) => void;
}

/**
 * Dışarıdan çözülebilen bir promise üretir.
 *
 *     const a = deferred<Row>();
 *     mock.mockImplementation(() => a.promise);
 *     a.resolve(row);
 */
export function deferred<T>(): Deferred<T> {
  let resolveFn: ((value: T) => void) | undefined;
  let rejectFn: ((reason?: unknown) => void) | undefined;

  const promise = new Promise<T>((res, rej) => {
    resolveFn = res;
    rejectFn = rej;
  });

  // Bu kontrol savunma amaçlı DEĞİL, daraltma amaçlıdır: ECMAScript
  // yürütücünün senkron çağrılmasını şart koşar, dolayısıyla buraya
  // düşülmez. Düşülürse sebebi yamalanmış bir `Promise`tir ve bunu
  // sessizce geçmektense söylemek doğrudur.
  if (!resolveFn || !rejectFn) {
    throw new Error('deferred: Promise yurutucusu senkron calismadi');
  }

  return { promise, resolve: resolveFn, reject: rejectFn };
}
