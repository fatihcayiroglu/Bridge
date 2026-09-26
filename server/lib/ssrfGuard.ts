// server/lib/ssrfGuard.ts
// SSRF POLITIKASI — TASIYICIDAN BAGIMSIZ
//
// Bu modul "bu adrese baglanmak guvenli mi?" sorusunu yanitlar ve BASKA HICBIR
// SEY YAPMAZ. Ozellikle bir HTTP istemcisine bagimli DEGILDIR.
//
// ── NEDEN AYRI BIR DOSYA ──────────────────────────────────────────────────
// Politika daha once `lib/fetch.ts` icinde yasiyordu ve o dosya `undici`yi
// modul yuklenirken import eder. Sonucta SSRF KURALINI sormak isteyen her
// modul bir HTTP istemcisini de yuklemek zorunda kaliyordu. Bu yalnizca
// estetik bir sorun degildi: `undici` yuklenirken `http2.constants` okur, bu
// yuzden `http2`yi mock'layan testler ilgisiz modulleri de kirdi.
//
// Politikayi ayirmak, tasiyiciyi KENDI icinde yapan ucuncu taraf
// kutuphanelerin (ornegin `web-push`) hedeflerini de ayni kurallarla
// dogrulamayi mumkun kilar.
//
// TEK KAYNAK: private IP araliklari, allowlist ve DNS cozumleme burada tanimlanir.
// `lib/fetch.ts` ve `lib/urlSafety.ts` buradan tuketir — kopya YOKTUR.

import dns from 'dns/promises';
import net from 'net';

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


// Whitelist: SSRF_ALLOWLIST="idp.example.com,accounts.google.com"
export function isSsrfAllowlisted(hostname: string): boolean {
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

// ════════════════════════════════════════════════════════════════════════════
// IPv6 DENETIMI METIN ONEKI ILE DEGIL, BAYT DUZEYINDE YAPILIR
// ════════════════════════════════════════════════════════════════════════════
// ONCEKI HALI metin oneki listesiydi ('::ffff:', '2002:a', ...). Bu YANILTICI
// bir guven veriyordu cunku ayni adres COK SAYIDA metin formunda yazilabilir:
//
//     ::ffff:127.0.0.1          → WHATWG URL bunu '::ffff:7f00:1' yapar
//     0:0:0:0:0:ffff:127.0.0.1  → ayni adres, hicbir oneke uymaz
//     0:0:0:0:0:0:0:1           → ::1 ile ayni adres, '::1' onekine UYMAZ
//     ::                        → belirsiz adres, listede HIC yoktu
//
// Yani onek eslesmesi, adresin yazilisina bagliydi. Bayt duzeyinde
// karsilastirma bu sinifi tumuyle kapatir: adres once 16 bayta cozulur,
// sonra aralik denetimi yapilir. Yazim bicimi artik onemsizdir.


function ipv6ToBytes(input: string): number[] | null {
  let s = input.toLowerCase().replace(/^\[|\]$/g, '');
  const zone = s.indexOf('%');                 // fe80::1%eth0 → bolge eki atilir
  if (zone >= 0) s = s.slice(0, zone);
  if (!net.isIPv6(s)) return null;

  // Gomulu IPv4 son eki iki hextet'e cevrilir: '::ffff:127.0.0.1' → '::ffff:7f00:1'
  const v4 = s.match(/(?:^|:)((?:\d{1,3}\.){3}\d{1,3})$/);
  const embeddedV4 = v4?.[1];
  if (embeddedV4) {
    const q = embeddedV4.split('.').map(Number);
    // Dört oktet ŞART: eksik/bozuk bir gömülü IPv4, aritmetikte `NaN`
    // üretip adresi yanlışlıkla "genel" saydırabilirdi.
    if (q.length !== 4 || q.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    const [o0, o1, o2, o3] = q as [number, number, number, number];
    const hex = (((o0 << 8) | o1) >>> 0).toString(16)
      + ':' + (((o2 << 8) | o3) >>> 0).toString(16);
    s = s.slice(0, s.length - embeddedV4.length) + hex;
  }

  const hasGap = s.includes('::');
  const [head, tail = ''] = s.split('::');
  const headParts = head ? head.split(':').filter(Boolean) : [];
  const tailParts = tail ? tail.split(':').filter(Boolean) : [];

  let hextets: string[];
  if (hasGap) {
    const missing = 8 - headParts.length - tailParts.length;
    if (missing < 0) return null;
    hextets = [...headParts, ...Array(missing).fill('0'), ...tailParts];
  } else {
    hextets = headParts;
  }
  if (hextets.length !== 8) return null;

  const bytes: number[] = [];
  for (const h of hextets) {
    const n = parseInt(h || '0', 16);
    if (!Number.isFinite(n) || n < 0 || n > 0xffff) return null;
    bytes.push((n >> 8) & 0xff, n & 0xff);
  }
  return bytes;
}

function ip4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, octet) => (acc << 8) | parseInt(octet, 10), 0) >>> 0;
}

function isPrivateIPv4(ip: string): boolean {
  if (!net.isIPv4(ip)) return false;
  const n = ip4ToInt(ip);
  return PRIVATE_RANGES_V4.some(({ base, mask }) => (n & mask) === (base & mask));
}

function isPrivateIPv6(ip: string): boolean {
  const b = ipv6ToBytes(ip);
  if (!b) return false;                                   // IPv6 degil → IPv4 denetimi karar versin
  const zerosTo = (n: number) => b.slice(0, n).every(x => x === 0);

  // ::  (belirsiz)  ve  ::1  (loopback)
  if (zerosTo(15) && (b[15] === 0 || b[15] === 1)) return true;

  // IPv4-mapped  ::ffff:a.b.c.d  → gomulu IPv4'u denetle
  if (zerosTo(10) && b[10] === 0xff && b[11] === 0xff) {
    return isPrivateIPv4(b.slice(12).join('.'));
  }

  // IPv4-translated (NAT64)  64:ff9b::/96
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b
      && b.slice(4, 12).every(x => x === 0)) {
    return isPrivateIPv4(b.slice(12).join('.'));
  }

  // 6to4  2002::/16 — gomulu IPv4 baytlari 2..5
  // Bayt dizisi eksikse adres AYRIŞTIRILAMAMIŞTIR; "genel" varsaymak
  // SSRF korumasını sessizce devre dışı bırakırdı → fail-closed.
  const b0 = b[0];
  const b1 = b[1];
  if (b0 === undefined || b1 === undefined) return true;

  if (b0 === 0x20 && b1 === 0x02) {
    return isPrivateIPv4(b.slice(2, 6).join('.'));
  }

  if (b0 === 0xfe && (b1 & 0xc0) === 0x80) return true;  // fe80::/10 link-local
  if ((b0 & 0xfe) === 0xfc) return true;                 // fc00::/7  ULA
  if (b0 === 0xff) return true;                          // ff00::/8  multicast
  return false;
}

export function isPrivateIP(ip: string): boolean {
  return isPrivateIPv4(ip) || isPrivateIPv6(ip);
}

export function assertAddressesNotPrivate(hostname: string, addresses: string[]): void {
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

/**
 * Hostname icin adresleri cozer.
 *
 * ── NEDEN `dns.lookup` YEDEGI VAR ────────────────────────────────────────
 * `dns.resolve*` YALNIZCA DNS'e sorar; `/etc/hosts`, mDNS ve isletim
 * sistemi cozumleyicisini GORMEZ. undici ise baglanirken sistem
 * cozumleyicisini kullanir. Bu ayrisma bir FAIL-OPEN uretiyordu:
 * `dns.resolve` bos donunce `assertNotSSRF` denetimi ATLAYIP `{}` donuyor,
 * ardindan undici ayni adi sistem uzerinden coz up ozel bir IP'ye
 * baglanabiliyordu.
 *
 * Artik once DNS, sonra sistem cozumleyicisi denenir — yani denetim,
 * baglantinin GERCEKTEN kullanacagi adresleri gorur.
 */
export async function resolveHostnameAddresses(hostname: string): Promise<string[]> {
  const out = new Set<string>();
  try { for (const a of await dns.resolve4(hostname)) out.add(a); } catch { /* A kaydi yok */ }
  try { for (const a of await dns.resolve6(hostname)) out.add(a); } catch { /* AAAA kaydi yok */ }
  if (out.size) return [...out];

  // Sistem cozumleyicisi (undici'nin kullandigi yol) — /etc/hosts dahil.
  try {
    const found = await dns.lookup(hostname, { all: true });
    for (const r of found) out.add(r.address);
  } catch { /* gercekten cozulemiyor */ }
  return [...out];
}

export interface TargetVerdict {
  hostname: string;
  /** SSRF_ALLOWLIST ile acikca izin verildi — ileri denetim yapilmadi. */
  allowlisted: boolean;
  /** Hostname zaten bir IP idi; DNS devreye girmedi. */
  bareIp: boolean;
  /** DNS ile cozulen ve HEPSI public oldugu dogrulanan adresler. */
  addresses: string[];
}

export async function assertTargetAllowed(url: string | URL): Promise<TargetVerdict> {
  const parsed = typeof url === 'string' ? new URL(url) : url;
  const hostname = parsed.hostname.toLowerCase();

  // Protokol kontrolu — sadece http/https
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new SSRFError(`Protocol not allowed: ${parsed.protocol}`, hostname);
  }

  if (isSsrfAllowlisted(hostname)) {
    return { hostname, allowlisted: true, bareIp: false, addresses: [] };
  }

  // Hostname zaten IP mi?
  const bareIp = hostname.replace(/^\[|\]$/g, '');
  if (net.isIPv4(bareIp) || net.isIPv6(bareIp)) {
    if (isPrivateIP(bareIp)) {
      throw new SSRFError(`Request to private IP address is not allowed: ${bareIp}`, hostname);
    }
    return { hostname, allowlisted: false, bareIp: true, addresses: [bareIp] };
  }

  const addresses = await resolveHostnameAddresses(hostname);
  if (!addresses.length) {
    // DNS cozum basarisiz — karar cagirana birakilir.
    return { hostname, allowlisted: false, bareIp: false, addresses: [] };
  }

  assertAddressesNotPrivate(hostname, addresses);
  return { hostname, allowlisted: false, bareIp: false, addresses };
}

/**
 * SSRF kontrolunu bir HTTP istemcisi OLMADAN uygular.
 *
 * Istegi BIZIM YAPMADIGIMIZ cagrilar icindir: `web-push` gibi kutuphaneler
 * baglantiyi kendi acar, bizim dispatcher'imiz devreye giremez. Adres o
 * kutuphaneye TESLIM EDILMEDEN once burada dogrulanir.
 *
 * `fetchT`den bir farki vardir ve bilerektir: COZULEMEYEN host REDDEDILIR.
 * `fetchT` o durumda gecirir cunku undici'nin kendi resolver'ina duser ve
 * gecici bir DNS hatasi tum giden istekleri kirmamalidir. Burada ise guard
 * uygulanamiyor demektir; kontrol aninda cozulmeyen bir ad cagri aninda
 * cozulup hicbir denetimden gecmeden baglanabilir. Maliyeti de yoktur:
 * cozulemeyen bir push endpoint'i zaten kullanilamaz.
 *
 * @throws {SSRFError} hedef private/ic ag ise ya da cozulemiyorsa.
 */
/**
 * DNS YAPMADAN, yalnizca senkron denetimler.
 *
 * ── NEDEN AYRI BIR BICIM VAR ──────────────────────────────────────────────
 * `assertUrlIsPublic` DNS cozumlemesi yapar. Bu, bir KAYIT ucunda iki sorun
 * dogurdu:
 *
 *   1. Kullaniciya bakan istek yoluna AG G/C eklendi. DNS yavasladiginda
 *      `POST /api/webpush/subscribe` de yavaslar.
 *   2. Testler belirlenimsiz hale geldi: tam paket kosumunda DNS gecikmesi
 *      zaman asimina yol acip iki testi ARALIKLI dusurdu.
 *
 * Guvenlik ozelligi bundan ZARAR GORMEZ: asil zorlama noktasi GONDERIM
 * anidir (`pushSender.sendWebPush`), cunku adres oraya kadar degisebilir
 * (DNS rebinding) ve saklanmis eski satirlar da orada denetlenir.
 *
 * Burada yalnizca ISTEMCIYE HIZLI GERI BILDIRIM verilir: bozuk sema ya da
 * apacik ic ag adresi ANINDA reddedilir.
 *
 * @throws {SSRFError} sema gecersizse ya da ciplak IP private ise.
 */
export function assertUrlIsPublicSync(url: string | URL): void {
  const parsed = typeof url === 'string' ? new URL(url) : url;
  const hostname = parsed.hostname.toLowerCase();

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new SSRFError(`Protocol not allowed: ${parsed.protocol}`, hostname);
  }
  if (isSsrfAllowlisted(hostname)) return;

  const bareIp = hostname.replace(/^\[|\]$/g, '');
  if ((net.isIPv4(bareIp) || net.isIPv6(bareIp)) && isPrivateIP(bareIp)) {
    throw new SSRFError(`Request to private IP address is not allowed: ${bareIp}`, hostname);
  }
}

export interface PublicUrlOptions {
  /**
   * COZULEMEYEN hostname'e izin ver.
   *
   * Yalnizca KAYIT/dogrulama noktalari icindir: gecici bir DNS hatasi mesru
   * bir aboneligi 400 ile reddetmemelidir. Guvenlik ozelligi bundan ZARAR
   * GORMEZ, cunku adres kullanilmadan hemen once tekrar — ve KATI sekilde —
   * denetlenir. Asil zorlama noktasi orasidir.
   *
   * Baglanti yapan cagri noktalarinda ASLA kullanilmaz.
   */
  allowUnresolvable?: boolean;
}

export async function assertUrlIsPublic(
  url: string | URL,
  opts: PublicUrlOptions = {},
): Promise<void> {
  const verdict = await assertTargetAllowed(url);
  if (verdict.allowlisted || verdict.bareIp) return;
  if (!verdict.addresses.length) {
    if (opts.allowUnresolvable) return;
    throw new SSRFError(`Hostname could not be resolved: ${verdict.hostname}`, verdict.hostname);
  }
}
