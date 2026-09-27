// server/lib/fetch.ts
// Node 22+ native fetch wrapper — AbortSignal.timeout() + SSRF koruması
//
// Tüm server kodunda bu modülden import edin. node-fetch bağımlılığı kaldırıldı (Sprint 48).
// Global fetch (Node 22+) kullanır; timeout, User-Agent ve SSRF guard ekler.
//
// SSRF koruması:
//   - Private / loopback / link-local / metadata IPv4 ve IPv6 adresleri reddedilir
//   - DNS çözümlemesi bağlantı anında yeniden doğrulanır (DNS rebinding koruması)
//   - SSRF_ALLOWLIST env (virgülle ayrılmış hostname listesi) whitelist geçişi sağlar

import net from 'net';
import { Agent, fetch as undiciFetch } from 'undici';

// SSRF politikasi ARTIK BURADA YASAMIYOR — tek kaynak `lib/ssrfGuard.ts`.
// Bu dosya yalnizca TASIYICI tarafini ekler: baglanti aninda yeniden
// dogrulayan undici dispatcher'i ve yonlendirme zinciri denetimi.
import {
  SSRFError,
  assertTargetAllowed,
  assertAddressesNotPrivate,
  resolveHostnameAddresses,
} from './ssrfGuard';
import { envSafeInt } from './envNumbers';
import { BRIDGE_VERSION } from './version';

// Geriye donuk uyumluluk: bu semboller uzun suredir `lib/fetch.ts`den
// import ediliyor. Kanonik tanim `./ssrfGuard`dir; burada yalnizca yeniden
// disa aktarilir (KOPYA DEGIL).
export { SSRFError, isPrivateIP, assertUrlIsPublic } from './ssrfGuard';


function anyAbortSignal(signals: readonly (AbortSignal | null | undefined)[]): AbortSignal | undefined {
  const validSignals = signals.filter((signal): signal is AbortSignal => Boolean(signal));

  if (validSignals.length === 0) {
    return undefined;
  }

  if (validSignals.length === 1) {
    return validSignals[0];
  }

  const nativeAny = (AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal }).any;
  if (typeof nativeAny === 'function') {
    return nativeAny(validSignals);
  }

  const controller = new AbortController();
  const listeners = new Map<AbortSignal, () => void>();

  const cleanup = () => {
    for (const [signal, listener] of listeners) {
      signal.removeEventListener('abort', listener);
    }
    listeners.clear();
  };

  const abortFrom = (signal: AbortSignal) => {
    if (!controller.signal.aborted) {
      controller.abort((signal as unknown as { reason?: unknown }).reason);
    }
    cleanup();
  };

  for (const signal of validSignals) {
    if (signal.aborted) {
      abortFrom(signal);
      break;
    }

    const listener = () => abortFrom(signal);
    listeners.set(signal, listener);
    signal.addEventListener('abort', listener, { once: true });
  }

  return controller.signal;
}

/** DNS/SSRF hazırlığı da HTTP isteğiyle aynı uçtan uca süre sınırına tabidir. */
function withAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error('Fetch aborted'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error('Fetch aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}


const DEFAULT_UA  = `Bridge/${BRIDGE_VERSION} (Node/${process.version})`;
const DEFAULT_MS = envSafeInt('HTTP_FETCH_TIMEOUT_MS', 10_000, { min: 100, max: 10 * 60_000 });
/** Yonlendirme zinciri ust siniri — her adim ayrica SSRF denetiminden gecer. */
const MAX_REDIRECTS = envSafeInt('HTTP_MAX_REDIRECTS', 5, { min: 0, max: 20 });

/**
 * Baglanti aninda DNS yeniden cozulur — DNS rebinding saldirilarina karsi
 * lookup callback'i private IP'leri reddeder.
 *
 * Kural `./ssrfGuard`dan gelir; burada yalnizca undici'ye baglanir.
 */
function createSsrfSafeDispatcher(hostname: string): Agent {
  return new Agent({
    connect: {
      servername: hostname,
      lookup: (_lookupHost, options, callback) => {
        void (async () => {
          try {
            const addresses = await resolveHostnameAddresses(hostname);
            if (!addresses.length) {
              callback(new Error(`ENOTFOUND ${hostname}`), []);
              return;
            }
            assertAddressesNotPrivate(hostname, addresses);

            const entries = addresses.map(address => ({
              address,
              family: net.isIPv6(address) ? 6 : 4,
            }));

            if (options?.all) {
              callback(null, entries);
              return;
            }

            const first = entries[0];
            // Boş bir sonuç kümesi `undefined` verir; bunu adres gibi
            // geçirmek çağıranı bozardı.
            if (!first) { callback(new Error('DNS lookup returned no address'), []); return; }
            callback(null, first.address, first.family);
          } catch (err) {
            callback(err as Error, []);
          }
        })();
      },
    },
  });
}

/**
 * SSRF kontrolü: URL'nin hostname'ini DNS ile çöz,
 * dönen IP'lerden herhangi biri private ise hata fırlat.
 *
 * Bağlantı anında lookup callback'i ile ikinci doğrulama yapılır (DNS rebinding).
 */
async function assertNotSSRF(url: string | URL): Promise<{ dispatcher?: Agent }> {
  const verdict = await assertTargetAllowed(url);

  // Allowlist ve ciplak IP: dogrulama zaten tamamlandi, dispatcher gereksiz.
  if (verdict.allowlisted || verdict.bareIp) return {};

  // ── KAPATILAN FAIL-OPEN ──────────────────────────────────────────────────
  // Burasi eskiden "adres cozulemedi" durumunda `{}` donup istegi
  // GUARD'SIZ birakiyordu: undici kendi resolver'ina duser ve BIZIM
  // dogrulamadigimiz bir adrese baglanabilirdi. Gecici DNS hatasinin tum
  // giden istekleri kirmamasi icin bilincli bir odundu — ama odun
  // GEREKSIZDI:
  //
  // `resolveHostnameAddresses` zaten IKI yol dener; once `dns.resolve4/6`,
  // sonra sistem cozumleyicisi (`dns.lookup`, /etc/hosts dahil) — yani
  // undici'nin kullanacagi yolu da kapsar. Ikisi birden bos donduyse ad
  // GERCEKTEN cozulemiyordur ve istek nasilsa basarisiz olacaktir.
  //
  // Dolayisiyla burada durmak islevsel bir kayip degil, yalnizca hatanin
  // GUVENLI tarafta olmasidir: dogrulanmamis hicbir hedefe baglanilmaz.
  if (!verdict.addresses.length) {
    throw new SSRFError(`Hostname could not be resolved: ${verdict.hostname}`, verdict.hostname);
  }

  return { dispatcher: createSsrfSafeDispatcher(verdict.hostname) };
}

export interface FetchOptions extends RequestInit {
  /** Timeout in ms. Default: HTTP_FETCH_TIMEOUT_MS env var or 10 000 */
  timeoutMs?: number;
  /**
   * SSRF kontrolünü atla (sadece güvenilir/internal URL'ler için).
   * Varsayılan: false — dış kaynaklı URL'lerde asla true kullanmayın.
   */
  skipSsrfCheck?: boolean;
}

/**
 * Güvenli fetch wrapper:
 *   - AbortSignal.timeout()  — takılı istekleri önler
 *   - User-Agent header       — sunucuyu tanımlar
 *   - SSRF koruması           — private IP'lere istek engeller
 *   - DNS rebinding koruması  — bağlantı anında IP yeniden doğrulanır
 *
 * Drop-in replacement: `import { fetchT } from '../lib/fetch'`
 */
export async function fetchT(url: string | URL, opts: FetchOptions = {}): Promise<Response> {
  const {
    timeoutMs = DEFAULT_MS,
    signal: callerSignal,
    headers: callerHeaders,
    skipSsrfCheck = false,
    ...rest
  } = opts;

  // Süre sinyali SSRF/DNS hazırlığından ÖNCE başlar. Önceki sıra, DNS çözümü
  // takıldığında AbortSignal'ın hiç oluşturulmamasına ve çağrının sınırsız
  // beklemesine yol açıyordu.
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = callerSignal
    ? anyAbortSignal([callerSignal as AbortSignal, timeoutSignal])
    : timeoutSignal;

  let dispatcher: Agent | undefined;
  if (!skipSsrfCheck) {
    ({ dispatcher } = await withAbort(assertNotSSRF(url), signal));
  }

  const headers: Record<string, string> = {
    'User-Agent': DEFAULT_UA,
    ...(callerHeaders as Record<string, string> | undefined ?? {}),
  };

  const { body, ...safeRest } = rest;

  // ════════════════════════════════════════════════════════════════════════
  // YONLENDIRMELER HER ADIMDA YENIDEN DENETLENIR
  // ════════════════════════════════════════════════════════════════════════
  // ONCEKI HALI undici'nin varsayilan `redirect: 'follow'` davranisina
  // birakiyordu ve SSRF denetimi YALNIZCA ILK adrese uygulaniyordu.
  // Dogrudan olculdu (yerel kanit sunucusu ile):
  //
  //     http://<ilk hedef>/      → 302 Location: http://127.0.0.1:38111/
  //     sonuc: 200 "INTERNAL_SECRET_DATA"   ← ic veri OKUNDU ve DONDURULDU
  //
  // `assertNotSSRF` bazi durumlarda dispatcher URETMEDEN gecer:
  //   · host SSRF_ALLOWLIST'te ise
  //   · host duz bir GENEL IP ise
  //   · DNS cozumu bos donerse
  // Bu durumlarda hicbir baglanti-ani denetimi kalmaz ve yonlendirme
  // ZINCIRI ozel bir adrese inebilir. Yani saldirgan KENDI genel sunucusunu
  // hedef gosterip oradan ic aga sicrayabilirdi.
  //
  // COZUM: yonlendirmeler ELLE izlenir; HER adres yeniden dogrulanir.
  // Cagiran acikca `redirect` belirtmisse ona saygi duyulur.
  const explicitRedirect = (safeRest as { redirect?: string }).redirect;
  const followManually = !skipSsrfCheck && explicitRedirect === undefined;

  const init = {
    signal, headers, dispatcher,
    ...safeRest,
    ...(followManually ? { redirect: 'manual' as const } : {}),
  } as Parameters<typeof undiciFetch>[1];
  if (body !== null && body !== undefined) (init as { body?: typeof body }).body = body;

  if (!followManually) {
    return undiciFetch(url, init) as unknown as Promise<Response>;
  }

  let currentUrl = typeof url === 'string' ? url : url.toString();
  let currentInit = init;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await undiciFetch(currentUrl, currentInit) as unknown as Response;

    const isRedirect = res.status === 301 || res.status === 302 || res.status === 303
      || res.status === 307 || res.status === 308;
    if (!isRedirect) return res;

    const location = res.headers.get('location');
    if (!location) return res;                       // Location yoksa yanit oldugu gibi doner

    if (hop === MAX_REDIRECTS) {
      throw new SSRFError(
        `Too many redirects (>${MAX_REDIRECTS})`,
        (() => { try { return new URL(currentUrl).hostname; } catch { return currentUrl; } })(),
      );
    }

    // Goreli Location mutlaklastirilir.
    const nextUrl = new URL(location, currentUrl).toString();

    // HER ADIM yeniden dogrulanir — asil duzeltme budur.
    const { dispatcher: nextDispatcher } = await withAbort(assertNotSSRF(nextUrl), signal);

    // 303 ve POST→301/302 icin yontem GET'e duser ve govde birakilir (RFC 9110).
    const method = String((currentInit as { method?: string }).method ?? 'GET').toUpperCase();
    const downgrade = res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST');

    const nextInit = { ...currentInit, dispatcher: nextDispatcher } as typeof currentInit;
    if (downgrade) {
      (nextInit as { method?: string }).method = 'GET';
      delete (nextInit as { body?: unknown }).body;
    }

    currentUrl = nextUrl;
    currentInit = nextInit;
  }

  // Ulasilamaz: dongu ya doner ya firlatir.
  throw new SSRFError('Redirect handling failed', currentUrl);
}

export default fetchT;
