// server/tests/ssrf-outbound.test.ts
//
// SSRF — SÖMÜRÜ TARZI GERİLEME TESTLERİ
//
// ════════════════════════════════════════════════════════════════════════════
// KAPATILAN GERÇEK AÇIKLAR
// ════════════════════════════════════════════════════════════════════════════
// 1) IPv4-MAPPED IPv6 DOĞRULAMA ATLATMASI
//    `POST /api/servers/:sid/outgoing-webhooks` şu hedefleri KABUL EDİYORDU:
//        http://[::ffff:127.0.0.1]:5433/   → 201  (yerel PostgreSQL)
//        http://[::ffff:10.0.0.5]/         → 201  (iç ağ)
//        http://[64:ff9b::7f00:1]/         → 201  (NAT64 loopback)
//    Aynı hedeflerin düz yazımları (127.0.0.1, 10.0.0.5) doğru şekilde 400'dü.
//
//    KÖK SEBEP: `lib/urlSafety.ts` `::ffff:` sonrasını NOKTALI IPv4 olarak
//    arıyordu. Oysa WHATWG URL ayrıştırıcısı adresi normalleştirir:
//        new URL('http://[::ffff:127.0.0.1]/').hostname === '[::ffff:7f00:1]'
//    Yani noktalı form URL'den hiç gelmez — o dal ÖLÜ KODDU. `lib/fetch.ts`
//    aynı adresi doğru sayıyordu; iki katman AYNI FİKİRDE DEĞİLDİ ve zayıf
//    olan, doğrulamayı yapan katmandı.
//
// 2) YÖNLENDİRME İLE SSRF
//    SSRF denetimi YALNIZCA ilk adrese uygulanıyordu. Ölçüldü:
//        ilk hedef → 302 Location: http://127.0.0.1:<port>/
//        sonuç: 200 "INTERNAL_SECRET_DATA"   ← iç veri okundu ve döndürüldü
//    `assertNotSSRF` bazı yollarda dispatcher üretmeden geçer (allowlist,
//    düz genel IP, boş DNS) — o durumlarda bağlantı-anı denetimi de yoktur.
//
// Bu dosya iddiaları ZAYIFLATMAZ: gerçek hedeflere gerçek istekler kurar ve
// engellenmelerini bekler. Meşru genel adreslerin ÇALIŞMAYA DEVAM ETTİĞİ de
// ayrıca doğrulanır — yoksa "her şeyi engelle" ile de geçerdi.

import http from 'http';
import dns from 'dns/promises';
import type { AddressInfo } from 'net';
import { checkOutboundUrl, isPrivateAddress } from '../lib/urlSafety';
import { fetchT, isPrivateIP, SSRFError } from '../lib/fetch';

jest.setTimeout(20_000);

describe('SSRF — adres sınıflandırması', () => {
  // Her biri GERÇEK bir iç hedefe karşılık gelir.
  const mustBlock: Array<[string, string]> = [
    ['loopback (düz)',            '127.0.0.1'],
    ['bulut metadata',            '169.254.169.254'],
    ['RFC1918 10/8',              '10.0.0.5'],
    ['RFC1918 172.16/12',         '172.20.10.1'],
    ['RFC1918 192.168/16',        '192.168.1.1'],
    ['CGNAT 100.64/10',           '100.64.0.1'],
    ['0.0.0.0/8',                 '0.0.0.0'],
    ['IPv6 loopback',             '::1'],
    ['IPv6 loopback (genişletilmiş)', '0:0:0:0:0:0:0:1'],
    ['IPv6 belirsiz',             '::'],
    ['IPv6 link-local',           'fe80::1'],
    ['IPv6 ULA',                  'fc00::1'],
    ['IPv4-mapped loopback',      '::ffff:127.0.0.1'],
    ['IPv4-mapped loopback (hex)', '::ffff:7f00:1'],
    ['IPv4-mapped 10/8',          '::ffff:10.0.0.5'],
    ['NAT64 loopback',            '64:ff9b::7f00:1'],
    ['6to4 loopback',             '2002:7f00:1::'],
  ];

  it.each(mustBlock)('%s ÖZEL olarak sınıflandırılır', (_label, ip) => {
    // KANITLAR   : adres, yazım biçiminden bağımsız olarak özel sayılıyor.
    // KANITLAMAZ : rotaların bu sınıflandırmayı kullandığını (ayrıca test edilir).
    expect(isPrivateIP(ip)).toBe(true);
    expect(isPrivateAddress(ip)).toBe(true);
  });

  it.each([
    ['genel IPv4', '93.184.216.34'],
    ['genel IPv6', '2606:2800:220:1:248:1893:25c8:1946'],
  ])('%s ÖZEL SAYILMAZ — kural körü körüne engellemiyor', (_l, ip) => {
    expect(isPrivateIP(ip)).toBe(false);
  });
});

describe('SSRF — giden URL doğrulaması (webhook oluşturma yolu)', () => {
  const mustBlockUrls = [
    'http://127.0.0.1:5433/',
    'http://localhost:5433/',
    'http://169.254.169.254/latest/meta-data/',
    'http://10.0.0.5/admin',
    'http://[::1]:6379/',
    // ── Aşağıdakiler ESKİDEN GEÇİYORDU ────────────────────────────────
    'http://[::ffff:127.0.0.1]:5433/',
    'http://[::ffff:7f00:1]:5433/',
    'http://[0:0:0:0:0:ffff:127.0.0.1]/',
    'http://[::ffff:10.0.0.5]/',
    'http://[64:ff9b::7f00:1]/',
    'http://[2002:7f00:1::]/',
    'http://[::]/',
    // Protokol kaçışları
    'file:///etc/passwd',
    'gopher://127.0.0.1:6379/_INFO',
    'ftp://127.0.0.1/',
  ];

  it.each(mustBlockUrls)('%s REDDEDİLİR', async (url) => {
    const r = await checkOutboundUrl(url);
    // Nesne karşılaştırması: başarısızlıkta HANGİ url olduğu diff'te görünür.
    expect({ url, allowed: r.ok }).toEqual({ url, allowed: false });
  });

  it.each([
    // Dış DNS'e bağlı olmayan gerçek genel IP'ler: policy'nin 'her şeyi engelle'
    // olmadığını ölçer, ağ erişimi olmayan CI'da rastgele kırılmaz.
    'http://93.184.216.34/hook',
    'https://1.1.1.1/webhook',
  ])('%s KABUL EDİLİR — meşru hedefler kırılmadı', async (url) => {
    const r = await checkOutboundUrl(url);
    expect({ url, allowed: r.ok }).toEqual({ url, allowed: true });
  });

  it('boş / bozuk girdi reddedilir (fail-closed)', async () => {
    for (const bad of ['', '   ', 'not a url', null, undefined, 42, {}]) {
      const r = await checkOutboundUrl(bad as unknown);
      expect(r.ok).toBe(false);
    }
  });
});

describe('SSRF — yönlendirme zinciri her adımda denetlenir', () => {
  let dns4Spy: jest.SpyInstance;
  let dns6Spy: jest.SpyInstance;
  let lookupSpy: jest.SpyInstance;
  let secretSrv: http.Server;
  let redirectSrv: http.Server;
  let chainSrv: http.Server;
  let secretPort = 0;
  let redirectPort = 0;
  let chainPort = 0;

  const listen = (srv: http.Server): Promise<number> =>
    new Promise((resolve) => srv.listen(0, '127.0.0.1', () => {
      resolve((srv.address() as AddressInfo).port);
    }));

  beforeAll(async () => {
    // `localhost` çözümünü dış DNS/OS resolver hızından bağımsız ve
    // deterministik yap. Policy yine private-IP kararını gerçek kodla verir.
    dns4Spy = jest.spyOn(dns, 'resolve4').mockResolvedValue(['127.0.0.1']);
    dns6Spy = jest.spyOn(dns, 'resolve6').mockResolvedValue([]);
    lookupSpy = jest.spyOn(dns, 'lookup').mockResolvedValue([{ address: '127.0.0.1', family: 4 }] as any);
    // "İç servis": ulaşılırsa sızıntı kanıtlanmış olur.
    secretSrv = http.createServer((_q, s) => { s.writeHead(200); s.end('INTERNAL_SECRET_DATA'); });
    secretPort = await listen(secretSrv);

    // Tek adımlı yönlendirme → iç servis
    redirectSrv = http.createServer((_q, s) => {
      s.writeHead(302, { Location: `http://localhost:${secretPort}/` }); s.end();
    });
    redirectPort = await listen(redirectSrv);

    // Zincir: → yönlendirici → iç servis
    chainSrv = http.createServer((_q, s) => {
      s.writeHead(302, { Location: `http://localhost:${redirectPort}/` }); s.end();
    });
    chainPort = await listen(chainSrv);
  });

  afterAll(async () => {
    dns4Spy.mockRestore();
    dns6Spy.mockRestore();
    lookupSpy.mockRestore();
    await Promise.all([secretSrv, redirectSrv, chainSrv].map(
      (s) => new Promise<void>((r) => s.close(() => r())),
    ));
  });

  it('doğrudan özel adrese istek ENGELLENİR', async () => {
    await expect(fetchT(`http://127.0.0.1:${secretPort}/`, { timeoutMs: 4000 }))
      .rejects.toThrow(SSRFError);
  });

  it('ÖZEL ADRESE YÖNLENDİRME engellenir — iç veri sızmaz', async () => {
    // İlk hedef allowlist'te olduğunda dispatcher üretilmez; eski kodda
    // yönlendirme bu noktadan sonra hiç denetlenmiyordu.
    const prev = process.env.SSRF_ALLOWLIST;
    process.env.SSRF_ALLOWLIST = '127.0.0.1';
    try {
      let leaked = '';
      try {
        const res = await fetchT(`http://127.0.0.1:${redirectPort}/`, { timeoutMs: 4000 });
        leaked = await res.text();
      } catch (err) {
        expect((err as Error).name).toBe('SSRFError');
      }
      expect(leaked).not.toContain('INTERNAL_SECRET');
    } finally {
      if (prev === undefined) delete process.env.SSRF_ALLOWLIST;
      else process.env.SSRF_ALLOWLIST = prev;
    }
  });

  it('YÖNLENDİRME ZİNCİRİ de engellenir', async () => {
    const prev = process.env.SSRF_ALLOWLIST;
    process.env.SSRF_ALLOWLIST = '127.0.0.1';
    try {
      let leaked = '';
      try {
        const res = await fetchT(`http://127.0.0.1:${chainPort}/`, { timeoutMs: 4000 });
        leaked = await res.text();
      } catch (err) {
        expect((err as Error).name).toBe('SSRFError');
      }
      expect(leaked).not.toContain('INTERNAL_SECRET');
    } finally {
      if (prev === undefined) delete process.env.SSRF_ALLOWLIST;
      else process.env.SSRF_ALLOWLIST = prev;
    }
  });
});

describe('SSRF — protokol ve süre sınırı', () => {
  it('http/https DIŞINDAKİ protokoller reddedilir', async () => {
    for (const url of ['file:///etc/passwd', 'ftp://example.com/', 'gopher://example.com/']) {
      await expect(fetchT(url, { timeoutMs: 3000 })).rejects.toThrow();
    }
  });

  it('takılı bağlantı SÜRE SINIRINA takılır — sınırsız beklemez', async () => {
    // Hiç yanıt vermeyen sunucu: istek asılı kalırsa test süresi dolardı.
    const hang = http.createServer(() => { /* bilerek yanıt yok */ });
    await new Promise<void>((r) => hang.listen(0, '127.0.0.1', () => r()));
    const port = (hang.address() as AddressInfo).port;
    const prev = process.env.SSRF_ALLOWLIST;
    process.env.SSRF_ALLOWLIST = '127.0.0.1';
    const t0 = Date.now();
    try {
      await expect(fetchT(`http://127.0.0.1:${port}/`, { timeoutMs: 1200 })).rejects.toThrow();
      expect(Date.now() - t0).toBeLessThan(6000);
    } finally {
      if (prev === undefined) delete process.env.SSRF_ALLOWLIST;
      else process.env.SSRF_ALLOWLIST = prev;
      await new Promise<void>((r) => hang.close(() => r()));
    }
  });
});
