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
