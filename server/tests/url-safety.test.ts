// server/tests/url-safety.test.ts
//
// GİDEN WEBHOOK HEDEFİ — SSRF SAVUNMASI
//
// ════════════════════════════════════════════════════════════════════════════
// KAPATILAN GERÇEK AÇIK
// ════════════════════════════════════════════════════════════════════════════
// Giden webhook URL'si yalnızca SÖZDİZİMSEL doğrulanıyordu:
//     try { new URL(url); } catch { ... }
//
// `new URL()` güvenlik söylemez. Bu doğrulamayı geçen hedefler:
//     http://127.0.0.1:5433/           → yerel PostgreSQL
//     http://169.254.169.254/latest/…  → bulut metadata (KİMLİK BİLGİSİ)
//     http://10.0.0.5/admin            → iç ağ
//     http://[::1]:6379/               → yerel Redis
//
// Ardından Bridge bu adrese KENDİ AĞ KONUMUNDAN POST atıyordu: webhook
// oluşturabilen biri Bridge'i iç ağa vekil olarak kullanabilirdi.
//
// Bridge kendi sunucusunda barındırılabilir; sunucu yöneticisi ile altyapı
// sahibi aynı kişi olmayabilir. Hedef kısıtı ürünün işidir.

process.env.NODE_ENV = 'test';

import { isPrivateAddress, checkOutboundUrl } from '../lib/urlSafety';

describe('özel adres tanıma', () => {
  it.each([
    ['127.0.0.1'], ['10.0.0.5'], ['192.168.1.1'], ['172.16.0.1'], ['172.31.255.255'],
    ['169.254.169.254'], ['0.0.0.0'], ['100.64.0.1'], ['224.0.0.1'],
  ])('IPv4 özel: %s', (ip) => expect(isPrivateAddress(ip)).toBe(true));

  it.each([['::1'], ['fe80::1'], ['fc00::1'], ['fd12:3456::1'], ['::ffff:127.0.0.1']])(
    'IPv6 özel: %s', (ip) => expect(isPrivateAddress(ip)).toBe(true));

  it.each([['8.8.8.8'], ['1.1.1.1'], ['93.184.216.34'], ['2606:4700::1111']])(
    'genel adres: %s', (ip) => expect(isPrivateAddress(ip)).toBe(false));

  it('tanınmayan girdi GÜVENLİ tarafa düşer', () => {
    expect(isPrivateAddress('not-an-ip')).toBe(true);
    expect(isPrivateAddress('')).toBe(true);
  });
});

describe('checkOutboundUrl — SSRF hedefleri reddedilir', () => {
  it.each([
    ['http://127.0.0.1:5433/'],
    ['http://169.254.169.254/latest/meta-data/'],
    ['http://10.0.0.5/admin'],
    ['http://192.168.1.1/'],
    ['http://[::1]:6379/'],
    ['http://localhost:3000/'],
    ['http://db.internal/'],
  ])('reddeder: %s', async (url) => {
    const r = await checkOutboundUrl(url);
    expect(r.ok).toBe(false);
  });

  it('http/https DIŞI protokoller reddedilir', async () => {
    for (const url of ['file:///etc/passwd', 'gopher://x/', 'ftp://x/']) {
      expect((await checkOutboundUrl(url)).ok).toBe(false);
    }
  });

  it('bozuk/boş girdi reddedilir', async () => {
    for (const bad of ['', '   ', 'not a url', null, undefined, 42]) {
      expect((await checkOutboundUrl(bad as unknown as string)).ok).toBe(false);
    }
  });

  it('reddetme sebebi KULLANICIYA gösterilebilir', async () => {
    const r = await checkOutboundUrl('http://127.0.0.1/');
    expect(typeof r.reason).toBe('string');
    expect(r.reason!.length).toBeGreaterThan(0);
  });
});

describe('kaçış kapısı AÇIKÇA opt-in', () => {
  it('varsayılan KAPALI — iç hedefler reddedilir', async () => {
    delete process.env.ALLOW_INTERNAL_WEBHOOKS;
    expect((await checkOutboundUrl('http://127.0.0.1/')).ok).toBe(false);
  });

  it('açıkça izin verilirse iç hedef geçer', async () => {
    // Kendi sunucusunda barındıran ve gerçekten iç servise gönderen kurulum.
    process.env.ALLOW_INTERNAL_WEBHOOKS = 'true';
    expect((await checkOutboundUrl('http://127.0.0.1/')).ok).toBe(true);
    delete process.env.ALLOW_INTERNAL_WEBHOOKS;
  });
});

describe('rotalar denetimi KULLANIR', () => {
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'routes', 'outgoingWebhooks.ts'), 'utf8');

  it('oluşturma normalize edilmiş URL üzerinde denetlenir', () =>
    expect(src).toMatch(/checkOutboundUrl\(normalizedUrl\)/));
  it('teslimat da denetlenir (derinlemesine savunma)', () => {
    // Eski kayıtlar denetimden önce eklenmiş olabilir; DNS sonradan değişebilir.
    expect(src).toMatch(/checkOutboundUrl\(webhook\.url\)/);
    expect(src).toMatch(/webhook\.blocked_unsafe_target/);
  });
  it('çıplak `new URL` doğrulaması KALMADI', () => {
    expect(src).not.toMatch(/try \{ new URL\(url\); \} catch/);
  });
});

// A domain name is only as safe as EVERY address it resolves to. Without these
// checks a hostname pointing at 169.254.169.254 (or one public plus one
// private address, the DNS-rebinding shape) would turn a webhook into a proxy
// into the operator's network.
describe('checkOutboundUrl — domain names are judged by what they resolve to', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const dnsPromises = require('dns').promises as { lookup: (...args: unknown[]) => Promise<unknown> };
  let lookup: jest.SpyInstance;
  beforeEach(() => {
    delete process.env.ALLOW_INTERNAL_WEBHOOKS;
    lookup = jest.spyOn(dnsPromises, 'lookup');
  });
  afterEach(() => lookup.mockRestore());
  const resolvesTo = (...addresses: string[]) => lookup.mockResolvedValueOnce(
    addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })));

  it('a name resolving only to public addresses is allowed, and every address was asked for', async () => {
    resolvesTo('93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946');
    await expect(checkOutboundUrl('https://hooks.example.com/x')).resolves.toEqual({ ok: true });
    expect(lookup).toHaveBeenCalledWith('hooks.example.com', { all: true });
  });

  it.each([
    ['the cloud metadata address', ['169.254.169.254']],
    ['one public and one private address', ['93.184.216.34', '10.1.2.3']],
    ['IPv6 loopback', ['::1']],
    ['an IPv4-mapped private address', ['::ffff:192.168.0.10']],
  ])('a name resolving to %s is refused', async (_name, addresses) => {
    resolvesTo(...addresses);
    await expect(checkOutboundUrl('https://hooks.example.com/x'))
      .resolves.toEqual({ ok: false, reason: 'Özel/yerel ağ adresleri hedef olamaz' });
  });

  it('a name that resolves to nothing, or fails to resolve, is refused', async () => {
    lookup.mockResolvedValueOnce([]);
    await expect(checkOutboundUrl('https://empty.example.com/')).resolves.toEqual({ ok: false, reason: 'Adres çözümlenemedi' });
    lookup.mockRejectedValueOnce(Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }));
    await expect(checkOutboundUrl('https://nxdomain.example.com/')).resolves.toEqual({ ok: false, reason: 'Adres çözümlenemedi' });
  });

  it('local name suffixes are refused before any lookup', async () => {
    for (const url of ['http://printer.local/', 'http://admin.localhost/', 'http://svc.internal/']) {
      await expect(checkOutboundUrl(url)).resolves.toMatchObject({ ok: false });
    }
    expect(lookup).not.toHaveBeenCalled();
  });
});
