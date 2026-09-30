// e2e/helpers/apiTest.ts — CSRF-aware Playwright `request` fixture.
//
// Bridge canonical CSRF uygular: Bearer taşıyan her mutating /api isteği
// X-CSRF-Token bekler, yoksa 403 döner. E2E spec'leri CSRF sertleştirmesinden
// önce yazıldığı için inline `request.post(...)` çağrılarında bu başlık yok.
//
// Her çağrı yerine tek tek başlık eklemek yerine `request` fixture'ını sarmalıyoruz:
// isteğin Authorization başlığındaki bearer'a ait CSRF token'ı otomatik eklenir.
// Böylece hangi kullanıcının (alice/bob) token'ı kullanılıyorsa doğru CSRF eşlenir.

import { test as base } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';
import { getCsrf, refreshCsrf, invalidateCsrf, cachedCsrf, isCsrfRejection } from './csrf';

const MUTATING = new Set(['post', 'put', 'patch', 'delete', 'fetch']);
const BASE = () => process.env.BASE_URL || 'http://127.0.0.1:3000';

type HeaderBag = Record<string, string>;

// CSRF token'ı PAYLAŞILAN önbellekten al: sunucu kullanıcı başına tek token
// tutar, ikinci bir önbellek birincisini geçersiz kılar.

function bearerOf(headers: HeaderBag): string | null {
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === 'authorization' && typeof v === 'string' && v.startsWith('Bearer ')) {
      return v.slice(7);
    }
  }
  return null;
}

function withCsrf(ctx: APIRequestContext): APIRequestContext {
  return new Proxy(ctx, {
    get(target, prop, receiver) {
      const key = String(prop);
      const original = Reflect.get(target, prop, receiver);
      if (typeof original !== 'function' || !MUTATING.has(key)) {
        return typeof original === 'function' ? original.bind(target) : original;
      }
      return async (url: string, options: { headers?: HeaderBag } = {}) => {
        const headers: HeaderBag = { ...(options.headers ?? {}) };
        const bearer = bearerOf(headers);
        // GÜVENLİK TESTİ KAÇIŞI: CSRF'siz isteğin reddedildiğini kanıtlayan
        // testler otomatik enjeksiyonu DEVRE DIŞI bırakabilmelidir; aksi halde
        // bu fixture o testin anlamını yok eder (yanlış yeşil).
        const optOut = Object.keys(headers).find((h) => h.toLowerCase() === 'x-e2e-no-csrf');
        if (optOut) {
          delete headers[optOut];
          return (original as (u: string, o: unknown) => unknown).call(target, url, { ...options, headers });
        }
        const manualKey = Object.keys(headers).find((h) => h.toLowerCase() === 'x-csrf-token');
        if (!bearer || manualKey) {
          type Res = { status(): number; text(): Promise<string> };
          const call = (h: HeaderBag) => (original as (u: string, o: unknown) => Promise<Res>)
            .call(target, url, { ...options, headers: h });
          const res = await call(headers);
          // `'X-CSRF-Token': await getCsrf(...)` elle yazilmis olsa da PAYLASILAN
          // onbellegin kopyasidir. Ayni kullanicinin tarayici sayfasi token
          // alinca o kopya bayatlar (sunucu kullanici basina TEK token tutar) —
          // olculdu: tam paketde avatar yuklemesi 403 aldi. Yalnizca gonderilen
          // deger onbellekteki token IKEN ve sunucu gercekten CSRF reddi
          // dondugunde bir kez tazelenir; kasitli yanlis/eksik token gonderen
          // guvenlik testleri oldugu gibi kalir.
          if (bearer && manualKey && headers[manualKey] === cachedCsrf(bearer) && await isCsrfRejection(res)) {
            invalidateCsrf(bearer);
            return call({ ...headers, [manualKey]: await refreshCsrf(target, bearer) });
          }
          return res;
        }
        const send = async (token: string) => {
          const h = token ? { ...headers, 'X-CSRF-Token': token } : headers;
          return (original as (u: string, o: unknown) => Promise<{ status(): number }>)
            .call(target, url, { ...options, headers: h });
        };
        let res = await send(await getCsrf(target, bearer));
        // Token başka bir istemci tarafından döndürülmüş olabilir (sunucu
        // kullanıcı başına TEK token tutar). 403'te bir kez tazeleyip yeniden dene.
        if (res.status() === 403) {
          invalidateCsrf(bearer);
          res = await send(await refreshCsrf(target, bearer));
        }
        return res;
      };
    },
  }) as APIRequestContext;
}

// Playwright'ın geri kalan API'sini aynen yeniden dışa aktar ki spec'ler tek
// bir yerden import edebilsin (expect, request, Page, devices, ...).
// Aşağıdaki açık `test` dışa aktarımı star-export'taki `test`i gölgeler.
export * from '@playwright/test';

export const test = base.extend<{ request: APIRequestContext }>({
  request: async ({ request }, use) => {
    await use(withCsrf(request));
  },
});

