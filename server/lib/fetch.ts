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

import dns from 'dns/promises';
import net from 'net';
import { Agent, fetch as undiciFetch } from 'undici';


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


let PKG_VERSION = '0.0.0';
(async () => {
  try {
    const pkg = await import('../../package.json') as { default?: { version?: string }; version?: string };
    PKG_VERSION = pkg.default?.version ?? pkg.version ?? '0.0.0';
  } catch { /* package.json okunamadı — varsayılan kullan */ }
})();

const DEFAULT_UA  = `Bridge/${PKG_VERSION} (Node/${process.version})`;
const DEFAULT_MS  = parseInt(process.env.HTTP_FETCH_TIMEOUT_MS || '10000', 10);

// Whitelist: SSRF_ALLOWLIST="idp.example.com,accounts.google.com"
function isSsrfAllowlisted(hostname: string): boolean {
  const list = (process.env.SSRF_ALLOWLIST || '')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);
  return list.includes(hostname);
}

// ── Özel IP aralıkları (SSRF hedefleri) ─────────────────────────────────────
// IPv4 CIDR blokları — RFC 1918, RFC 5735, RFC 3927, Cloud metadata
const PRIVATE_RANGES_V4: Array<{ base: number; mask: number; label: string }> = [
  { base: ip4ToInt('0.0.0.0'),       mask: 0xff000000, label: '0.0.0.0/8'       },
  { base: ip4ToInt('10.0.0.0'),      mask: 0xff000000, label: '10.0.0.0/8'      },
  { base: ip4ToInt('100.64.0.0'),    mask: 0xffc00000, label: '100.64.0.0/10'   }, // CGNAT
  { base: ip4ToInt('127.0.0.0'),     mask: 0xff000000, label: '127.0.0.0/8'     }, // loopback
  { base: ip4ToInt('169.254.0.0'),   mask: 0xffff0000, label: '169.254.0.0/16'  }, // link-local + AWS metadata
  { base: ip4ToInt('172.16.0.0'),    mask: 0xfff00000, label: '172.16.0.0/12'   },
  { base: ip4ToInt('192.0.0.0'),     mask: 0xffffff00, label: '192.0.0.0/24'    },
  { base: ip4ToInt('192.168.0.0'),   mask: 0xffff0000, label: '192.168.0.0/16'  },
  { base: ip4ToInt('198.18.0.0'),    mask: 0xfffe0000, label: '198.18.0.0/15'   },
  { base: ip4ToInt('198.51.100.0'),  mask: 0xffffff00, label: '198.51.100.0/24' }, // TEST-NET-2
  { base: ip4ToInt('203.0.113.0'),   mask: 0xffffff00, label: '203.0.113.0/24'  }, // TEST-NET-3
  { base: ip4ToInt('224.0.0.0'),     mask: 0xf0000000, label: '224.0.0.0/4'     }, // multicast
  { base: ip4ToInt('240.0.0.0'),     mask: 0xf0000000, label: '240.0.0.0/4'     }, // reserved
  { base: ip4ToInt('255.255.255.255'), mask: 0xffffffff, label: '255.255.255.255' },
];

// IPv6 — loopback, link-local, ULA, mapped
const PRIVATE_PREFIXES_V6 = [
  '::1',            // loopback
  '::ffff:',        // IPv4-mapped
  '64:ff9b::',      // IPv4-translated
  'fc',             // ULA fc00::/7
  'fd',             // ULA fd00::/7
  'fe80',           // link-local
  'ff',             // multicast
  '2002:a',         // 6to4 RFC1918
  '2002:ac1',       // 6to4 RFC1918 172.16
  '2002:c0a8',      // 6to4 RFC1918 192.168
];

function ip4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, octet) => (acc << 8) | parseInt(octet, 10), 0) >>> 0;
}

function isPrivateIPv4(ip: string): boolean {
  if (!net.isIPv4(ip)) return false;
  const n = ip4ToInt(ip);
  return PRIVATE_RANGES_V4.some(({ base, mask }) => (n & mask) === (base & mask));
}

function isPrivateIPv6(ip: string): boolean {
  if (!net.isIPv6(ip)) return false;
  const lower = ip.toLowerCase();
  // ::1 tam eşleşme
  if (lower === '::1') return true;
  return PRIVATE_PREFIXES_V6.some(prefix => lower.startsWith(prefix));
}

export function isPrivateIP(ip: string): boolean {
  return isPrivateIPv4(ip) || isPrivateIPv6(ip);
}

function assertAddressesNotPrivate(hostname: string, addresses: string[]): void {
  for (const addr of addresses) {
    if (isPrivateIP(addr)) {
      throw new SSRFError(
        `SSRF: ${hostname} resolved to private IP ${addr}`,
        hostname,
        addr,
      );
    }
  }
}

/** Hostname için A/AAAA kayıtlarını çöz ve private IP kontrolü yap. */
async function resolveHostnameAddresses(hostname: string): Promise<string[]> {
  try {
    return await dns.resolve(hostname);
  } catch {
    try {
      return await dns.resolve6(hostname);
    } catch {
      return [];
    }
  }
}

/**
 * Bağlantı anında DNS yeniden çözülür — DNS rebinding saldırılarına karşı
 * lookup callback'i private IP'leri reddeder.
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
  const parsed = typeof url === 'string' ? new URL(url) : url;
  const hostname = parsed.hostname.toLowerCase();

  // Protokol kontrolü — sadece http/https
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new SSRFError(`Protocol not allowed: ${parsed.protocol}`, hostname);
  }

  // Whitelist bypass
  if (isSsrfAllowlisted(hostname)) return {};

  // Hostname zaten IP mi?
  const bareIp = hostname.replace(/^\[|\]$/g, '');
  if (net.isIPv4(bareIp) || net.isIPv6(bareIp)) {
    if (isPrivateIP(bareIp)) {
      throw new SSRFError(`Request to private IP address is not allowed: ${bareIp}`, hostname);
    }
    return {};
  }

  const addresses = await resolveHostnameAddresses(hostname);
  if (!addresses.length) {
    // DNS çözüm başarısız — undici varsayılan resolver'a bırak
    return {};
  }

  assertAddressesNotPrivate(hostname, addresses);
  return { dispatcher: createSsrfSafeDispatcher(hostname) };
}

export class SSRFError extends Error {
  hostname: string;
  resolvedIp?: string;
  constructor(message: string, hostname: string, resolvedIp?: string) {
    super(message);
    this.name = 'SSRFError';
    this.hostname = hostname;
    this.resolvedIp = resolvedIp;
  }
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

  let dispatcher: Agent | undefined;
  if (!skipSsrfCheck) {
    ({ dispatcher } = await assertNotSSRF(url));
  }

  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = callerSignal
    ? anyAbortSignal([callerSignal as AbortSignal, timeoutSignal])
    : timeoutSignal;

  const headers: Record<string, string> = {
    'User-Agent': DEFAULT_UA,
    ...(callerHeaders as Record<string, string> | undefined ?? {}),
  };

  const { body, ...safeRest } = rest;
  const init = { signal, headers, dispatcher, ...safeRest } as Parameters<typeof undiciFetch>[1];
  if (body !== null && body !== undefined) (init as { body?: typeof body }).body = body;
  return undiciFetch(url, init) as unknown as Promise<Response>;
}

export default fetchT;
