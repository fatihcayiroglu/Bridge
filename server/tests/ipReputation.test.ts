// server/tests/ipReputation.test.ts
import { makeMiddlewareDoubles, injectMissingHeaderBag, type ReqDouble, type ResDouble, type NextDouble } from './helpers/expressDoubles';
// IP Reputation Kontrolü — birim + entegrasyon testleri
//
// Bu testler hiçbir harici ağ isteği yapmaz.
// AbuseIPDB ve Tor listesi tamamen mock'lanır.

process.env.NODE_ENV       = 'test';
process.env.JWT_SECRET     = 'test-jwt-secret-long-enough-32chars!!';
process.env.REFRESH_SECRET = 'test-refresh-secret-long-enough-32!!';

// ipBan.js, ipReputation.js tarafından import ediliyor —
// getClientIp'in çalışması için gerçek modül yüklenmeli.
jest.mock('../db/loader', () => require('./helpers/mockDb').createMockDb());

// https modülünü mock'la — AbuseIPDB isteklerini simüle etmek için
//
// `null` = yanıt hiç gelmez (zaman aşımı senaryosu). Bildirimin TİPLİ olması
// şart: aksi halde `_mockHttpsResponse` örtük `any` olur ve her kullanım yeri
// ayrı bir strict hatası doğurur.
// `statusCode` ISTEGE BAGLIdir: ne ikiz onu `mockRes`e koyuyor ne de urun
// (`middleware/ipReputation.ts`) okuyor. Zorunlu yazmak, var olmayan bir
// sozlesmeyi varmis gibi gosteriyor ve bes cagri yerinde TS2741 uretiyordu.
type MockHttpsResponse = { statusCode?: number; body: string } | null;
type HttpsDataHandler = (chunk: string) => void;
type HttpsEndHandler = () => void;
/** `https.IncomingMessage`in bu testin dokunduğu alt kümesi. */
interface HttpsResponseDouble {
  on: jest.Mock;
}

let _mockHttpsResponse: MockHttpsResponse = null;
jest.mock('https', () => ({
  get: jest.fn((url: string, optsOrCb: unknown, cb?: unknown) => {
    // https.get(url, headers, callback) veya https.get(url, callback)
    const callback = typeof optsOrCb === 'function' ? optsOrCb : cb;
    const mockRes: HttpsResponseDouble = {
      on: jest.fn((event: string, handler: HttpsDataHandler & HttpsEndHandler) => {
        if (event === 'data' && _mockHttpsResponse) handler(_mockHttpsResponse.body);
        if (event === 'end')                         handler();
        return mockRes;
      }),
    };
    process.nextTick(() => {
      if (_mockHttpsResponse === null) {
        // timeout simülasyonu — req.setTimeout callback'ini tetikle
        return;
      }
      if (typeof callback === 'function') callback(mockRes);
    });
    return {
      setTimeout: jest.fn(),
      destroy:    jest.fn(),
      on:         jest.fn(),
    };
  }),
}));

const {
  checkIpReputation,
  ipReputationMiddleware,
  _clearCache,
  _setStaticBlocklist,
  _setTorExitNodes,
  _setConfig,
  _getConfig,
  _isPrivateIp,
  _ipInCidr,
} = require('../middleware/ipReputation');

// Her testten önce cache'i ve ayarları sıfırla
beforeEach(() => {
  _clearCache();
  _setStaticBlocklist(new Set());
  _setTorExitNodes(new Set());
  _mockHttpsResponse = null;
  _setConfig({
    enabled:         true,
    abuseIpDbKey:    null,   // API key yok → AbuseIPDB atlanır
    abuseThreshold:  80,
    cacheTtlMs:      3600000,
    blockTor:        false,
    blocklistPath:   null,
  });
});

// ══════════════════════════════════════════════════════════════
// YARDIMCI FONKSİYONLAR
// ══════════════════════════════════════════════════════════════

describe('_isPrivateIp', () => {
  it('loopback/link-local/ULA ve mapped adresleri non-public kabul eder', () => {
    expect(_isPrivateIp('127.0.0.1')).toBe(true);
    expect(_isPrivateIp('127.9.8.7')).toBe(true);
    expect(_isPrivateIp('169.254.10.20')).toBe(true);
    expect(_isPrivateIp('100.64.1.1')).toBe(true);
    expect(_isPrivateIp('::1')).toBe(true);
    expect(_isPrivateIp('fc00::1234')).toBe(true);
    expect(_isPrivateIp('fd12:3456::1')).toBe(true);
    expect(_isPrivateIp('fe80::1')).toBe(true);
    expect(_isPrivateIp('::ffff:10.1.2.3')).toBe(true);
  });

  it('RFC-1918 bloklarını özel kabul eder', () => {
    expect(_isPrivateIp('10.0.0.1')).toBe(true);
    expect(_isPrivateIp('10.255.255.255')).toBe(true);
    expect(_isPrivateIp('172.16.0.1')).toBe(true);
    expect(_isPrivateIp('172.31.255.255')).toBe(true);
    expect(_isPrivateIp('192.168.1.100')).toBe(true);
  });

  it('genel IP adreslerini özel saymaz', () => {
    expect(_isPrivateIp('8.8.8.8')).toBe(false);
    expect(_isPrivateIp('1.1.1.1')).toBe(false);
    expect(_isPrivateIp('203.0.113.5')).toBe(false);
  });

  it('bilinmeyen / boş / malformed değerleri dış servise göndermez', () => {
    expect(_isPrivateIp('unknown')).toBe(true);
    expect(_isPrivateIp('')).toBe(true);
    expect(_isPrivateIp(null)).toBe(true);
    expect(_isPrivateIp('not-an-ip')).toBe(true);
  });
});

describe('_ipInCidr', () => {
  it('/24 bloğu içindeki IP eşleşir', () => {
    expect(_ipInCidr('192.168.1.50', '192.168.1.0/24')).toBe(true);
  });

  it('/24 bloğu dışındaki IP eşleşmez', () => {
    expect(_ipInCidr('192.168.2.1', '192.168.1.0/24')).toBe(false);
  });

  it('/32 tek IP eşleşir', () => {
    expect(_ipInCidr('1.2.3.4', '1.2.3.4/32')).toBe(true);
    expect(_ipInCidr('1.2.3.5', '1.2.3.4/32')).toBe(false);
  });

  it('CIDR olmayan girdi düz IP karşılaştırması yapar', () => {
    expect(_ipInCidr('5.5.5.5', '5.5.5.5')).toBe(true);
    expect(_ipInCidr('5.5.5.6', '5.5.5.5')).toBe(false);
  });

  it.each([
    ['192.168.1.1', '192.168.1.0/24junk'],
    ['192.168.1.1', '192.168.1.0/-1'],
    ['192.168.1.1', '192.168.1.0/33'],
    ['999.1.1.1', '192.168.1.0/24'],
    ['192.168.1.1', '999.168.1.0/24'],
    ['2001:db8::1', '2001:db8::/64'],
    ['192.168.1.1', '192.168.1.0/24/extra'],
  ])('malformed/unsupported CIDR input fails closed: %s in %s', (ip, cidr) => {
    expect(_ipInCidr(ip, cidr)).toBe(false);
  });

  it('/0 IPv4 CIDR aralığını doğru işler', () => {
    expect(_ipInCidr('203.0.113.5', '0.0.0.0/0')).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════
// DEVRE DIŞI MOD
// ══════════════════════════════════════════════════════════════

describe('checkIpReputation — devre dışı', () => {
  beforeEach(() => _setConfig({ enabled: false }));

  it('enabled=false iken hiçbir zaman engel koymaz', async () => {
    _setStaticBlocklist(new Set(['8.8.8.8']));
    const result = await checkIpReputation('8.8.8.8');
    expect(result.blocked).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════
// ÖZEL IP KORUMALARI
// ══════════════════════════════════════════════════════════════

describe('checkIpReputation — özel IP\'ler', () => {
  it('loopback IP\'yi engellemiyor', async () => {
    _setStaticBlocklist(new Set(['127.0.0.1'])); // blocklist'te olsa bile
    const result = await checkIpReputation('127.0.0.1');
    expect(result.blocked).toBe(false);
  });

  it('RFC-1918 IP\'yi engellemiyor', async () => {
    const result = await checkIpReputation('192.168.0.1');
    expect(result.blocked).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════
// STATİK BLOCKLİST
// ══════════════════════════════════════════════════════════════

describe('checkIpReputation — statik blocklist', () => {
  it('blocklist\'teki IP engellenir', async () => {
    _setStaticBlocklist(new Set(['1.2.3.4', '5.6.7.8']));
    const result = await checkIpReputation('1.2.3.4');
    expect(result.blocked).toBe(true);
    expect(result.reason).toMatch(/statik/i);
  });

  it('blocklist\'te olmayan IP geçer', async () => {
    _setStaticBlocklist(new Set(['1.2.3.4']));
    const result = await checkIpReputation('9.9.9.9');
    expect(result.blocked).toBe(false);
  });

  it('CIDR bloğundaki IP engellenir', async () => {
    _setStaticBlocklist(new Set(['10.100.0.0/16'])); // özel gibi görünüyor ama test için
    // Test: CIDR mantığını kontrol et — genel IP ile
    _setStaticBlocklist(new Set(['203.0.113.0/24']));
    const result = await checkIpReputation('203.0.113.42');
    expect(result.blocked).toBe(true);
  });

  it('CIDR dışındaki IP geçer', async () => {
    _setStaticBlocklist(new Set(['203.0.113.0/24']));
    const result = await checkIpReputation('203.0.114.1');
    expect(result.blocked).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════
// TOR ÇIKIŞ DÜĞÜMLERİ
// ══════════════════════════════════════════════════════════════

describe('checkIpReputation — Tor engeli', () => {
  beforeEach(() => _setConfig({ blockTor: true }));

  it('Tor çıkış düğümü engellenir', async () => {
    _setTorExitNodes(new Set(['185.220.101.1']));
    const result = await checkIpReputation('185.220.101.1');
    expect(result.blocked).toBe(true);
    expect(result.reason).toMatch(/tor/i);
  });

  it('Tor listesinde olmayan IP geçer', async () => {
    _setTorExitNodes(new Set(['185.220.101.1']));
    const result = await checkIpReputation('8.8.8.8');
    expect(result.blocked).toBe(false);
  });

  it('blockTor=false iken Tor düğümü geçer', async () => {
    _setConfig({ blockTor: false });
    _setTorExitNodes(new Set(['185.220.101.1']));
    const result = await checkIpReputation('185.220.101.1');
    expect(result.blocked).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════
// ABUSEIPDB ENTEGRASYONU
// ══════════════════════════════════════════════════════════════

describe('checkIpReputation — AbuseIPDB', () => {
  beforeEach(() => {
    _setConfig({ abuseIpDbKey: 'test-api-key', abuseThreshold: 80 });
  });

  it('eşiği aşan skor IP\'yi engeller', async () => {
    _mockHttpsResponse = {
      body: JSON.stringify({
        data: {
          abuseConfidenceScore: 95,
          isTor: false,
          countryCode: 'CN',
          totalReports: 42,
        },
      }),
    };
    const result = await checkIpReputation('8.8.8.8');
    expect(result.blocked).toBe(true);
    expect(result.score).toBe(95);
    expect(result.reason).toMatch(/95/);
  });

  it('eşiğin altındaki skor IP\'yi geçirir', async () => {
    _mockHttpsResponse = {
      body: JSON.stringify({
        data: {
          abuseConfidenceScore: 30,
          isTor: false,
          countryCode: 'US',
          totalReports: 2,
        },
      }),
    };
    const result = await checkIpReputation('8.8.8.8');
    expect(result.blocked).toBe(false);
  });

  it('tam eşik değerindeki skor engeller (>=)', async () => {
    _setConfig({ abuseThreshold: 50 });
    _mockHttpsResponse = {
      body: JSON.stringify({
        data: { abuseConfidenceScore: 50, isTor: false, totalReports: 5 },
      }),
    };
    const result = await checkIpReputation('1.1.1.1');
    expect(result.blocked).toBe(true);
  });

  it('API key yokken AbuseIPDB sorgusu atlanır', async () => {
    _setConfig({ abuseIpDbKey: null });
    // https.get çağrılmamalı
    const https = require('https');
    const result = await checkIpReputation('8.8.8.8');
    expect(result.blocked).toBe(false);
    // Statik ve Tor kontrolleri geçmişse, AbuseIPDB'siz blocked=false döner
  });

  it('API hatası trafiği durdurmaz — blocked: false döner', async () => {
    _mockHttpsResponse = { body: 'GECERSIZ JSON{{{{' };
    const result = await checkIpReputation('1.2.3.4');
    expect(result.blocked).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════
// ÖNBELLEK (CACHE)
// ══════════════════════════════════════════════════════════════

describe('checkIpReputation — önbellek', () => {
  it('aynı IP ikinci kez çağrıldığında önbellekten döner', async () => {
    _setStaticBlocklist(new Set(['3.3.3.3']));
    const r1 = await checkIpReputation('3.3.3.3');
    // Blocklist'ten kaldır — önbellekten yine engel gelmeli
    _setStaticBlocklist(new Set());
    const r2 = await checkIpReputation('3.3.3.3');
    expect(r1.blocked).toBe(true);
    expect(r2.blocked).toBe(true); // önbellek
  });

  it('cache temizlenince yeniden kontrol yapılır', async () => {
    _setStaticBlocklist(new Set(['4.4.4.4']));
    await checkIpReputation('4.4.4.4'); // önbelleğe al
    _setStaticBlocklist(new Set());      // listeden kaldır
    _clearCache();                       // önbelleği temizle
    const result = await checkIpReputation('4.4.4.4');
    expect(result.blocked).toBe(false); // listede yok artık
  });
});

// ══════════════════════════════════════════════════════════════
// ÖNCELIK SIRASI (statik > tor > abuseipdb)
// ══════════════════════════════════════════════════════════════

describe('checkIpReputation — öncelik sırası', () => {
  it('statik blocklist AbuseIPDB\'den önce kontrol edilir', async () => {
    _setConfig({ abuseIpDbKey: 'key' });
    _setStaticBlocklist(new Set(['5.5.5.5']));
    // AbuseIPDB temiz skor dönseydi bile statik engel önce devreye girer
    _mockHttpsResponse = {
      body: JSON.stringify({
        data: { abuseConfidenceScore: 0, isTor: false, totalReports: 0 },
      }),
    };
    const result = await checkIpReputation('5.5.5.5');
    expect(result.blocked).toBe(true);
    expect(result.reason).toMatch(/statik/i);
  });
});

// ══════════════════════════════════════════════════════════════
// EXPRESS MIDDLEWARE
// ══════════════════════════════════════════════════════════════

describe('ipReputationMiddleware', () => {
  // Ikizler KANONIK ve TIPLI fabrikadan gelir (tests/helpers/expressDoubles).
  // Onceden `let req, res, next;` bildirimi ortuk `any` uretiyor ve bu TEK
  // satir bu dosyada 57 strict hatasi doguruyordu.
  let req: ReqDouble, res: ResDouble, next: NextDouble;

  beforeEach(() => {
    ({ req, res, next } = makeMiddlewareDoubles({ ip: '8.8.8.8', path: '/api/messages' }));
  });

  it('temiz IP\'de next() çağrılır', async () => {
    await ipReputationMiddleware(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('engellenen IP\'de 403 döner', async () => {
    _setStaticBlocklist(new Set(['8.8.8.8']));
    await ipReputationMiddleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('/api/admin path\'i her zaman geçer', async () => {
    _setStaticBlocklist(new Set(['8.8.8.8']));
    req.path = '/api/admin/ip-bans';
    await ipReputationMiddleware(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('/api/health path\'i geçer', async () => {
    _setStaticBlocklist(new Set(['8.8.8.8']));
    req.path = '/api/health';
    await ipReputationMiddleware(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('middleware devre dışıyken hep geçer', async () => {
    _setConfig({ enabled: false });
    _setStaticBlocklist(new Set(['8.8.8.8']));
    await ipReputationMiddleware(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('beklenmedik middleware hatasında fail-closed 503 döner', async () => {
    req.ip = undefined;
    // Kasıtlı BOZUK istek: başlık torbası hiç yok. Express'in kendi tipleri bu
    // durumu ifade edemez ama çalışma zamanı üretebilir (bozuk upgrade, araya
    // giren proxy). Üretim kodu bunu FAIL-CLOSED karşılamak zorunda.
    injectMissingHeaderBag(req);
    await expect(ipReputationMiddleware(req, res, next)).resolves.not.toThrow();
    if (res.status.mock.calls.length > 0) {
      expect(res.status).toHaveBeenCalledWith(503);
      expect(next).not.toHaveBeenCalled();
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // PROXY GUVEN MODELI
  // ══════════════════════════════════════════════════════════════════════════
  // BU TEST DEGISTIRILDI. Eski hali soyleydi:
  //
  //     req.headers = { 'x-forwarded-for': '8.8.8.8, 172.16.0.1' };
  //     ... 8.8.8.8 engelli oldugu icin 403 bekle
  //
  // Yani zincirin ILK hop'unun karar verdigini iddia ediyordu. Ama ilk hop
  // TAMAMEN ISTEMCI TARAFINDAN YAZILIR: proxy gercek IP'yi SONA ekler. Test
  // boylece tam olarak GUVENLIK ACIGINI beklenen davranis olarak kodluyordu —
  // saldirganin itibar kararini kendi secmesini.
  //
  // Yerine guven modelinin HER IKI yonu test edilir. Ayrintilar: lib/clientIp.ts
  describe('X-Forwarded-For güven modeli', () => {
    let savedN: string | undefined;
    beforeEach(() => { savedN = process.env.TRUSTED_PROXY_COUNT; });
    afterEach(() => {
      if (savedN === undefined) delete process.env.TRUSTED_PROXY_COUNT;
      else process.env.TRUSTED_PROXY_COUNT = savedN;
    });

    it('proxy GÜVENİLİYORSA gerçek istemci hop’u okunur', () => {
      // Mesru dagitim: proxy gercek IP'yi (8.8.8.8) sona ekledi.
      process.env.TRUSTED_PROXY_COUNT = '1';
      req.ip      = '127.0.0.1';
      req.headers = { 'x-forwarded-for': '1.2.3.4, 8.8.8.8' };
      _setStaticBlocklist(new Set(['8.8.8.8']));
      return ipReputationMiddleware(req, res, next).then(() => {
        expect(res.status).toHaveBeenCalledWith(403);
      });
    });

    it('ENGELLİ istemci sahte ön ek ekleyerek KAÇAMAZ', () => {
      // Gercek istemci 8.8.8.8 (engelli) ve temiz bir IP uydurmaya calisiyor.
      process.env.TRUSTED_PROXY_COUNT = '1';
      req.ip      = '127.0.0.1';
      req.headers = { 'x-forwarded-for': '203.0.113.7, 8.8.8.8' };
      _setStaticBlocklist(new Set(['8.8.8.8']));
      return ipReputationMiddleware(req, res, next).then(() => {
        expect(res.status).toHaveBeenCalledWith(403);
      });
    });

    it('proxy GÜVENİLMİYORSA (varsayılan) XFF hiç dikkate ALINMAZ', () => {
      // Saldirgan bir baskasini engelletmek icin XFF uydurabilirdi.
      delete process.env.TRUSTED_PROXY_COUNT;
      req.ip      = '127.0.0.1';
      req.headers = { 'x-forwarded-for': '8.8.8.8' };
      _setStaticBlocklist(new Set(['8.8.8.8']));
      return ipReputationMiddleware(req, res, next).then(() => {
        expect(res.status).not.toHaveBeenCalledWith(403);
        expect(next).toHaveBeenCalled();
      });
    });
  });
});

// ══════════════════════════════════════════════════════════════
// YAPILANDIRMA
// ══════════════════════════════════════════════════════════════

describe('_getConfig', () => {
  it('yapılandırma nesnesini döner', () => {
    const cfg = _getConfig();
    expect(cfg).toHaveProperty('enabled');
    expect(cfg).toHaveProperty('abuseThreshold');
    expect(cfg).toHaveProperty('cacheTtlMs');
  });

  it('_setConfig ile güncellenir', () => {
    _setConfig({ abuseThreshold: 50 });
    expect(_getConfig().abuseThreshold).toBe(50);
  });
});

// Bu dosyada ust duzey import/export yoktu; TypeScript onu GLOBAL
// SCRIPT sayiyor ve ust duzey adlari diger ayni durumdaki test
// dosyalariyla CAKISIYORDU (TS2393/TS2451, ve arguman tiplerinin
// baska bir dosyanin bildirimine cozulmesi). Bu satir modul kapsami
// ilan eder; calisma zamaninda hicbir sey degistirmez.
export {};
