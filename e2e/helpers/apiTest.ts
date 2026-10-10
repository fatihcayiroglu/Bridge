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
import type { APIRequestContext, Page } from '@playwright/test';
import { getCsrf, refreshCsrf, invalidateCsrf, cachedCsrf, isCsrfRejection } from './csrf';
import { NO_STEP_UP_HEADER, STEP_UP_HEADER, forgetStepUpGrants, heldStepUpGrant, stepUpGrant, stepUpScopeOf } from './stepUp';

const MUTATING = new Set(['post', 'put', 'patch', 'delete', 'fetch']);
// P7 B2: protected reads (GET /api/account/export) can be step-up refused too.
const STEP_UP_AWARE = new Set([...MUTATING, 'get', 'head']);
// Like the client's route table: once a route has been refused for a scope, a
// held grant for that scope rides along up front (no refused round trip first).
const learnedScope = new Map<string, string>();
function routeKey(method: string, url: string): string {
  try { return `${method.toUpperCase()} ${new URL(url, 'http://e2e.invalid').pathname}`; } catch { return `${method} ${url}`; }
}
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

// Exported for clients that are not Playwright's own (helpers/clientAddress.ts):
// they get the same CSRF and step-up handling as the `request` fixture.
export function withCsrf<T extends object>(ctx: T): T {
  return new Proxy(ctx, {
    get(target, prop, receiver) {
      const key = String(prop);
      const original = Reflect.get(target, prop, receiver);
      if (typeof original !== 'function' || !STEP_UP_AWARE.has(key)) {
        return typeof original === 'function' ? original.bind(target) : original;
      }
      return async (url: string, options: { headers?: HeaderBag } = {}) => {
        const headers: HeaderBag = { ...(options.headers ?? {}) };
        // P7 B2 — like the product client (client/js/core/step-up.ts): a
        // `403 STEP_UP_REQUIRED` gets ONE fresh proof (the fixture person signs
        // in again; helpers/stepUp.ts) and the request is retried with the grant.
        // Specs that assert the refusal itself opt out with `x-e2e-no-step-up`.
        const noStepUp = Object.keys(headers).find((h) => h.toLowerCase() === NO_STEP_UP_HEADER);
        if (noStepUp) delete headers[noStepUp];
        const api = target as unknown as APIRequestContext;
        const dispatch = (h: HeaderBag) => sendWithCsrf(api, original, key, url, options, h);
        const bearer = bearerOf(headers);
        const route = routeKey(key === 'fetch' ? String((options as { method?: string }).method ?? 'GET') : key, url);
        const known = !noStepUp && bearer ? learnedScope.get(route) : undefined;
        const upFront = known && bearer ? heldStepUpGrant(bearer, known) : null;
        let res = await dispatch(upFront ? { ...headers, [STEP_UP_HEADER]: upFront } : headers);
        if (noStepUp || !bearer) return res;
        for (let attempt = 0; attempt < 2; attempt++) {
          const scope = await stepUpScopeOf(res as { status(): number; text(): Promise<string> });
          if (!scope) break;
          learnedScope.set(route, scope);
          if (attempt === 1) forgetStepUpGrants(); // a held grant went stale (e.g. sign-out everywhere)
          const grant = await stepUpGrant(api, bearer, scope);
          if (!grant) break;
          res = await dispatch({ ...headers, [STEP_UP_HEADER]: grant });
        }
        return res;
      };
    },
  }) as T;
}

async function sendWithCsrf(
  target: APIRequestContext,
  original: unknown,
  key: string,
  url: string,
  options: { headers?: HeaderBag },
  headers: HeaderBag,
): Promise<unknown> {
  if (!MUTATING.has(key)) {
    return (original as (u: string, o: unknown) => Promise<unknown>).call(target, url, { ...options, headers });
  }
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
  // P7 B2: a step-up refusal is also a 403 but is answered by the caller
  // with a proof — re-sending it here would only count twice (burst).
  if (res.status() === 403 && !(await stepUpScopeOf(res as { status(): number; text(): Promise<string> }))) {
    invalidateCsrf(bearer);
    res = await send(await refreshCsrf(target, bearer));
  }
  return res;
}

// Playwright'ın geri kalan API'sini aynen yeniden dışa aktar ki spec'ler tek
// bir yerden import edebilsin (expect, request, Page, devices, ...).
// Aşağıdaki açık `test` dışa aktarımı star-export'taki `test`i gölgeler.
export * from '@playwright/test';

// ── Firefox: the COOP process swap can lose the page's main world ──────────
// Bridge sends `Cross-Origin-Opener-Policy: same-origin` on every response. A
// new page starts on about:blank, so its first navigation to Bridge switches
// browsing-context group (a process swap). On that navigation the Firefox
// driver of Playwright 1.61 (Juggler, Firefox 151 build 1532) sometimes never
// reports the new document's MAIN-world execution context: utility-world
// calls (locators, toBeVisible, toHaveCount) keep working, but page.evaluate,
// toHaveJSProperty and waitForFunction wait forever, so the test dies on its
// 30 s timeout without naming a step. Seen in CI as different Firefox tests
// timing out in different runs (cross-browser-core:86, cross-browser-product
// avatar fallback, cross-browser-journeys reload).
//
// Measured with real Firefox (protocol log: `executionContextCreated` for the
// main world missing after the swap; the utility world is reported):
//   static page + COOP, 300 navigations: 103 stalls · without COOP: 0
//   real Bridge, 200 navigations: 17 stalls · after one same-origin warm-up: 0
//
// The warm-up takes the swap on a document no test inspects (/api/health —
// same origin, same COOP, no app code), so the test's own navigation is a
// same-origin COOP→COOP load and keeps its main world. Bridge's COOP is not
// relaxed and no assertion changes; other browsers are untouched.
export async function settleFirefoxCoopSwap(page: Page): Promise<void> {
  if (page.context().browser()?.browserType().name() !== 'firefox') return;
  await page.goto(`${BASE()}/api/health`);
}

export const test = base.extend<{ request: APIRequestContext }>({
  request: async ({ request }, use) => {
    await use(withCsrf(request));
  },
  page: async ({ page }, use) => {
    await settleFirefoxCoopSwap(page);
    await use(page);
  },
});

